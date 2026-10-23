/** Single-consumer queue for process bytes and translated runtime events. */
export class OmpRpcQueue<T> {
  private items: T[] = [];
  private wake?: () => void;
  private closed = false;
  private failure?: Error;

  push(item: T) {
    if (this.closed) return;
    this.items.push(item);
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
        yield this.items.shift()!;
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
