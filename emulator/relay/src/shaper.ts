// The constraint shaper for one direction of one link (docs/comms-protocol.md §3).
// Applies framing (fixed-width chunks), baud throttling (token bucket), and
// latency ± jitter to every envelope passed through it. It never inspects the
// payload. In `fast` mode the caller resolves the profile to `off`, which
// delivers immediately but STILL applies framing and envelopes, so behavior
// (not timing) is identical (§6).

import { TokenBucket } from "./bucket.ts";
import { chunkPayload, byteLength, type Envelope, type FrameKind } from "./envelope.ts";
import type { LinkProfile } from "./config.ts";

export interface ShaperOpts {
  rng?: () => number;
  now?: () => number;
}

export interface OutboundMessage {
  kind: FrameKind;
  payload: string;
  /** Marks the end of the application message; defaults to true. */
  eom?: boolean;
}

export class LinkShaper {
  private readonly profile: LinkProfile;
  private readonly linkName: string;
  private readonly session: string;
  private readonly deliver: (e: Envelope) => void;
  private readonly bucket: TokenBucket;
  private readonly rng: () => number;
  private readonly now: () => number;
  private queue: OutboundMessage[] = [];
  private pumping = false;
  private closed = false;
  private seq = 0;
  private lastDeliverAt = 0;
  private outbox: Array<{ at: number; frame: Envelope }> = [];
  private outboxTimer: ReturnType<typeof setTimeout> | null = null;
  private drainWaiters: Array<() => void> = [];

  constructor(
    profile: LinkProfile,
    linkName: string,
    session: string,
    deliver: (e: Envelope) => void,
    opts: ShaperOpts = {},
  ) {
    this.profile = profile;
    this.linkName = linkName;
    this.session = session;
    this.deliver = deliver;
    const rate = profile.baud > 0 ? profile.baud / profile.bits_per_char : 0;
    this.now = opts.now ?? (() => performance.now());
    // Capacity = ONE emission quantum, not one second: a serial line has no
    // credit — it never bursts after idle, it just runs at line rate. (This
    // deliberately tightens §3.1's bucket to match the physics the spec's
    // "visible-typing cadence" promise actually requires.)
    this.bucket = new TokenBucket(rate, this.quantumBytesFor(rate), this.now);
    this.rng = opts.rng ?? Math.random;
  }

  private quantumBytesFor(rate: number): number {
    if (rate <= 0) return this.profile.frame_bytes;
    return Math.max(1, Math.min(this.profile.frame_bytes, Math.floor(rate / 15)));
  }

  /** Enqueue one application message; it will be framed, timed, and delivered. */
  send(msg: OutboundMessage): void {
    if (this.closed) return;
    this.queue.push(msg);
    void this.pump();
  }

  /** Deliver one complete envelope RIGHT NOW, bypassing baud pacing and the
   *  latency/jitter outbox. A modem's carrier-drop (NO CARRIER) is a line-state
   *  transition, not paced serial data — so the terminal control frame must
   *  reach the surface even though close() is about to discard everything still
   *  queued (issue #88). Still routes through the shaper's own seq counter and
   *  the shared deliver/encode path, so per-direction sequence stays monotonic
   *  (§5) and no frame is ever hand-built outside the codec. Intended only for
   *  the short terminal control frame issued immediately before teardown. */
  sendImmediate(msg: OutboundMessage): void {
    if (this.closed) return;
    const frame: Envelope = {
      v: 1,
      session: this.session,
      seq: this.seq++,
      kind: msg.kind,
      link: this.linkName,
      payload: msg.payload,
      eom: msg.eom ?? true,
    };
    this.deliver(frame);
  }

  /** Resolves once everything already enqueued has left the shaper: the paced
   *  queue is empty, the pump is idle, and the latency outbox has flushed. A
   *  closed shaper resolves at once — close() discards, it does not deliver.
   *  Anything sent while a drain is pending is part of that drain.
   *
   *  This is what lets a caller play the line out before dropping carrier
   *  instead of closing over the top of it (issue #62). `timeoutMs` bounds the
   *  wait: it resolves on the deadline whatever is left, because a queue that
   *  needs minutes at line rate must not hold a socket open for them. The
   *  deadline is the caller's to set — how long a drop may wait is a policy
   *  about that link, not about shaping — and a drain with no deadline waits
   *  for the line however long it takes. */
  drain(timeoutMs?: number): Promise<void> {
    if (this.idle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      // Self-removing, so a drain released by its deadline leaves nothing
      // behind for a later settle to call.
      const waiter = () => {
        if (timer !== null) clearTimeout(timer);
        const i = this.drainWaiters.indexOf(waiter);
        if (i >= 0) this.drainWaiters.splice(i, 1);
        resolve();
      };
      this.drainWaiters.push(waiter);
      if (timeoutMs !== undefined) timer = setTimeout(waiter, timeoutMs);
    });
  }

  private idle(): boolean {
    return this.closed
      || (this.queue.length === 0 && !this.pumping && this.outbox.length === 0);
  }

  private settleDrain(): void {
    if (!this.idle()) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }

  /** Emission quantum: ~1/15 s of line rate per envelope, so the surface sees
   *  character-level trickle at 300 baud instead of 64-byte bursts. Uncapped
   *  links emit whole frames. */
  private quantumBytes(): number {
    const rate = this.profile.baud > 0 ? this.profile.baud / this.profile.bits_per_char : 0;
    return this.quantumBytesFor(rate);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const msg = this.queue.shift()!;
        const chunks = chunkPayload(msg.payload, this.profile.frame_bytes);
        const eom = msg.eom ?? true;
        for (let i = 0; i < chunks.length; i++) {
          const quanta = chunkPayload(chunks[i], this.quantumBytes());
          for (let q = 0; q < quanta.length; q++) {
            await this.bucket.take(byteLength(quanta[q]));
            if (this.closed) return;
            const last = i === chunks.length - 1 && q === quanta.length - 1;
            const frame: Envelope = {
              v: 1,
              session: this.session,
              seq: this.seq++,
              kind: msg.kind,
              link: this.linkName,
              payload: quanta[q],
              eom: last ? eom : false,
            };
            this.schedule(frame);
          }
        }
      }
    } finally {
      this.pumping = false;
      this.settleDrain();
    }
  }

  /** Latency ± jitter, applied once per frame — clamped so frames never
   *  reorder (a period serial line does not reorder bytes). Delivery runs
   *  through a single FIFO outbox with one timer chain: independent timers
   *  cannot guarantee ordering under rounding drift, a queue can. */
  private schedule(frame: Envelope): void {
    const jitter = this.profile.jitter_ms * (2 * this.rng() - 1);
    const delay = Math.max(0, this.profile.latency_ms + jitter);
    const at = Math.max(this.now() + delay, this.lastDeliverAt);
    this.lastDeliverAt = at;
    this.outbox.push({ at, frame });
    this.drainOutbox();
  }

  private drainOutbox(): void {
    if (this.closed || this.outboxTimer !== null) return;
    while (this.outbox.length > 0 && this.outbox[0].at <= this.now()) {
      this.deliver(this.outbox.shift()!.frame);
    }
    if (this.outbox.length > 0) {
      const wait = Math.max(1, this.outbox[0].at - this.now());
      this.outboxTimer = setTimeout(() => {
        this.outboxTimer = null;
        if (!this.closed) this.drainOutbox();
      }, wait);
    } else {
      this.settleDrain();
    }
  }

  close(): void {
    this.closed = true;
    this.queue = [];
    this.outbox = [];
    if (this.outboxTimer !== null) clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
    this.settleDrain();
  }
}
