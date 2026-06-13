/**
 * useToolHotkeys.ts - global keyboard shortcuts for tool switching.
 *
 * Hotkeys:
 *   P -> Pen tool
 *   O -> Polygon tool
 *   E -> Eraser tool (last-used sub-mode)
 *   A -> Auto tool (ML / BFS segmentation)
 *   S -> Select tool
 *
 * Design: single global keydown listener; handlers read from a ref so
 * the effect runs once and never re-registers on re-render.
 */

import { useEffect, useRef } from 'react';

export interface ToolHotkeyHandlers {
  onPen:     () => void;
  onPolygon: () => void;
  onEraser:  () => void;
  onAuto:    () => void;
  onSelect:  () => void;
}

export function isTypingContext(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true;
}

export function makeToolHotkeyHandler(
  handlers: ToolHotkeyHandlers,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (isTypingContext(e)) return;
    switch (e.key.toLowerCase()) {
      case 'p': handlers.onPen();     break;
      case 'o': handlers.onPolygon(); break;
      case 'e': handlers.onEraser();  break;
      case 'a': handlers.onAuto();    break;
      case 's': handlers.onSelect();  break;
    }
  };
}

export function useToolHotkeys(handlers: ToolHotkeyHandlers): void {
  const ref = useRef<ToolHotkeyHandlers>(handlers);
  ref.current = handlers;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => makeToolHotkeyHandler(ref.current)(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}
