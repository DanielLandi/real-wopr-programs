"use client";
// <CommandLine> — input capture; supports the period BREAK interrupt
// (Ctrl+C -> control frame) per docs/surfaces.md.
//
// The caret is the CRT block cursor, sitting ON the prompt line right after
// the typed text: `> CMD█`. The native caret is hidden and a <span.crt-cursor>
// is pinned to the end of the text by sizing the input to its content width
// (monospace, so 1 char == 1ch). When this component is on screen the parent
// suppresses the Teletype's trailing cursor so there is exactly one cursor.

import { useRef, useState, type KeyboardEvent } from "react";

export interface CommandLineProps {
  onSubmit: (line: string) => void;
  onBreak?: () => void;
  disabled?: boolean;
  prompt?: string;
  /** Mask typed input (operator access codes): password dots, no echo. */
  mask?: boolean;
}

export function CommandLine({ onSubmit, onBreak, disabled, prompt = ">", mask }: CommandLineProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      onBreak?.();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const line = value;
      setValue("");
      onSubmit(line);
    }
  };

  return (
    <div
      style={{ display: "flex", gap: "0.5em", alignItems: "baseline" }}
      onClick={() => ref.current?.focus()}
    >
      <span>{prompt}</span>
      <span style={{ whiteSpace: "pre" }}>
        <input
          ref={ref}
          type={mask ? "password" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          autoFocus
          autoComplete={mask ? "new-password" : "off"}
          autoCapitalize="characters"
          spellCheck={false}
          style={{
            // sized to its content so the block cursor sits right after the
            // last typed character (monospace: 1 char == 1ch).
            width: `${value.length}ch`,
            background: "transparent",
            border: "none",
            outline: "none",
            padding: 0,
            margin: 0,
            lineHeight: "inherit",
            color: "inherit",
            font: "inherit",
            textShadow: "inherit",
            textTransform: "uppercase",
            caretColor: "transparent",
          }}
        />
        <span className="crt-cursor" />
      </span>
    </div>
  );
}
