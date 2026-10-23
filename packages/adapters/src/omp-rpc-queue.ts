/** Single-consumer queue for process bytes and translated runtime events. */
export class OmpRpcQueue<T> {
  private items: Array<{ value: T; bytes: number }> = [];
  private bytes = 0;
  private wake?: () => void;
  private closed = false;
  private failure?: Error;

  constructor(private capacity?: { items: number; bytes: number; size: (item: T) => number }) {}

  push(item: T) {
    if (this.closed) return;
    const bytes = this.capacity?.size(item) ?? 0;
    if (
      this.capacity &&
      (this.items.length >= this.capacity.items || this.bytes + bytes > this.capacity.bytes)
    ) {
      const error = new Error("omp event buffer limit exceeded");
      this.close(error);
      throw error;
    }
    this.items.push({ value: item, bytes });
    this.bytes += bytes;
    this.wake?.();
  }

  close(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.wake?.();
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.items.length) {
        const item = this.items.shift()!;
        this.bytes -= item.bytes;
        yield item.value;
      } else if (this.failure) {
        throw this.failure;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    }
  }
}
