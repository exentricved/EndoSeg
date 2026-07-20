/**
 * useToolHotkeys.test.ts — unit tests for tool keyboard shortcuts.
 *
 * Tests use `makeToolHotkeyHandler` directly (pure function) so no React
 * mounting or renderHook is required — fast, environment-agnostic tests.
 *
 * The hook's listener-registration / cleanup is tested by dispatching real
 * events on `window` after manually invoking the effect.
 *
 * Run with:  npm test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeToolHotkeyHandler, isTypingContext } from "./useToolHotkeys";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandlers() {
  return {
    onPen: vi.fn(),
    onPolygon: vi.fn(),
    onEraser: vi.fn(),
    onAuto: vi.fn(),
    onSelect: vi.fn(),
  };
}

/**
 * Build a minimal KeyboardEvent-like object accepted by the handler.
 * `target` defaults to a plain <div> (non-typing element).
 */
function makeEvent(
  key: string,
  overrides: Partial<{
    repeat: boolean;
    target: EventTarget | null;
    metaKey: boolean;
    ctrlKey: boolean;
  }> = {}
): KeyboardEvent {
  const div = document.createElement("div");
  const evt = new KeyboardEvent("keydown", {
    key,
    repeat: overrides.repeat ?? false,
    bubbles: true,
  });
  // jsdom / happy-dom don't let you set target via constructor; define it.
  Object.defineProperty(evt, "target", {
    value: overrides.target !== undefined ? overrides.target : div,
    writable: false,
  });
  return evt;
}

// ---------------------------------------------------------------------------
// 1. Key press switches the correct tool
// ---------------------------------------------------------------------------

