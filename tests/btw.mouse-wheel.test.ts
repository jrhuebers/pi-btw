import { afterEach, describe, expect, it, vi } from "vitest";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  stripTerminalSequences,
  type Terminal,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { BtwOverlayComponent } from "../extensions/btw";

// No extension factory, session, model runtime, credentials, or real terminal.
// Initialize only Pi's built-in theme; do not enable its filesystem watcher.
initTheme("dark", false);

type Transcript = ReturnType<ConstructorParameters<typeof BtwOverlayComponent>[3]>;
const longTranscript: Transcript = [{
  id: 1, turnId: 1, type: "user-message",
  text: Array.from({ length: 100 }, (_, index) => `BTW line ${index}`).join("\n"),
}];
const cleanups: Array<() => void> = [];
afterEach(() => {
  // Restore superclass spies before disposal in case disposal delegates to them.
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(entries: Transcript = longTranscript) {
  let receive: (data: string) => void = () => { throw new Error("Fake terminal not started"); };
  const terminal: Terminal = {
    columns: 100, rows: 40, kittyProtocolActive: false,
    start(input) { receive = input; },
    stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {},
    setProgress() {}, setProgramStatus() {},
  };
  const tui = new TuiAltScreen(terminal, false, undefined, {
    wheelScrollLines: 1, copyOnSelect: false,
  });
  tui.addChild({
    render: () => Array.from({ length: 220 }, (_, index) => `MAIN SESSION ${index}`),
    invalidate() {},
  });
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
  } as ExtensionContext["ui"]["theme"];
  const keybindings = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.clear": { defaultKeys: "ctrl+c", description: "Clear composer" },
  });
  const overlay = new BtwOverlayComponent(
    tui, theme, keybindings, () => entries, () => null,
    () => "contextual", () => "window", vi.fn(), vi.fn(), vi.fn(), vi.fn(),
  );
  cleanups.push(() => { overlay.dispose(); tui.stop({ preserveScreen: true }); });
  tui.start();
  const handle = tui.showOverlay(overlay, { width: 60, anchor: "center" });
  tui.renderNow();
  const bounds = handle.getBounds()!;
  expect(bounds).toBeDefined();
  expect(bounds.col).toBeGreaterThan(0);
  expect(bounds.row).toBeGreaterThan(0);

  // Observe, but do not replace, the real renderer-level main-session fallback.
  // routeWheel is a TS-private method in Pi 1.4; it remains an ordinary JS method.
  const fallback = vi.spyOn(tui as unknown as { routeWheel(...args: unknown[]): unknown }, "routeWheel");
  const event = (wheelDelta = -1, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
    type: "wheel", button: "none", x: 5, y: 5,
    screenX: bounds.col + 5, screenY: bounds.row + 5,
    width: bounds.width, height: bounds.height,
    shift: false, alt: false, ctrl: false, wheelDelta, ...overrides,
  });
  function wheel(direction: -1 | 1, outside = false) {
    const x = outside ? 0 : bounds.col + 5;
    const y = outside ? 0 : bounds.row + 5;
    // Deliver through Terminal.start's callback: real TuiBase input listeners,
    // SGR parsing, overlay hit-testing, dispatch, and fallback all execute.
    receive(`\x1b[<${direction < 0 ? 64 : 65};${x + 1};${y + 1}M`);
    tui.renderNow();
  }
  // Observe visible content instead of private transcript offsets. This also
  // works when BTW's renderer uses native Pi child components internally.
  function visibleLines(): number[] {
    return overlay.render(bounds.width).flatMap((line) => {
      const match = stripTerminalSequences(line).match(/BTW line (\d+)/);
      return match ? [Number(match[1])] : [];
    });
  }
  return { tui, overlay, bounds, event, wheel, fallback, visibleLines,
    render: () => tui.renderNow() };
}

