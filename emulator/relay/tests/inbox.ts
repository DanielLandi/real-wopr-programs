// A test-side inbox: everything an event source ever emitted, kept from the
// moment the listener is attached, plus waits that resolve the instant the
// item they want has arrived.
//
// This is the reading model that fixed the wire-reading flakes in
// server.test.ts (#82/#113, PR #120): arm the observer BEFORE the thing that
// will emit exists, and BUFFER what it emits rather than taking events one
// `once` listener — or one sleep — at a time. Two events that land in one
// I/O turn are emitted back to back, synchronously, and the second fires
// into nobody if the first is all anyone was listening for; a sleep is a
// bet on the scheduler that a loaded parallel run loses (#114).
//
// Nothing here times out. A wait that never resolves hangs the test, which
// is the failure a missing event should be — visible and attributable —
// rather than a false pass or a retry.

export class Inbox<T> {
  /** Everything received so far, in arrival order. Never trimmed: an
   *  assertion on "exactly these, and nothing else" needs the whole list. */
  readonly all: T[] = [];
  private wake: Array<() => void> = [];

  push(item: T): void {
    this.all.push(item);
    for (const w of this.wake.splice(0)) w();
  }

  /** Resolves with the `i`-th item (0-based) once it has arrived. */
  async nth(i: number): Promise<T> {
    await this.count(i + 1);
    return this.all[i];
  }

  /** Resolves once at least `n` items have arrived, with the whole list. A
   *  test that then asserts on the list's exact contents is asserting that
   *  nothing beyond the `n`-th was in flight AHEAD of it — true whenever the
   *  `n`-th item is the last one the source was ever handed. */
  async count(n: number): Promise<readonly T[]> {
    while (this.all.length < n) {
      await new Promise<void>((r) => this.wake.push(r));
    }
    return this.all;
  }
}
