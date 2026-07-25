// Modem audio for the dial-up ritual (docs/comms-protocol.md §4): DTMF-ish
// dial tones, ring-back, answer tone, and the handshake screech — synthesized
// with WebAudio, no assets. Created on user gesture (the DIAL click), so
// autoplay policies are satisfied.

export class ModemAudio {
  private ctx: AudioContext | null = null;

  private ensure(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  private tone(freqs: number[], start: number, dur: number, gain = 0.06): void {
    const ctx = this.ensure();
    const g = ctx.createGain();
    g.gain.value = gain;
    g.connect(ctx.destination);
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(g);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + dur);
    }
  }

  /** Rapid DTMF-style digit chirps. */
  dialing(): void {
    const pairs = [
      [697, 1209], [770, 1336], [852, 1477], [697, 1336],
      [941, 1336], [770, 1209], [852, 1336],
    ];
    pairs.forEach((p, i) => this.tone(p, i * 0.18, 0.12));
  }

  /** US ring-back: 440+480 Hz. */
  ringing(): void {
    this.tone([440, 480], 0, 1.4, 0.05);
  }

  /** Answer tone: 2100 Hz carrier. */
  carrier(): void {
    this.tone([2100], 0, 0.8, 0.05);
  }

  /** The iconic screech: filtered noise + shifting carriers. */
  screech(): void {
    const ctx = this.ensure();
    const dur = 1.8;
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 1234567;
    for (let i = 0; i < data.length; i++) {
      // deterministic LCG noise — no Math.random needed
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.value = 0.045;
    noise.connect(bp).connect(g).connect(ctx.destination);
    noise.start();
    this.tone([1270], 0.1, 0.5, 0.04);
    this.tone([2225, 1070], 0.7, 0.9, 0.035);
  }

  /** Map an FSM state payload to its sound. */
  play(state: string): void {
    if (state.startsWith("DIALING")) this.dialing();
    else if (state.startsWith("RINGING")) this.ringing();
    else if (state.startsWith("CARRIER_DETECT")) this.carrier();
    else if (state.startsWith("HANDSHAKE")) this.screech();
  }

  close(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
