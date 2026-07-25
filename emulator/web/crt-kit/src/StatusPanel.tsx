"use client";
// <StatusPanel> — generic labeled readout (reused for DEFCON, clearance,
// link status) per docs/surfaces.md.

export interface StatusItem {
  label: string;
  value: string;
}

export interface StatusPanelProps {
  items: StatusItem[];
}

export function StatusPanel({ items }: StatusPanelProps) {
  return (
    <div
      style={{
        display: "flex",
        gap: "2.5em",
        borderBottom: "1px solid var(--crt-dim)",
        paddingBottom: "0.35em",
        marginBottom: "0.75em",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      {items.map((it) => (
        <span key={it.label}>
          {it.label}: {it.value}
        </span>
      ))}
    </div>
  );
}
