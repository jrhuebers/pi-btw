import { afterEach, describe, expect, it, vi } from "vitest";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  stripTerminalSequences,
  type Terminal,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { BtwOverlayComponent } from "../extensions/btw";
import { BtwWindowGeometry } from "../extensions/btw-window";

// No extension factory, session, model runtime, credentials, or real terminal.
// Initialize only Pi's built-in theme; do not enable its filesystem watcher.
initTheme("dark", false);

type Transcript = ReturnType<ConstructorParameters<typeof BtwOverlayComponent>[3]>;
const longTranscript: Transcript = [{
  id: 1, turnId: 1, type: "user-message",
  text: Array.from({ length: 100 }, (_, index) => `BTW line ${index}`).join("\n"),
}];
// A mid-stream reply keeps the "streaming" summary badge observable.
const streamingTranscript: Transcript = [
  ...longTranscript,
  { id: 2, turnId: 2, type: "assistant-text", text: "BTW streaming reply", streaming: true },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  // Restore superclass spies before disposal in case disposal delegates to them.
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface FixtureOptions {
  entries?: Transcript;
  widthMode?: "window" | "full";
  columns?: number;
  rows?: number;
}

function fixture(options: FixtureOptions = {}) {
  const { entries = longTranscript, widthMode = "window", columns = 100, rows = 30 } = options;
  let receive: (data: string) => void = () => { throw new Error("Fake terminal not started"); };
  const terminal: Terminal = {
    columns, rows, kittyProtocolActive: false,
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
  // A real BtwWindowGeometry instance flows through the final constructor
  // parameter exactly the way the extension's own integration does.
  const geometry = new BtwWindowGeometry();
  geometry.setFullWidth(widthMode === "full");
  const overlay = new BtwOverlayComponent(
    tui, theme, keybindings, () => entries, () => null,
    () => "contextual", () => widthMode, vi.fn(), vi.fn(), vi.fn(), vi.fn(),
    () => "local", process.cwd(), undefined, geometry,
  );
  cleanups.push(() => { overlay.dispose(); tui.stop({ preserveScreen: true }); });
  tui.start();
  // geometry.options is the stable mutable options object the extension hands
  // to showOverlay; Pi retains it and consults options.visible every render.
  const handle = tui.showOverlay(overlay, geometry.options);
  // The extension focuses the overlay from its onHandle callback; nonCapturing
  // options mean nothing focuses it implicitly.
  handle.focus();
  tui.renderNow();
  const initial = handle.getBounds()!;
  expect(initial).toBeDefined();
  expect(initial.col).toBeGreaterThanOrEqual(0);
  expect(initial.row).toBeGreaterThanOrEqual(0);

  // Read live on every access so assertions always describe the current render.
  const bounds = () => handle.getBounds()!;

  function sgr(kind: "press" | "drag" | "release", x: number, y: number): void {
    const button = kind === "drag" ? 32 : 0;
    const terminator = kind === "release" ? "m" : "M";
    // Deliver through Terminal.start's callback: real TuiBase input listeners,
    // SGR parsing, overlay hit-testing, capture retargeting, and dispatch.
    receive(`\x1b[<${button};${x + 1};${y + 1}${terminator}`);
    tui.renderNow();
  }

  function key(data: string): void {
    receive(data);
    tui.renderNow();
  }

  function wheel(direction: -1 | 1, x: number, y: number): void {
    receive(`\x1b[<${direction < 0 ? 64 : 65};${x + 1};${y + 1}M`);
    tui.renderNow();
  }

  // Observe visible overlay content instead of private transcript offsets.
  function visibleText(): string {
    return stripTerminalSequences(overlay.render(bounds().width).join("\n"));
  }

  // Build a normalized event in overlay-local coordinates for direct
  // handleMouse probing, mirroring what Pi's dispatcher produces.
  function mouseEvent(
    type: TuiMouseEvent["type"], x: number, y: number,
    overrides: Partial<TuiMouseEvent> = {},
  ): TuiMouseEvent {
    const b = bounds();
    return {
      type, button: type === "wheel" ? "none" : "left", x, y,
      screenX: b.col + x, screenY: b.row + y,
      width: b.width, height: b.height,
      shift: false, alt: false, ctrl: false, ...overrides,
    };
  }

  /** Drag the bottom edge downward with real SGR press/drag/release bytes. */
  function dragBottomEdge(growTo: number): void {
    const before = bounds();
    const x = before.col + Math.floor(before.width / 2);
    sgr("press", x, before.row + before.height - 1);
    sgr("drag", x, growTo);
    sgr("release", x, growTo);
  }

  function spyRouteWheel() {
    return vi.spyOn(tui as unknown as { routeWheel(...args: unknown[]): unknown }, "routeWheel");
  }

  return { tui, overlay, geometry, handle, terminal, bounds, sgr, key, wheel,
    visibleText, mouseEvent, dragBottomEdge, spyRouteWheel, rows };
}

describe("BTW overlay resize with the real Pi fullscreen dispatcher", () => {
  it("uses the shared geometry options and defaults to col 11, row 1, 78x23 at 100x30", () => {
    const f = fixture();
    expect(f.geometry.options.visible).toBeTypeOf("function");
    expect(f.geometry.options.col).toBe(11);
    expect(f.geometry.options.row).toBe(1);
    expect(f.geometry.options.width).toBe(78);
    expect(f.geometry.options.maxHeight).toBe(23);
    expect(f.bounds()).toEqual({ col: 11, row: 1, width: 78, height: 23 });
  });

  it("resizes live from SGR press/drag/release on the bottom edge with one component and handle", () => {
    const f = fixture();
    const before = f.bounds();
    const renderSpy = vi.spyOn(f.overlay, "render");
    // The press lands on the bottom border row, so dragging it down by dy rows
    // moves the rect's bottom edge down by dy as well.
    f.dragBottomEdge(before.row + before.height + 4);
    const after = f.bounds();
    expect(after.height).toBe(before.height + 5);
    expect(after.row + after.height).toBe(before.row + before.height + 5);
    // The same overlay component instance is still rendering the dialog through
    // the same live handle; the overlay was never torn down or recreated.
    expect(renderSpy).toHaveBeenCalled();
    expect(f.tui.hasOverlay()).toBe(true);
    expect(f.handle.getBounds()).toBeDefined();
  });

  it("keeps the drag capture alive far outside the original bounds", () => {
    const f = fixture({ rows: 44 });
    const before = f.bounds();
    const x = before.col + Math.floor(before.width / 2);
    f.sgr("press", x, before.row + before.height - 1);
    // Drag well past the original bottom edge; only a live capture delivers
    // events outside the rect the press landed on.
    const outsideY = before.row + before.height + 10;
    f.sgr("drag", x, outsideY);
    const live = f.bounds();
    expect(live.row + live.height).toBe(outsideY + 1);
    f.sgr("release", x, outsideY);
    expect(f.bounds()).toEqual(live);
  });

  it("grows both dimensions from a real corner drag", () => {
    const f = fixture({ columns: 120, rows: 44 });
    const before = f.bounds();
    const cornerX = before.col + before.width - 1;
    const cornerY = before.row + before.height - 1;
    const dragX = Math.min(cornerX + 5, f.terminal.columns - 1);
    const dragY = Math.min(cornerY + 5, f.rows - 1);
    f.sgr("press", cornerX, cornerY);
    f.sgr("drag", dragX, dragY);
    f.sgr("release", dragX, dragY);
    const after = f.bounds();
    expect(after.width).toBe(before.width + 5);
    expect(after.height).toBe(before.height + 5);
  });

  it("still swallows wheels over the enlarged overlay without scrolling main", () => {
    const f = fixture({ rows: 44 });
    f.dragBottomEdge(40);
    const after = f.bounds();
    expect(after.row + after.height).toBe(41);
    const main = f.tui.viewportTop;
    const fallback = f.spyRouteWheel();
    // A point that sat outside the ORIGINAL bounds now lands on the overlay.
    f.wheel(-1, after.col + 2, after.row + after.height - 2);
    expect(fallback).not.toHaveBeenCalled();
    expect(f.tui.viewportTop).toBe(main);
  });

  it("preserves draft, completions, and streaming state through keyboard resizing", () => {
    const f = fixture({ entries: streamingTranscript });
    f.overlay.setDraft("/b");
    f.key("\x1b[1;4C"); // Alt+Shift+Right
    f.key("\x1b[1;4B"); // Alt+Shift+Down
    f.key("\x1b[1;4C");
    f.key("\x1b[1;4B");
    expect(f.overlay.getDraft()).toBe("/b");
    const text = f.visibleText();
    expect(text).toContain("/btw"); // completion list survived
    expect(text).toContain("streaming"); // streaming badge survived
    expect(text).toContain("BTW line"); // native transcript content survived
  });

  it("preserves the draft through a captured bottom-edge drag", () => {
    const f = fixture({ entries: streamingTranscript, rows: 44 });
    f.overlay.setDraft("hello world");
    f.dragBottomEdge(40);
    expect(f.overlay.getDraft()).toBe("hello world");
    expect(f.visibleText()).toContain("streaming");
  });

  it("sizes by Alt+Shift+arrows (width by 4, height by 2) and resets with Alt+Shift+R", () => {
    const f = fixture();
    const before = f.bounds();
    f.key("\x1b[1;4C"); // Alt+Shift+Right
    expect(f.bounds().width).toBe(before.width + 4);
    f.key("\x1b[1;4B"); // Alt+Shift+Down
    expect(f.bounds().height).toBe(before.height + 2);
    f.key("\x1b[1;4D"); // Alt+Shift+Left
    expect(f.bounds().width).toBe(before.width);
    f.key("\x1b[1;4A"); // Alt+Shift+Up
    expect(f.bounds().height).toBe(before.height);
    f.key("\x1b[1;4C");
    f.key("\x1b[1;4B");
    expect(f.bounds()).not.toEqual(before);
    f.key("\x1b[114;4u"); // Alt+Shift+R
    expect(f.bounds()).toEqual(before);
  });

  it("lets the user grow height beyond 32 rows by keyboard", () => {
    const f = fixture({ rows: 50 });
    const before = f.bounds();
    expect(before.height).toBe(32);
    for (let index = 0; index < 6; index++) f.key("\x1b[1;4B");
    const after = f.bounds();
    expect(after.height).toBe(before.height + 12);
    expect(after.height).toBeGreaterThan(32);
    expect(after.row + after.height).toBeLessThanOrEqual(f.rows);
  });

  it("clamps to a tiny terminal with compact chrome and restores the preferred size", () => {
    const f = fixture();
    // A user resize records the preferred geometry before the terminal shrinks.
    f.key("\x1b[1;4B");
    f.key("\x1b[1;4B");
    expect(f.bounds().height).toBe(27);
    f.overlay.setDraft("tiny draft");
    f.terminal.columns = 24;
    f.terminal.rows = 8;
    f.tui.renderNow();
    const clamped = f.bounds();
    expect(clamped.width).toBeLessThanOrEqual(24);
    expect(clamped.height).toBeLessThanOrEqual(8);
    expect(clamped.height).toBeLessThan(12); // compact chrome kicks in
    expect(f.visibleText()).toContain("tiny draft"); // input row preserved
    f.terminal.columns = 100;
    f.terminal.rows = 30;
    f.tui.renderNow();
    // The user's preferred height (27, not the 23 default) is restored.
    expect(f.bounds()).toEqual({ col: 11, row: 1, width: 78, height: 27 });
  });

  it("keeps completion rows fitting at the minimum height of 12", () => {
    const f = fixture();
    f.overlay.setDraft("/b");
    for (let index = 0; index < 20; index++) f.key("\x1b[1;4A"); // Alt+Shift+Up repeatedly
    expect(f.bounds().height).toBe(12);
    const text = f.visibleText();
    expect(text).toContain("/btw"); // completions still fit and render
  });

  it("permits only vertical resizing in full-width mode", () => {
    const f = fixture({ widthMode: "full" });
    const before = f.bounds();
    expect(before.width).toBe(100); // edge to edge
    f.key("\x1b[1;4C"); // Alt+Shift+Right
    expect(f.bounds().width).toBe(before.width);
    f.key("\x1b[1;4D"); // Alt+Shift+Left
    expect(f.bounds().width).toBe(before.width);
    f.key("\x1b[1;4B"); // Alt+Shift+Down
    expect(f.bounds().height).toBe(before.height + 2);
    f.key("\x1b[1;4A"); // Alt+Shift+Up
    expect(f.bounds().height).toBe(before.height);
    // A drag on the (borderless) right edge captures nothing and resizes nothing.
    const midY = before.row + Math.floor(before.height / 2);
    f.sgr("press", before.width - 1, midY);
    f.sgr("drag", before.width - 6, midY);
    f.sgr("release", before.width - 6, midY);
    expect(f.bounds()).toEqual(before);
    // A bottom-edge drag still resizes vertically.
    f.sgr("press", 50, before.row + before.height - 1);
    f.sgr("drag", 50, before.row + before.height + 2);
    f.sgr("release", 50, before.row + before.height + 2);
    expect(f.bounds().height).toBe(before.height + 3);
    expect(f.bounds().width).toBe(before.width);
  });

  it("does not capture presses on the overlay body", () => {
    const f = fixture();
    const b = f.bounds();
    const bodyX = Math.floor(b.width / 2);
    const bodyY = Math.floor(b.height / 2);
    expect(f.overlay.handleMouse(f.mouseEvent("press", bodyX, bodyY))).toBeUndefined();
    // Contrast: a bottom-edge press is handled and captured for resizing.
    const edge = f.overlay.handleMouse(f.mouseEvent("press", bodyX, b.height - 1));
    expect(edge?.handled).toBe(true);
    expect(edge?.capture).toBe(true);
    // Release the direct probe's gesture so it cannot leak into later steps.
    f.overlay.handleMouse(f.mouseEvent("release", bodyX, b.height - 1));
    // Through the dispatcher, a body press/drag/release never resizes.
    const screenX = b.col + bodyX;
    const screenY = b.row + bodyY;
    f.sgr("press", screenX, screenY);
    f.sgr("drag", 0, 0);
    f.sgr("release", 0, 0);
    expect(f.bounds()).toEqual(b);
  });
});
