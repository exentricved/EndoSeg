/**
 * AttributePanel — class-specific attribute editor for the selected annotation.
 *
 * Reads the class definition's attribute schema and renders the matching widget
 * (dropdown, integer input, clock dial, free-text). On change, it patches the
 * instance's `attributes` field via the supplied callback.
 *
 * Also exposes the depth-rank badge (clickable when editable, locked when fixed).
 */

import type { AnnotationInstance, ErcpClassDef, DepthRank } from "../ercpClasses";
import { ClockDial } from "./ClockDial";
import { DepthBadge } from "./DepthBadge";

interface AttributePanelProps {
  instance: AnnotationInstance;
  cls: ErcpClassDef;
  onAttributeChange: (field: string, value: string | number) => void;
  onDepthRankChange: (newRank: 1 | 2 | 3 | 4) => void;
  onDelete: () => void;
}

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "rgba(255,255,255,0.7)",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};
const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  color: "#fff",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 4,
  outline: "none",
  boxSizing: "border-box",
};

export function AttributePanel({
  instance,
  cls,
  onAttributeChange,
  onDepthRankChange,
  onDelete,
}: AttributePanelProps) {
  return (
    <div style={{
      padding: 12,
      border: `1px solid ${cls.color}55`,
      borderLeft: `4px solid ${cls.color}`,
      borderRadius: 6,
      background: "rgba(255,255,255,0.03)",
      display: "flex",
      flexDirection: "column",
      gap: 12,
    }}>
      {/* Header: class name + depth badge + delete */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            display: "inline-block", width: 12, height: 12, borderRadius: 3, background: cls.color,
          }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{cls.name}</div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)" }}>
              {instance.geometry.kind === "polygon"
                ? `${instance.geometry.points.length} vertices`
                : "mask region"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <DepthBadge
            rank={instance.depth_rank as DepthRank}
            cls={cls}
            onChange={(r) => onDepthRankChange(r)}
          />
          <button
            onClick={onDelete}
            title="Delete this annotation (Delete)"
            style={{
              padding: "2px 8px",
              fontSize: 11,
              color: "#fca5a5",
              background: "transparent",
              border: "1px solid #7f1d1d",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Attribute fields */}
      {cls.attributes.length === 0 && (
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontStyle: "italic" }}>
          No attributes for this class.
        </div>
      )}
      {cls.attributes.map((schema) => {
        const value = instance.attributes[schema.field];
        if (schema.kind === "dropdown") {
          return (
            <div key={schema.field}>
              <label style={LABEL_STYLE}>{schema.field.replace(/_/g, " ")}</label>
              <select
                value={(value as string) ?? schema.default}
                onChange={(e) => onAttributeChange(schema.field, e.target.value)}
                style={INPUT_STYLE}
              >
                {schema.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
              {schema.tooltip && (
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginTop: 3 }}>
                  {schema.tooltip}
                </div>
              )}
            </div>
          );
        }
        if (schema.kind === "integer") {
          if (schema.widget === "clockDial") {
            return (
              <div key={schema.field}>
                <label style={LABEL_STYLE}>{schema.field.replace(/_/g, " ")}</label>
                <ClockDial
                  value={value as number | undefined}
                  onChange={(v) => onAttributeChange(schema.field, v)}
                  color={cls.color}
                />
              </div>
            );
          }
          return (
            <div key={schema.field}>
              <label style={LABEL_STYLE}>{schema.field.replace(/_/g, " ")}</label>
              <input
                type="number"
                min={schema.min}
                max={schema.max}
                value={typeof value === "number" ? value : ""}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) onAttributeChange(schema.field, n);
                }}
                style={INPUT_STYLE}
              />
            </div>
          );
        }
        if (schema.kind === "freeText") {
          return (
            <div key={schema.field}>
              <label style={LABEL_STYLE}>{schema.field.replace(/_/g, " ")}</label>
              <textarea
                value={(value as string) ?? ""}
                onChange={(e) => onAttributeChange(schema.field, e.target.value)}
                rows={2}
                style={{ ...INPUT_STYLE, resize: "vertical" }}
              />
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