describe("BTW mouse wheel with the real Pi fullscreen dispatcher", () => {
  it("scrolls BTW up without moving the main session or invoking its fallback", () => {
    const f = fixture();
    const main = f.tui.viewportTop;
    const before = f.visibleLines();
    expect(main).toBeGreaterThan(0);
    expect(before[0]).toBeGreaterThan(0);
    f.wheel(-1);
    expect(f.tui.viewportTop).toBe(main);
    expect(f.fallback).not.toHaveBeenCalled();
    expect(f.visibleLines()[0]).toBe(before[0] - 1);
  });

  it("scrolls BTW down after up while leaving the main session unchanged", () => {
    const f = fixture();
    const main = f.tui.viewportTop;
    const bottom = f.visibleLines()[0];
    f.wheel(-1); f.wheel(-1); f.wheel(1);
    expect(f.visibleLines()[0]).toBe(bottom - 1);
    expect(f.tui.viewportTop).toBe(main);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("returns the exact overlay target metadata and applies the delta magnitude", () => {
    const f = fixture();
    const before = f.visibleLines()[0];
    const result = f.overlay.handleMouse(f.event(-4));
    expect(result?.handled).toBe(true);
    expect(result?.target).toEqual({
      component: f.overlay, originX: f.bounds.col, originY: f.bounds.row,
      width: f.bounds.width, height: f.bounds.height,
    });
    f.render();
    expect(f.visibleLines()[0]).toBe(before - 4);
  });

  it("consumes upward wheels at the top instead of leaking them to main", () => {
    const f = fixture();
    for (let index = 0; index < 200; index++) f.overlay.handleInput("\x1b[<64;1;1M");
    f.render();
    expect(f.visibleLines()[0]).toBe(0);
    const main = f.tui.viewportTop;
    f.wheel(-1);
    expect(f.visibleLines()[0]).toBe(0);
    expect(f.tui.viewportTop).toBe(main);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("consumes downward wheels at the bottom without renderer fallback", () => {
    const f = fixture();
    const main = f.tui.viewportTop;
    const before = f.visibleLines();
    f.wheel(1);
    expect(f.visibleLines()).toEqual(before);
    expect(f.tui.viewportTop).toBe(main);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("consumes both directions over an empty transcript", () => {
    const f = fixture([]);
    const main = f.tui.viewportTop;
    f.wheel(-1); f.wheel(1);
    expect(f.visibleLines()).toEqual([]);
    expect(f.tui.viewportTop).toBe(main);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("handles a missing wheelDelta as zero movement", () => {
    const f = fixture();
    const before = f.visibleLines();
    expect(f.overlay.handleMouse(f.event(-1, { wheelDelta: undefined }))?.handled).toBe(true);
    f.render();
    expect(f.visibleLines()).toEqual(before);
  });

  it("delegates non-wheel events to Container without scrolling", () => {
    const f = fixture();
    const before = f.visibleLines();
    const sentinel: ReturnType<Container["handleMouse"]> = {
      handled: true,
      target: { component: f.overlay, originX: 0, originY: 0, width: 1, height: 1 },
    };
    const parent = vi.spyOn(Container.prototype, "handleMouse").mockReturnValue(sentinel);
    for (const type of ["press", "release", "move", "drag", "click"] as const) {
      const event = f.event(0, { type, button: "left" });
      expect(f.overlay.handleMouse(event)).toBe(sentinel);
      expect(parent).toHaveBeenLastCalledWith(event);
    }
    expect(parent).toHaveBeenCalledTimes(5);
    parent.mockRestore();
    expect(f.visibleLines()).toEqual(before);
  });

  it("does not handle wheels outside its local bounds", () => {
    const f = fixture();
    const before = f.visibleLines();
    for (const point of [{ x: -1 }, { y: -1 }, { x: f.bounds.width }, { y: f.bounds.height }]) {
      expect(f.overlay.handleMouse(f.event(-1, point))).toBeUndefined();
    }
    expect(f.visibleLines()).toEqual(before);
  });

  it("really scrolls main for a wheel outside the floating overlay (negative control)", () => {
    const f = fixture();
    const main = f.tui.viewportTop;
    const before = f.visibleLines();
    f.wheel(-1, true);
    expect(f.fallback).toHaveBeenCalledTimes(1);
    expect(f.tui.viewportTop).toBe(main - 1);
    expect(f.visibleLines()).toEqual(before);
  });

  it("preserves the legacy raw SGR handleInput path and its three-line step", () => {
    const f = fixture();
    const main = f.tui.viewportTop;
    const before = f.visibleLines();
    f.overlay.handleInput("\x1b[<64;20;10M"); f.render();
    expect(f.visibleLines()[0]).toBe(before[0] - 3);
    f.overlay.handleInput("\x1b[<65;20;10M"); f.render();
    expect(f.visibleLines()).toEqual(before);
    expect(f.tui.viewportTop).toBe(main);
    expect(f.fallback).not.toHaveBeenCalled();
  });
});
