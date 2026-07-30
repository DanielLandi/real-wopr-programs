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
  /**
   * The child manages its own scrolling and fills the frame — the terminal
   * surfaces, where xterm owns the viewport and the scrollback. Without this
   * the CRT's own scroller and xterm's would fight over the same content.
   */
  fill?: boolean;
  children?: ReactNode;
}

export const PHOSPHOR: Record<CRTTheme, { fg: string; dim: string; bg: string }> = {
  green: { fg: "#33ff66", dim: "#1a8038", bg: "#020a04" },
  amber: { fg: "#ffb000", dim: "#805800", bg: "#0a0602" },
};

/** The CRT typeface, in the one place both the DOM chrome and the terminal
 *  read it from — xterm needs it as a string, not as inherited CSS. */
export const CRT_FONT_FAMILY =
  '"VT323", "IBM Plex Mono", ui-monospace, "Menlo", "Courier New", monospace';
export const CRT_FONT_SIZE = 20;
export const CRT_LINE_HEIGHT = 1.35;

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
/* Terminal mode: xterm fills the frame and owns the scrollback, so the CRT's
   own scroller steps aside. xterm 5's default renderer is DOM, not canvas, so
   the phosphor glow above reaches the characters as ordinary inherited
   text-shadow and the scanline/vignette layers sit over them untouched. */
.crt-fill {
  /* The terminal is a fixed 80 columns and never reflows, so a narrow window
     scrolls sideways past it, exactly as the DOM renderer did. Vertically it
     does not scroll at all: xterm owns the scrollback. A column so that fixed
     chrome above the screen (the NORAD status panel) takes its own height and
     the terminal gets the rest — it has to be told how many rows it has, and
     a wrong answer clips the line being typed. */
  overflow-x: auto;
  overflow-y: hidden;
  display: flex;
  flex-direction: column;
}
.crt-term {
  flex: 1;
  min-height: 0;
}
.crt-term .xterm,
.crt-term .xterm-screen {
  height: 100%;
}
.crt-term .xterm-viewport {
  background-color: transparent !important;
  scrollbar-width: none;
}
.crt-term .xterm-viewport::-webkit-scrollbar { display: none; }
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

export function CRTScreen({ theme = "green", flicker = true, columns, fill, children }: CRTScreenProps) {
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollHeightRef = useRef(-1);
  const c = PHOSPHOR[theme];
  const vars = {
    "--crt-fg": c.fg,
    "--crt-dim": c.dim,
    "--crt-bg": c.bg,
  } as CSSProperties;

  useLayoutEffect(() => {
    // In fill mode the child scrolls itself; reaching in would fight it.
    if (!innerRef.current || fill) return;
    scrollHeightRef.current = scrollToTerminalBottom(
      innerRef.current,
      scrollHeightRef.current,
    );
  });

  return (
    <div className={`crt-root${flicker ? " crt-flicker" : ""}`} style={vars}>
      <style>{css}</style>
      <div ref={innerRef} className={`crt-inner${fill ? " crt-fill" : ""}`}>
        {columns
          ? <div className="crt-cols" style={{ "--crt-cols": `${columns}ch` } as CSSProperties}>{children}</div>
          : children}
      </div>
    </div>
  );
}
