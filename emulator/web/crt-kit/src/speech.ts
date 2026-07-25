// Joshua's voice (docs/fidelity-notes.md §5): Web Speech synthesis, pitched
// down toward the film's machine voice. The real one was post-produced by
// re-recording through speakers, so a robotic TTS is period-adjacent, not
// identical — prior art in alainfurter/woprcrt-terminal. Lines are spoken as
// they complete, so speech trails the teletype at the link's own cadence.

const PITCH = 0.3; // 0..2 — deep
const RATE = 0.9; // slightly deliberate

/** A line is "dialogue" if it is mostly letters — board art (`X | O`,
 *  separators, coordinate grids) stays silent. */
function isSpeakable(line: string): boolean {
  const letters = (line.match(/[A-Za-z]/g) ?? []).length;
  const marks = line.replace(/\s/g, "").length;
  return letters >= 3 && marks > 0 && letters / marks >= 0.5;
}

export class JoshuaVoice {
  /** Callers flip this from their VOICE toggle; speak() is a no-op while off. */
  enabled = false;

  private get synth(): SpeechSynthesis | null {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
    return window.speechSynthesis;
  }

  /** Whether this browser can speak at all. */
  get available(): boolean {
    return this.synth !== null;
  }

  /** Queue one completed teletype line. Uppercase wire text is lowered for
   *  the synthesizer so it reads words, not letter-by-letter acronyms. */
  speak(line: string): void {
    const synth = this.synth;
    if (!synth || !this.enabled) return;
    const text = line.trim();
    if (!text || !isSpeakable(text)) return;
    const u = new SpeechSynthesisUtterance(text.toLowerCase());
    u.pitch = PITCH;
    u.rate = RATE;
    const en = synth.getVoices().find((v) => v.lang.startsWith("en"));
    if (en) u.voice = en;
    synth.speak(u);
  }

  /** Stop mid-word and drop anything queued (hangup, toggle off). */
  cancel(): void {
    this.synth?.cancel();
  }
}
