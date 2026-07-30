"use client";
// <TerminalScreen> — the CRT with a real terminal inside it (#108 §4).
//
// The two terminal surfaces used to render their scrollback as a growing DOM
// string and capture input in an <input>. They now share one xterm.js
// terminal driven by @real-wopr/terminal's renderer, and what is left here is
// the browser-only half that renderer deliberately does not have: loading
// xterm at runtime, sizing it to the CRT, and taking it down again.
//
// The CRT look stays CSS. xterm's theme API supplies only the phosphor colour
// and the typeface; scanlines, vignette and glow layer over it exactly as they
// layered over the DOM renderer, because xterm 5 draws with DOM nodes by
// default and the glow reaches them as ordinary inherited text-shadow.

import { useEffect, useRef, type ReactNode } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  CRTScreen,
  CRT_FONT_FAMILY,
  CRT_FONT_SIZE,
  CRT_LINE_HEIGHT,
  PHOSPHOR,
  type CRTTheme,
} from "./CRTScreen";
import {
  mountXterm,
  type TerminalLike,
  type XtermMount,
} from "@real-wopr/terminal/render-xterm";

export type { XtermMount };

/** Period-authentic and non-negotiable: an 80-column terminal never reflowed.
 *  Only the row count follows the window; the CRT scrolls sideways on a screen
 *  narrower than 80 columns, exactly as the DOM renderer did. */
const COLUMNS = 80;
const MIN_ROWS = 10;
/** Only a starting guess — a row is as tall as the font makes it, and the
 *  fallback faces in the CRT stack are not the same height as the first
 *  choice. Believing this number instead of measuring the rendered row put 44
 *  rows in a box that fits 37, and clipped the line being typed. */
const CELL_HEIGHT_GUESS = Math.ceil(CRT_FONT_SIZE * CRT_LINE_HEIGHT);

/** The height of a rendered row, read back off the terminal xterm just drew. */
function measureCellHeight(host: HTMLElement): number {
  const rendered = host.querySelector(".xterm-rows")?.firstElementChild;
  const height = rendered?.getBoundingClientRect().height ?? 0;
  return height > 0 ? height : CELL_HEIGHT_GUESS;
}

export interface TerminalScreenProps {
  theme?: CRTTheme;
  flicker?: boolean;
  /** The resting prompt, before the far end sends one of its own. */
  prompt?: string;
  /** Caps-only period terminal: echo and deliver every line uppercased. */
  uppercase?: boolean;
  onLine: (line: string) => void;
  /** Ctrl+C — the period BREAK interrupt. */
  onBreak?: () => void;
  /**
   * While false there is no command line on screen and keystrokes go nowhere
   * — the NORAD console before its leased line comes up. Defaults to true.
   */
  enabled?: boolean;
  /** Echo asterisks instead of characters: operator access codes. */
  mask?: boolean;
  /**
   * Handed the live mount once the terminal is on screen, and null when it
   * goes away. The page keeps it in a ref and feeds its frame handler's sinks
   * through it; the terminal exists only in the browser, so there is no mount
   * to hand over during the static export's prerender.
   */
  onMount: (mount: XtermMount | null) => void;
  /** Absolutely-positioned chrome over the screen (badges, status panel). */
  children?: ReactNode;
}

export function TerminalScreen(props: TerminalScreenProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<XtermMount | null>(null);
  // The effect runs once per mount; callbacks are read through this so a
  // re-render with fresh closures does not tear the terminal down.
  const latest = useRef(props);
  latest.current = props;

  // The terminal arrives asynchronously, so these are applied both here and at
  // mount time — whichever happens second is the one that takes.
  useEffect(() => {
    mountRef.current?.setEnabled(props.enabled ?? true);
  }, [props.enabled]);
  useEffect(() => {
    mountRef.current?.setMask(props.mask ?? false);
  }, [props.mask]);

  useEffect(() => {
    let gone = false;
    let dispose = () => {};

    void (async () => {
      // xterm touches `window` while it loads, and these surfaces static-
      // export, so it cannot be a static import.
      const { Terminal } = await import("@xterm/xterm");
      // A row measured before the CRT typeface arrives is the fallback face's
      // height, and every row count derived from it is wrong.
      await document.fonts?.ready;
      const host = hostRef.current;
      if (gone || !host) return;

      const phosphor = PHOSPHOR[latest.current.theme ?? "green"];
      const rowsForHost = (cell: number) =>
        Math.max(MIN_ROWS, Math.floor(host.clientHeight / cell));

      const term = new Terminal({
        cols: COLUMNS,
        rows: rowsForHost(CELL_HEIGHT_GUESS),
        fontFamily: CRT_FONT_FAMILY,
        fontSize: CRT_FONT_SIZE,
        lineHeight: CRT_LINE_HEIGHT,
        cursorBlink: true,
        cursorStyle: "block",
        // Let the CRT's phosphor background and its vignette show through.
        allowTransparency: true,
        theme: {
          background: "rgba(0, 0, 0, 0)",
          foreground: phosphor.fg,
          cursor: phosphor.fg,
          cursorAccent: phosphor.bg,
          selectionBackground: phosphor.dim,
        },
        scrollback: 5000,
      });
      term.open(host);
      // Now that there are rows on screen, size to the height one actually
      // turned out to be. The guess above is a placeholder for exactly this
      // moment: at 20px/1.35 it says 27 and the rendered row is 32, which is
      // seven rows of overflow — enough to push the line being typed off the
      // bottom of the CRT.
      const fit = () => term.resize(COLUMNS, rowsForHost(measureCellHeight(host)));
      fit();
      term.focus();

      const mount = mountXterm({
        term: term as unknown as TerminalLike,
        prompt: latest.current.prompt,
        uppercase: latest.current.uppercase,
        onLine: (line) => latest.current.onLine(line),
        onBreak: () => latest.current.onBreak?.(),
      });
      mountRef.current = mount;
      mount.setMask(latest.current.mask ?? false);
      mount.setEnabled(latest.current.enabled ?? true);
      latest.current.onMount(mount);

      // Only the rows follow the window — the columns are fixed at 80.
      window.addEventListener("resize", fit);

      dispose = () => {
        window.removeEventListener("resize", fit);
        mount.dispose();
        mountRef.current = null;
        latest.current.onMount(null);
        term.dispose();
      };
      if (gone) dispose();
    })();

    return () => {
      gone = true;
      dispose();
    };
  }, []);

  return (
    // No `columns` here: xterm is fixed at 80 columns itself, and the
    // fixed-column wrapper CRTScreen would add is content-height, which would
    // leave the terminal measuring its parent as zero rows tall.
    <CRTScreen theme={props.theme} flicker={props.flicker} fill>
      {props.children}
      {/* Keyboard-only surfaces: a click anywhere puts the caret back. */}
      <div
        ref={hostRef}
        className="crt-term"
        onClick={() => hostRef.current?.querySelector("textarea")?.focus()}
      />
    </CRTScreen>
  );
}
