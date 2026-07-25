// Token-bucket baud throttle (docs/comms-protocol.md §3.1).
// Bucket capacity = one second of characters; refill rate = chars/second =
// baud / bits_per_char. When the bucket empties, output pauses until refill —
// producing the sequential, visible-typing cadence at the surface.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TokenBucket {
  private readonly ratePerSec: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private tokens: number;
  private last: number;

  /**
   * @param ratePerSec characters released per second; <= 0 means uncapped.
   * @param capacity  burst size in characters (default: one second's worth).
   */
  constructor(
    ratePerSec: number,
    capacity: number = Math.max(1, ratePerSec),
    now: () => number = () => performance.now(),
  ) {
    this.ratePerSec = ratePerSec;
    this.capacity = capacity;
    this.now = now;
    // Start EMPTY: a real line never bursts — the first character is earned
    // like every other one (the visible-typing cadence of §3.1).
    this.tokens = 0;
    this.last = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    this.last = t;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSec);
  }

  /** Wait until `n` tokens are available, then consume them. */
  async take(n: number): Promise<void> {
    if (this.ratePerSec <= 0) return; // uncapped link
    // A frame larger than the bucket is allowed to overdraw (tokens go
    // negative), which correctly delays the *next* frame.
    this.refill();
    if (this.tokens < n) {
      const deficit = n - this.tokens;
      await sleep((deficit / this.ratePerSec) * 1000);
      this.refill();
    }
    this.tokens -= n;
  }
}
