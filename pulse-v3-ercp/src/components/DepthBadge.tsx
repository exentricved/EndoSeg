/**
 * DepthBadge — colored chip showing an annotation's depth rank.
 *
 * Editable rank policy → clickable; opens a 1..4 popover.
 * Fixed rank policy   → static chip with a lock indicator.
 * null rank           → grey diagonal-stripe chip ("excluded from depth").
 */

import { useState } from "react";
import type { DepthRank, ErcpClassDef } from "../ercpClasses";

interface DepthBadgeProps {
  rank: DepthRank;
  cls: ErcpClassDef;
  onChange?: (newRank: 1 | 2 | 3 | 4) => void;
  compact?: boolean;
}

const RANK_COLORS: Record<1 | 2 | 3 | 4, { bg: string; fg: string; label: string }> = {
  1: { bg: "#ef4444", fg: "#fff",     label: "Nearest" },
  2: { bg: "#f97316", fg: "#fff",     label: "Mid"     },
  3: { bg: "#3b82f6", fg: "#fff",     label: "Deep"    },
  4: { bg: "#7c3aed", fg: "#fff",     label: "Furthest"},
};

export function DepthBadge({ rank, cls, onChange, compact = false }: DepthBadgeProps) {
  const [open, setOpen] = useState(false);
  const isFixed = cls.depthRank.mode === "fixed";

  // Null rank: grey diagonal stripe chip (excluded from depth)
  if (rank === null) {
    return (
      <span
        title="Excluded from depth training (null rank)"
        style={{
          display: "inline-block",
          padding: compact ? "1px 6px" : "2px 8px",
          fontSize: compact ? 10 : 11,
          fontWeight: 700,
          color: "#374151",
          background:
            "repeating-linear-gradient(45deg, #9CA3AF 0, #9CA3AF 4px, #6B7280 4px, #6B7280 8px)",
          border: "1px solid #4b5563",
          borderRadius: 4,
        }}
      >
        ∅
      </span>
    );
  }

  const c = RANK_COLORS[rank];
  const chip = (
    <span
      onClick={() => { if (!isFixed && onChange) setOpen(o => !o); }}
      title={isFixed
        ? `Depth rank ${rank} (${c.label}) — fixed by class ${cls.name}`
        : `Depth rank ${rank} (${c.label}) — click to change`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: compact ? "1px 6px" : "2px 8px",
        fontSize: compact ? 10 : 11,
        fontWeight: 700,
        color: c.fg,
        background: c.bg,
        border: `1px solid ${c.bg}`,
        borderRadius: 4,
        cursor: isFixed ? "default" : "pointer",
        userSelect: "none",
      }}
    >
      {rank}{isFixed && <span style={{ fontSize: 9, opacity: 0.85 }}>🔒</span>}
    </span>
  );

  if (isFixed || !onChange) return chip;

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      {chip}
      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 30,
            background: "#1f2937", border: "1px solid #374151", borderRadius: 6,
            padding: 4, display: "flex", gap: 4, boxShadow: "0 6px 18px rgba(0,0,0,0.4)",
          }}
        >
          {[1, 2, 3, 4].map(r => {
            const rc = RANK_COLORS[r as 1 | 2 | 3 | 4];
            const isCurrent = r === rank;
            const isDefault = cls.depthRank.mode === "editable" && cls.depthRank.default === r;
            return (
              <button
                key={r}
                title={isDefault ? `Default for ${cls.name}` : rc.label}
                onClick={(e) => { e.stopPropagation(); onChange(r as 1 | 2 | 3 | 4); setOpen(false); }}
                style={{
                  width: 28, height: 28,
                  fontSize: 12, fontWeight: 700,
                  color: rc.fg, background: rc.bg,
                  border: isCurrent ? "2px solid #fff" : `1px solid ${rc.bg}`,
                  borderRadius: 4, cursor: "pointer",
                  position: "relative",
                }}
              >
                {r}
                {isDefault && <span style={{ position: "absolute", top: -6, right: -6, fontSize: 8, color: "#fbbf24" }}>★</span>}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
