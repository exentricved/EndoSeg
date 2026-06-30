/**
 * ClockDial — circular 1..12 picker rendered as a clock face.
 *
 * 12 is at the top, increments clockwise.
 * Click or drag to set; emits the snapped integer 1..12.
 * Used for PAPILLA_ORIFICE.surface_normal_clock.
 */

import { useCallback, useRef } from "react";

interface ClockDialProps {
  value: number | null | undefined;       // 1..12 or null/undefined for unset
  onChange: (val: number) => void;
  size?: number;                            // px
  color?: string;                           // accent color (handle + active tick)
}

const DEFAULT_SIZE = 120;
const DEFAULT_COLOR = "#A78BFA";

function angleToClock(angleRad: number): number {
  // angleRad is the angle measured from 12 o'clock position, clockwise.
  // 0 = 12, π/2 = 3, π = 6, 3π/2 = 9.
  let hours = (angleRad / (Math.PI / 6));
  hours = Math.round(hours);
  if (hours <= 0) hours += 12;
  if (hours > 12) hours -= 12;
  return hours; // 1..12
}

function clockToAngle(h: number): number {
  return (h % 12) * (Math.PI / 6);
}

export function ClockDial({ value, onChange, size = DEFAULT_SIZE, color = DEFAULT_COLOR }: ClockDialProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  const handlePointer = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    // Convert to "clockwise from up" angle: 0 at 12 o'clock, π/2 at 3 o'clock.
    let theta = Math.atan2(dx, -dy);
    if (theta < 0) theta += Math.PI * 2;
    onChange(angleToClock(theta));
  }, [onChange]);

  const center = size / 2;
  const radius = size / 2 - 8;
  const tickInner = radius - 6;
  const tickOuter = radius;
  const handleR = 8;

  const handleAngle = value && value >= 1 && value <= 12 ? clockToAngle(value) : null;
  const handleX = handleAngle !== null ? center + Math.sin(handleAngle) * (radius - 12) : 0;
  const handleY = handleAngle !== null ? center - Math.cos(handleAngle) * (radius - 12) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <svg
        ref={svgRef}
        width={size}
        height={size}
        onPointerDown={(e) => { (e.currentTarget as any).setPointerCapture?.(e.pointerId); handlePointer(e); }}
        onPointerMove={(e) => { if (e.buttons === 1) handlePointer(e); }}
        onPointerUp={(e) => { (e.currentTarget as any).releasePointerCapture?.(e.pointerId); }}
        style={{ cursor: "pointer", touchAction: "none", userSelect: "none" }}
      >
        {/* Dial circle */}
        <circle cx={center} cy={center} r={radius} fill="rgba(0,0,0,0.15)" stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
        {/* 12 tick marks + numbers */}
        {Array.from({ length: 12 }, (_, i) => i + 1).map(h => {
          const a = clockToAngle(h);
          const x1 = center + Math.sin(a) * tickInner;
          const y1 = center - Math.cos(a) * tickInner;
          const x2 = center + Math.sin(a) * tickOuter;
          const y2 = center - Math.cos(a) * tickOuter;
          const tx = center + Math.sin(a) * (radius - 18);
          const ty = center - Math.cos(a) * (radius - 18);
          const isActive = value === h;
          return (
            <g key={h}>
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={isActive ? color : "rgba(255,255,255,0.6)"}
                strokeWidth={isActive ? 2 : 1}
              />
              <text
                x={tx} y={ty}
                fontSize={10}
                fill={isActive ? color : "rgba(255,255,255,0.75)"}
                textAnchor="middle"
                dominantBaseline="middle"
                style={{ pointerEvents: "none", fontWeight: isActive ? 700 : 400 }}
              >
                {h}
              </text>
            </g>
          );
        })}
        {/* Handle */}
        {handleAngle !== null && (
          <>
            <line
              x1={center} y1={center} x2={handleX} y2={handleY}
              stroke={color} strokeWidth={2} strokeLinecap="round"
            />
            <circle cx={handleX} cy={handleY} r={handleR} fill={color} stroke="#fff" strokeWidth={1.5} />
          </>
        )}
        {/* Center dot */}
        <circle cx={center} cy={center} r={3} fill={color} />
      </svg>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.75)" }}>
        {value && value >= 1 && value <= 12 ? `${value} o'clock` : "not set"}
      </div>
    </div>
  );
}
