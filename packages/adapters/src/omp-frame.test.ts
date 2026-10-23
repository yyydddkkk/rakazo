import { describe, expect, it } from "vitest";
import { OMP_MAX_FRAME_BYTES, OMP_MAX_REASSEMBLED_BYTES, OmpFrameDecoder } from "./omp-frame.js";

const line = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const largeFrame = { type: "message_end", message: "😀".repeat(270_000) };
function decoderV2() {
  const decoder = new OmpFrameDecoder();
  decoder.configure({ protocolVersion: 2 });
  return decoder;
}
function chunks(bytes = Buffer.from(JSON.stringify(largeFrame))) {
  const count = Math.ceil(bytes.length / (256 * 1024));
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId: "chunk-1",
    index,
    count,
    byteLength: bytes.length,
    data: bytes.subarray(index * 256 * 1024, (index + 1) * 256 * 1024).toString("base64"),
  }));
}

describe("OmpFrameDecoder", () => {
  it("preserves a partial physical frame when ready and the next frame share a read", () => {
    const decoder = new OmpFrameDecoder();
    const metadata = line({ type: "metadata", text: "😀" });
    expect(
      decoder.push(Buffer.concat([line({ type: "ready" }), metadata.subarray(0, 12)])),
    ).toEqual([{ type: "ready" }]);
    decoder.configure({ maxFrameBytes: 512, maxReassembledFrameBytes: 2048 });
    expect(decoder.push(metadata.subarray(12))).toEqual([{ type: "metadata", text: "😀" }]);
    decoder.finish();
  });

  it("preserves a partial chunk at the v2 acknowledgement boundary", () => {
    const decoder = new OmpFrameDecoder();
    const encoded = chunks().map(line);
    expect(
      decoder.push(Buffer.concat([line({ type: "response" }), encoded[0]!.subarray(0, 20)])),
    ).toEqual([{ type: "response" }]);
    decoder.configure({ protocolVersion: 2 });
    expect(decoder.push(Buffer.concat([encoded[0]!.subarray(20), ...encoded.slice(1)]))).toEqual([
      largeFrame,
    ]);
    decoder.finish();
  });

  it("rejects narrowing physical limits below an already buffered prefix", () => {
    const decoder = new OmpFrameDecoder();
    decoder.push(Buffer.from('{"type":'));
    expect(() => decoder.configure({ maxFrameBytes: 8 })).toThrow("Partial");
  });
  it("rejects chunks before v2 negotiation and respects negotiated lower ceilings", () => {
    expect(() => new OmpFrameDecoder().push(line(chunks()[0]))).toThrow();
    const physical = new OmpFrameDecoder();
    physical.configure({ maxFrameBytes: 8 });
    expect(() => physical.push(line({ type: "done" }))).toThrow();
    const logical = decoderV2();
    logical.configure({ maxReassembledFrameBytes: OMP_MAX_FRAME_BYTES });
    expect(() => logical.push(line(chunks()[0]))).toThrow();
    expect(() =>
      new OmpFrameDecoder().configure({ maxFrameBytes: OMP_MAX_FRAME_BYTES + 1 }),
    ).toThrow();
    expect(() => new OmpFrameDecoder().configure({ maxReassembledFrameBytes: NaN })).toThrow();
  });
  it("decodes split UTF-8 and multiple physical frames in one read", () => {
    const decoder = decoderV2();
    const input = Buffer.concat([line({ type: "text", text: "😀" }), line({ type: "done" })]);
    const emoji = input.indexOf(Buffer.from("😀"));
    expect(decoder.push(input.subarray(0, emoji + 2))).toEqual([]);
    expect(decoder.push(input.subarray(emoji + 2))).toEqual([
      { type: "text", text: "😀" },
      { type: "done" },
    ]);
    decoder.finish();
    expect(() => decoder.push(line({ type: "done" }))).toThrow("closed");
  });

  it("reassembles upstream v2 chunks without requiring UTF-8 boundaries in base64 payloads", () => {
    const decoder = decoderV2();
    const encoded = chunks();
    for (const frame of encoded.slice(0, -1)) expect(decoder.push(line(frame))).toEqual([]);
    expect(decoder.push(line(encoded.at(-1)))).toEqual([largeFrame]);
    decoder.finish();
  });

  it("counts the newline in the physical limit and enforces the limit before EOF", () => {
    const frame = { type: "text", text: "" };
    frame.text = "x".repeat(OMP_MAX_FRAME_BYTES - line(frame).length);
    expect(decoderV2().push(line(frame))).toEqual([frame]);
    expect(() => decoderV2().push(Buffer.alloc(OMP_MAX_FRAME_BYTES, 32))).toThrow();
    expect(() => decoderV2().push(line({ ...frame, text: `${frame.text}x` }))).toThrow();
  });

  it.each([null, [], {}, { type: 3 }])("rejects non-event JSON values: %j", (value) => {
    expect(() => decoderV2().push(line(value))).toThrow();
  });

  it("rejects invalid UTF-8 and JSON without exposing raw diagnostics", () => {
    for (const bytes of [Buffer.from([0xff, 10]), Buffer.from("fake-secret\n")]) {
      expect(() => decoderV2().push(bytes)).toThrow("Invalid omp RPC frame");
      expect(() => decoderV2().push(bytes)).not.toThrow("fake-secret");
    }
  });

  it.each([
    { chunkId: "" },
    { chunkId: "x".repeat(129) },
    { index: -1 },
    { index: 0.5 },
    { index: 10 },
    { count: 1 },
    { count: 257 },
    { count: 2.5 },
    { byteLength: OMP_MAX_FRAME_BYTES - 1 },
    { byteLength: OMP_MAX_REASSEMBLED_BYTES + 1 },
    { byteLength: 1.5 },
    { data: "" },
    { data: "YQ" },
    { data: "YR==" },
    { data: "YQ==\n" },
    { data: Buffer.alloc(256 * 1024 + 1).toString("base64") },
  ])("rejects invalid chunk metadata or base64: %j", (override) => {
    const frame = { ...chunks()[0], ...override };
    expect(() => decoderV2().push(line(frame))).toThrow();
  });

  it("rejects chunks that do not start at zero", () => {
    expect(() => decoderV2().push(line(chunks()[1]))).toThrow();
  });

  it.each([
    { chunkId: "other" },
    { count: 6 },
    { byteLength: OMP_MAX_FRAME_BYTES },
    { index: 0 },
    { index: 3 },
  ])("rejects interleaved, repeated, or mismatched chunks: %j", (override) => {
    const decoder = decoderV2();
    const encoded = chunks();
    decoder.push(line(encoded[0]));
    expect(() => decoder.push(line({ ...encoded[1], ...override }))).toThrow();
  });

  it("rejects an ordinary frame interrupting a chunk sequence", () => {
    const decoder = decoderV2();
    decoder.push(line(chunks()[0]));
    expect(() => decoder.push(line({ type: "done" }))).toThrow();
    expect(() => decoder.push(line({ type: "done" }))).toThrow("closed");
  });

  it("rejects under-declared and over-declared logical byte lengths", () => {
    for (const difference of [-1, 1]) {
      const decoder = decoderV2();
      const encoded = chunks().map((frame) => ({
        ...frame,
        byteLength: frame.byteLength + difference,
      }));
      expect(() => decoder.push(Buffer.concat(encoded.map(line)))).toThrow();
    }
  });

  it("rejects invalid UTF-8 and nested chunks after reassembly", () => {
    const invalidUtf8 = Buffer.alloc(OMP_MAX_FRAME_BYTES, 0xff);
    const nestedChunk = Buffer.from(
      JSON.stringify({ type: "rpc_chunk", data: "x".repeat(OMP_MAX_FRAME_BYTES) }),
    );
    for (const bytes of [invalidUtf8, nestedChunk]) {
      expect(() => decoderV2().push(Buffer.concat(chunks(bytes).map(line)))).toThrow();
    }
  });

  it("rejects EOF inside either a physical line or logical chunk sequence", () => {
    const partial = decoderV2();
    partial.push(Buffer.from('{"type":"done"}'));
    expect(() => partial.finish()).toThrow("incomplete");
    const chunked = decoderV2();
    chunked.push(line(chunks()[0]));
    expect(() => chunked.finish()).toThrow("incomplete");
  });
});
