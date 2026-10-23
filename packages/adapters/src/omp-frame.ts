/** OMP RPC framing limits, pinned to the upstream v2 wire protocol. */
export const OMP_MAX_FRAME_BYTES = 1024 * 1024;
export const OMP_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

export type OmpRpcFrame = Record<string, unknown> & { type: string };

interface PendingChunks {
  id: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  received: number;
  buffers: Buffer[];
}

/** Decode bytes before JSON parsing so both physical and logical allocations are bounded. */
export class OmpFrameDecoder {
  private lineBuffer?: Buffer;
  private lineBytes = 0;
  private pending?: PendingChunks;
  private ended = false;
  private failed = false;
  private protocolVersion: 1 | 2 = 1;
  private maxFrameBytes = OMP_MAX_FRAME_BYTES;
  private maxReassembledFrameBytes = OMP_MAX_REASSEMBLED_BYTES;

  configure(options: {
    protocolVersion?: 1 | 2;
    maxFrameBytes?: number;
    maxReassembledFrameBytes?: number;
  }): void {
    if (this.pending || this.failed || this.ended) {
      throw new Error("omp RPC decoder cannot change an active frame");
    }
    const physical = options.maxFrameBytes ?? this.maxFrameBytes;
    const logical = options.maxReassembledFrameBytes ?? this.maxReassembledFrameBytes;
    if (
      !Number.isSafeInteger(physical) ||
      physical < 1 ||
      physical > OMP_MAX_FRAME_BYTES ||
      !Number.isSafeInteger(logical) ||
      logical < 1 ||
      logical > OMP_MAX_REASSEMBLED_BYTES ||
      (options.protocolVersion !== undefined &&
        options.protocolVersion !== 1 &&
        options.protocolVersion !== 2)
    )
      throw new Error("Invalid omp RPC framing configuration");
    if (this.lineBytes + 1 > physical)
      throw new Error("Partial omp RPC frame exceeds negotiated limit");
    if (this.lineBytes) {
      const resized = Buffer.allocUnsafe(physical - 1);
      this.lineBuffer!.copy(resized, 0, 0, this.lineBytes);
      this.lineBuffer = resized;
    } else this.lineBuffer = undefined;
    this.protocolVersion = options.protocolVersion ?? this.protocolVersion;
    this.maxFrameBytes = physical;
    this.maxReassembledFrameBytes = logical;
  }

  push(bytes: Uint8Array): OmpRpcFrame[] {
    if (this.ended || this.failed) throw new Error("omp RPC decoder is closed");
    try {
      const frames: OmpRpcFrame[] = [];
      const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let start = 0;
      while (start < input.length) {
        const newline = input.indexOf(10, start);
        const end = newline < 0 ? input.length : newline;
        const part = input.subarray(start, end);
        const previousLength = this.lineBytes;
        this.lineBytes += part.length;
        // The newline counts toward the physical ceiling, even before it arrives.
        if (this.lineBytes + 1 > this.maxFrameBytes) {
          throw new Error("omp RPC physical frame exceeds the transport limit");
        }
        if (part.length) {
          this.lineBuffer ??= Buffer.allocUnsafe(this.maxFrameBytes - 1);
          part.copy(this.lineBuffer, previousLength);
        }
        if (newline < 0) break;
        const line = this.lineBuffer?.subarray(0, this.lineBytes) ?? Buffer.alloc(0);
        this.lineBytes = 0;
        const frame = this.decodeLine(line);
        if (frame) frames.push(frame);
        start = newline + 1;
      }
      return frames;
    } catch {
      this.failed = true;
      this.lineBuffer = undefined;
      this.pending = undefined;
      // Never embed incoming bytes or parser diagnostics, which can contain credentials.
      throw new Error("Invalid omp RPC frame or chunk sequence");
    }
  }

  finish(): void {
    if (this.failed) throw new Error("omp RPC decoder is closed");
    if (this.ended) return;
    this.ended = true;
    this.lineBuffer = undefined;
    if (this.lineBytes || this.pending) {
      this.lineBuffer = undefined;
      this.pending = undefined;
      throw new Error("omp RPC stream ended with an incomplete frame or chunk sequence");
    }
  }

  private parse(bytes: Buffer): OmpRpcFrame {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>).type !== "string"
    ) {
      throw new Error("Invalid omp RPC frame");
    }
    return value as OmpRpcFrame;
  }

  private decodeLine(line: Buffer): OmpRpcFrame | undefined {
    const frame = this.parse(line);
    if (frame.type !== "rpc_chunk") {
      if (this.pending) throw new Error("Interrupted omp RPC chunk sequence");
      return frame;
    }
    if (this.protocolVersion !== 2) throw new Error("omp RPC chunks require protocol v2");
    const { chunkId, index, count, byteLength, data } = frame;
    if (
      typeof chunkId !== "string" ||
      !chunkId.length ||
      chunkId.length > 128 ||
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      index < 0 ||
      count < 2 ||
      count > Math.ceil(OMP_MAX_REASSEMBLED_BYTES / CHUNK_BYTES) ||
      index >= count ||
      byteLength < OMP_MAX_FRAME_BYTES ||
      byteLength > this.maxReassembledFrameBytes ||
      typeof data !== "string" ||
      !data.length ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    ) {
      throw new Error("Invalid omp RPC chunk metadata");
    }
    const payload = Buffer.from(data, "base64");
    if (payload.length > CHUNK_BYTES || payload.toString("base64") !== data) {
      throw new Error("Invalid omp RPC chunk payload");
    }
    if (!this.pending) {
      if (index !== 0) throw new Error("Invalid omp RPC first chunk");
      this.pending = { id: chunkId, count, byteLength, nextIndex: 0, received: 0, buffers: [] };
    }
    const pending = this.pending;
    if (
      chunkId !== pending.id ||
      index !== pending.nextIndex ||
      count !== pending.count ||
      byteLength !== pending.byteLength
    ) {
      throw new Error("Mismatched omp RPC chunk sequence");
    }
    pending.received += payload.length;
    if (pending.received > byteLength) throw new Error("Oversized omp RPC chunk sequence");
    pending.buffers.push(payload);
    pending.nextIndex++;
    if (pending.nextIndex < count) return undefined;
    if (pending.received !== byteLength) throw new Error("Truncated omp RPC chunk sequence");
    this.pending = undefined;
    const decoded = this.parse(Buffer.concat(pending.buffers, byteLength));
    if (decoded.type === "rpc_chunk") throw new Error("Nested omp RPC chunks are invalid");
    return decoded;
  }
}