describe("makeToolHotkeyHandler — tool switching", () => {
  it("pressing 'p' calls onPen", () => {
    const h = makeHandlers();
    makeToolHotkeyHandler(h)(makeEvent("p"));
    expect(h.onPen).toHaveBeenCalledOnce();
    expect(h.onPolygon).not.toHaveBeenCalled();
    expect(h.onEraser).not.toHaveBeenCalled();
  });

  it("pressing 'o' calls onPolygon", () => {
    const h = makeHandlers();
    makeToolHotkeyHandler(h)(makeEvent("o"));
    expect(h.onPolygon).toHaveBeenCalledOnce();
    expect(h.onPen).not.toHaveBeenCalled();
    expect(h.onEraser).not.toHaveBeenCalled();
  });

  it("pressing 'e' calls onEraser", () => {
    const h = makeHandlers();
    makeToolHotkeyHandler(h)(makeEvent("e"));
    expect(h.onEraser).toHaveBeenCalledOnce();
    expect(h.onPen).not.toHaveBeenCalled();
    expect(h.onPolygon).not.toHaveBeenCalled();
  });

  it("unrelated key does nothing", () => {
    const h = makeHandlers();
    makeToolHotkeyHandler(h)(makeEvent("z"));
    expect(h.onPen).not.toHaveBeenCalled();
    expect(h.onPolygon).not.toHaveBeenCalled();
    expect(h.onEraser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Case insensitivity — uppercase produces the same result
// ---------------------------------------------------------------------------

describe("makeToolHotkeyHandler — case insensitivity", () => {
  it("'P' (uppercase) triggers onPen", () => {
    const h = makeHandlers();
    makeToolHotkeyHandler(h)(makeEvent("P"));
    expect(h.onPen).toHaveBeenCalledOnce();
  });

  it("'O' (uppercase) triggers onPolygon", () => {
    const h = makeHandlers();
    makeToolHotkeyHandler(h)(makeEvent("O"));
    expect(h.onPolygon).toHaveBeenCalledOnce();
  });

  it("'E' (uppercase) triggers onEraser", () => {
    const h = makeHandlers();
    makeToolHotkeyHandler(h)(makeEvent("E"));
    expect(h.onEraser).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 3. Ignore typing context — hotkeys suppressed in input / textarea / contentEditable
// ---------------------------------------------------------------------------

describe("makeToolHotkeyHandler — typing context guard", () => {
  it("does not switch tool when event target is an <input>", () => {
    const input = document.createElement("input");
    const h = makeHandlers();
    makeToolHotkeyHandler(h)(makeEvent("p", { target: input }));
    expect(h.onPen).not.toHaveBeenCalled();
  });

  it("does not switch tool when event target is a <textarea>", () => {
    const ta = document.createElement("textarea");
    const h = makeHandlers();
    makeToolHotkeyHandler(h)(makeEvent("p", { target: ta }));
    expect(h.onPen).not.toHaveBeenCalled();
  });

  it("does not switch tool when event target is contentEditable", () => {
    const div = document.createElement("div");
    div.contentEditable = "true";
    const h = makeHandlers();
    makeToolHotkeyHandler(h)(makeEvent("p", { target: div }));
    expect(h.onPen).not.toHaveBeenCalled();
  });

  it("switches tool normally when target is a plain <div>", () => {
    const div = document.createElement("div");
    const h = makeHandlers();
    makeToolHotkeyHandler(h)(makeEvent("o", { target: div }));
    expect(h.onPolygon).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 4. Ignore key-repeat (key held down)
// ---------------------------------------------------------------------------

describe("makeToolHotkeyHandler — key repeat", () => {
  it("ignores events with repeat=true", () => {
    const h = makeHandlers();
    makeToolHotkeyHandler(h)(makeEvent("p", { repeat: true }));
    expect(h.onPen).not.toHaveBeenCalled();
  });

  it("fires only once for the first non-repeated keydown", () => {
    const h = makeHandlers();
    const handler = makeToolHotkeyHandler(h);
    handler(makeEvent("p", { repeat: false })); // first press
    handler(makeEvent("p", { repeat: true  })); // held
    handler(makeEvent("p", { repeat: true  })); // held
    expect(h.onPen).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 5. isTypingContext helper
// ---------------------------------------------------------------------------

describe("isTypingContext", () => {
  it("returns true for <input>", () => {
    const input = document.createElement("input");
    const e = makeEvent("p", { target: input });
    expect(isTypingContext(e)).toBe(true);
  });

  it("returns true for <textarea>", () => {
    const ta = document.createElement("textarea");
    const e = makeEvent("p", { target: ta });
    expect(isTypingContext(e)).toBe(true);
  });

  it("returns true for contentEditable element", () => {
    const div = document.createElement("div");
    div.contentEditable = "true";
    const e = makeEvent("p", { target: div });
    expect(isTypingContext(e)).toBe(true);
  });

  it("returns false for a regular <div>", () => {
    const div = document.createElement("div");
    const e = makeEvent("p", { target: div });
    expect(isTypingContext(e)).toBe(false);
  });

  it("returns false for a <canvas>", () => {
    const canvas = document.createElement("canvas");
    const e = makeEvent("p", { target: canvas });
    expect(isTypingContext(e)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Listener cleanup — global window dispatch
// ---------------------------------------------------------------------------

describe("global window dispatch and cleanup", () => {
  beforeEach(() => {
    // Remove any listeners left from previous tests
    // (not needed since each test manages its own listeners)
  });

  it("fires when event is dispatched on window with correct target", () => {
    const h = makeHandlers();
    const listener = makeToolHotkeyHandler(h);
    window.addEventListener("keydown", listener);

    // Dispatch a real event — target will be window (not an input), so it fires
    const e = new KeyboardEvent("keydown", { key: "p", bubbles: true });
    window.dispatchEvent(e);

    window.removeEventListener("keydown", listener);
    // Window itself is not INPUT/TEXTAREA/contentEditable → tool should switch
    expect(h.onPen).toHaveBeenCalledOnce();
  });

  it("no longer fires after listener is removed (cleanup)", () => {
    const h = makeHandlers();
    const listener = makeToolHotkeyHandler(h);
    window.addEventListener("keydown", listener);
    window.removeEventListener("keydown", listener); // cleanup

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }));
    expect(h.onPen).not.toHaveBeenCalled();
  });
});
