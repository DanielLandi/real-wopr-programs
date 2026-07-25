// Pure helpers for the operator logon flow (spec 2026-07-20). The strings
// matched here are wire contract (docs/api-contract.md §4): the ACCESS CODE
// prompt and the CLEARANCE ACCEPTED banner — surfaces share only the contract.

export const ACCESS_CODE_PROMPT = "ACCESS CODE:";

const BANNER = /^CLEARANCE ACCEPTED - (\S+) LEVEL ([1-5])$/gm;

export function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t !== "") return t;
  }
  return "";
}

/** True while the machine is waiting for the operator's access code — the
 *  page masks the CommandLine and suppresses the local echo. */
export function awaitingAccessCode(text: string): boolean {
  return lastNonEmptyLine(text) === ACCESS_CODE_PROMPT;
}

export interface Clearance {
  callsign: string;
  level: number;
}

/** The most recent CLEARANCE ACCEPTED banner in the transcript (re-logon
 *  under a different callsign supersedes), or null before any logon. */
export function clearanceFromText(text: string): Clearance | null {
  let last: Clearance | null = null;
  for (const m of text.matchAll(BANNER)) {
    last = { callsign: m[1], level: Number(m[2]) };
  }
  return last;
}

/** The WALL handoff target: screen-wall base + this console's room, if any. */
export function wallUrl(base: string, room?: string): string {
  return room ? `${base}?room=${room}` : base;
}
