"use client";
// <CRTScreen> — phosphor theme, scanlines, curvature vignette, glow, optional
// flicker. Wraps every surface (docs/surfaces.md, "Shared foundation").

import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";

export type CRTTheme = "green" | "amber";

export interface CRTScreenProps {
  theme?: CRTTheme;
  flicker?: boolean;
  /**
   * Fix the content to a minimum column count (period-authentic 80-col
   * terminals never reflowed). When set, text does not wrap and the viewport
   * scrolls horizontally on screens narrower than `columns` — so wide output
   * (e.g. the GTW strategic map) stays intact on mobile. Omit for graphics
   * surfaces (Big Board, panel), which keep the fluid wrapping default.
   */
  columns?: number;
  children?: ReactNode;
}

const PHOSPHOR: Record<CRTTheme, { fg: string; dim: string; bg: string }> = {
  green: { fg: "#33ff66", dim: "#1a8038", bg: "#020a04" },
  amber: { fg: "#ffb000", dim: "#805800", bg: "#0a0602" },
};

const css = `
.crt-root {
  position: relative;
  width: 100%;
  height: 100vh;
  min-height: 100vh;
  background: var(--crt-bg);
  color: var(--crt-fg);
  font-family: "VT323", "IBM Plex Mono", ui-monospace, "Menlo", "Courier New", monospace;
  font-size: 1.25rem;
  line-height: 1.35;
  overflow: hidden;
  cursor: default;
}
.crt-inner {
  position: relative;
  height: 100vh;
  min-height: 0;
  overflow-y: auto;
  overflow-x: auto;
  padding: 2.5rem 3rem;
  box-sizing: border-box;
  text-shadow: 0 0 6px var(--crt-fg), 0 0 18px color-mix(in srgb, var(--crt-fg) 35%, transparent);
  z-index: 1;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: none;
}
.crt-inner::-webkit-scrollbar { display: none; }
/* Fixed-column mode: an 80-col terminal never reflows — text holds its width
   and the viewport scrolls sideways on narrow screens instead of wrapping. */
.crt-cols {
  min-width: var(--crt-cols);
  white-space: pre;
  word-break: normal;
}
.crt-root::before {
  /* scanlines */
  content: "";
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0) 0px,
    rgba(0, 0, 0, 0) 2px,
    rgba(0, 0, 0, 0.28) 3px,
    rgba(0, 0, 0, 0) 4px
  );
  pointer-events: none;
  z-index: 2;
}
.crt-root::after {
  /* curvature vignette + subtle center bloom */
  content: "";
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse at center,
      rgba(255, 255, 255, 0.04) 0%,
      rgba(0, 0, 0, 0) 55%,
      rgba(0, 0, 0, 0.55) 100%);
  pointer-events: none;
  z-index: 3;
}
.crt-flicker .crt-inner { animation: crt-flicker 4s infinite; }
@keyframes crt-flicker {
  0%, 100% { opacity: 1; }
  97% { opacity: 1; }
  97.5% { opacity: 0.86; }
  98% { opacity: 1; }
}
.crt-cursor {
  display: inline-block;
  width: 0.6em;
  height: 1em;
  vertical-align: text-bottom;
  background: var(--crt-fg);
  animation: crt-blink 1s steps(1) infinite;
}
@keyframes crt-blink { 50% { opacity: 0; } }
`;

export function scrollToTerminalBottom(
  viewport: Pick<HTMLDivElement, "scrollHeight" | "scrollTop">,
  previousScrollHeight: number,
): number {
  const nextScrollHeight = viewport.scrollHeight;
  if (nextScrollHeight !== previousScrollHeight) {
    viewport.scrollTop = nextScrollHeight;
  }
  return nextScrollHeight;
}

export function CRTScreen({ theme = "green", flicker = true, columns, children }: CRTScreenProps) {
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollHeightRef = useRef(-1);
  const c = PHOSPHOR[theme];
  const vars = {
    "--crt-fg": c.fg,
    "--crt-dim": c.dim,
    "--crt-bg": c.bg,
  } as CSSProperties;

  useLayoutEffect(() => {
    if (!innerRef.current) return;
    scrollHeightRef.current = scrollToTerminalBottom(
      innerRef.current,
      scrollHeightRef.current,
    );
  });

  return (
    <div className={`crt-root${flicker ? " crt-flicker" : ""}`} style={vars}>
      <style>{css}</style>
      <div ref={innerRef} className="crt-inner">
        {columns
          ? <div className="crt-cols" style={{ "--crt-cols": `${columns}ch` } as CSSProperties}>{children}</div>
          : children}
      </div>
    </div>
  );
}
