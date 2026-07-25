"use client";
// <Teletype> — renders incoming text AS IT ARRIVES from the link, not on a
// fixed timer, so the cadence reflects the actual baud profile
// (docs/surfaces.md). The parent appends each received frame's payload to
// `text`; this component only displays it. The CRT viewport owns autoscroll.
// Blinking block cursor.

export interface TeletypeProps {
  text: string;
  cursor?: boolean;
}

export function Teletype({ text, cursor = true }: TeletypeProps) {
  return (
    <div aria-live="polite">
      {text}
      {cursor && <span aria-hidden="true" className="crt-cursor" />}
    </div>
  );
}
