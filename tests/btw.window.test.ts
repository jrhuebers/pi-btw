import { describe, expect, it } from "vitest";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { BtwWindowGeometry } from "../extensions/btw-window";

type Rect = { col: number; row: number; width: number; height: number };

/**
 * Unit tests for the resizable floating BTW window geometry. These tests exercise only the
 * public surface that the overlay component and Pi's overlay runtime use; no terminal is
 * required. Deterministic geometry is achieved with updateViewport()/options.visible().
 */

function mouse(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type: "press",
    button: "left",
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 1,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  };
}

function press(
  rect: Rect,
  localX: number,
  localY: number,
  overrides: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
  return mouse({
    type: "press",
    button: "left",
    x: localX,
    y: localY,
    screenX: rect.col + localX,
    screenY: rect.row + localY,
    width: rect.width,
    height: rect.height,
    ...overrides,
  });
}

function drag(
  screenX: number,
  screenY: number,
  rect?: Rect,
  overrides: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
  return mouse({
    type: "drag",
    x: 0,
    y: 0,
    screenX,
    screenY,
    width: rect?.width ?? 1,
    height: rect?.height ?? 1,
    ...overrides,
  });
}

function geometry(columns = 100, rows = 30): BtwWindowGeometry {
  const g = new BtwWindowGeometry();
  g.updateViewport(columns, rows);
  return g;
}

const rightEdge = (rect: Rect): number => rect.col + rect.width - 1;
const bottomEdge = (rect: Rect): number => rect.row + rect.height - 1;
const midX = (rect: Rect): number => Math.floor(rect.width / 2);
const midY = (rect: Rect): number => Math.floor(rect.height / 2);

function expectOnScreen(g: BtwWindowGeometry, columns: number, rows: number): void {
  const rect = g.getBounds();
  expect(Number.isInteger(rect.col)).toBe(true);
  expect(Number.isInteger(rect.row)).toBe(true);
  expect(Number.isInteger(rect.width)).toBe(true);
  expect(Number.isInteger(rect.height)).toBe(true);
  expect(rect.col).toBeGreaterThanOrEqual(0);
  expect(rect.row).toBeGreaterThanOrEqual(0);
  expect(rect.col + rect.width).toBeLessThanOrEqual(columns);
  expect(rect.row + rect.height).toBeLessThanOrEqual(rows);
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
}

describe("BtwWindowGeometry defaults", () => {
  it("matches the previous framed window at the default 100x30 viewport", () => {
    const g = new BtwWindowGeometry();
    g.updateViewport(100, 30);

    // Centered framed window: 78 columns wide, 78% height, top margin 1.
    expect(g.getBounds()).toEqual({ col: 11, row: 1, width: 78, height: 23 });
    expect(g.getHeight()).toBe(23);
    expectOnScreen(g, 100, 30);
  });

  it("uses max(72, 78%) width and a 78% height clamped to the screen", () => {
    const g = geometry(120, 40);

    // floor(120 * 0.78) = 93, floor(40 * 0.78) = 31, centered horizontally, top margin 1.
    expect(g.getBounds()).toEqual({ col: 13, row: 1, width: 93, height: 31 });
    expect(g.getHeight()).toBe(31);
  });

  it("fits a small terminal instead of overflowing it", () => {
    const g = geometry(30, 10);

    // The 40x12 user minimum is itself clamped to the terminal, so a 30x10
    // terminal is filled edge to edge rather than left with unusable margins.
    expect(g.getBounds()).toEqual({ col: 0, row: 0, width: 30, height: 10 });
    expectOnScreen(g, 30, 10);
  });

  it("caps the default height at 32 rows", () => {
    const g = geometry(100, 60);

    expect(g.getBounds().height).toBe(32);
    expect(g.getHeight()).toBe(32);
  });

  it("switches to full available columns without side borders", () => {
    const g = geometry(100, 30);

    g.setFullWidth(true);
    expect(g.getBounds()).toEqual({ col: 0, row: 1, width: 100, height: 23 });
    expect(g.getHeight()).toBe(23);

    g.setFullWidth(false);
    expect(g.getBounds()).toEqual({ col: 11, row: 1, width: 78, height: 23 });
  });
});

describe("BtwWindowGeometry overlay options", () => {
  it("keeps one stable readonly options object and mutates it in place", () => {
    const g = new BtwWindowGeometry();
    g.updateViewport(100, 30);
    const options = g.options;

    expect(g.options).toBe(options);
    let bounds = g.getBounds();
    expect(options.row).toBe(bounds.row);
    expect(options.col).toBe(bounds.col);
    expect(options.width).toBe(bounds.width);
    expect(options.maxHeight).toBe(bounds.height);
    expect(options.margin).toBe(0);
    expect(options.minWidth).toBe(1);
    expect(options.anchor).toBe("top-left");
    expect(options.nonCapturing).toBe(true);
    expect(typeof options.visible).toBe("function");

    g.setFullWidth(true);
    expect(g.options).toBe(options);
    bounds = g.getBounds();
    expect(options.width).toBe(bounds.width);
    expect(options.col).toBe(bounds.col);
    expect(options.maxHeight).toBe(bounds.height);

    g.setFullWidth(false);
    g.resizeBy(5, 2);
    expect(g.options).toBe(options);
    bounds = g.getBounds();
    expect(options.width).toBe(bounds.width);
    expect(options.row).toBe(bounds.row);
    expect(options.maxHeight).toBe(bounds.height);
  });

  it("updates the viewport from the visibility callback before Pi resolves layout", () => {
    const g = new BtwWindowGeometry();
    const visible = g.options.visible;

    expect(typeof visible).toBe("function");
    // Pi calls visible(termWidth, termHeight) each render before resolving the layout.
    expect(visible!(120, 40)).toBe(true);
    expect(g.getBounds()).toEqual({ col: 13, row: 1, width: 93, height: 31 });
    expect(g.options.width).toBe(93);
    expect(g.options.maxHeight).toBe(31);
    expect(g.options.row).toBe(1);
    expect(g.options.col).toBe(13);
  });
});

describe("BtwWindowGeometry pointer resizing", () => {
  it("resizes from the right edge with the left edge fixed", () => {
    const g = geometry();
    const start = g.getBounds();

    expect(g.beginResize(press(start, start.width - 1, midY(start)))).toBe(true);
    expect(g.isResizing).toBe(true);
    expect(g.dragResize(drag(rightEdge(start) + 10, start.row + midY(start), start))).toBe(true);

    expect(g.getBounds()).toEqual({ ...start, width: start.width + 10 });
    g.endResize();
    expect(g.isResizing).toBe(false);
  });

  it("resizes from the left edge with the right edge fixed", () => {
    const g = geometry();
    const start = g.getBounds();
    const fixedRight = rightEdge(start);

    expect(g.beginResize(press(start, 0, midY(start)))).toBe(true);
    g.dragResize(drag(start.col + 10, start.row + midY(start), start));

    const end = g.getBounds();
    expect(end).toEqual({ ...start, col: start.col + 10, width: start.width - 10 });
    expect(rightEdge(end)).toBe(fixedRight);
  });

  it("resizes from the top edge with the bottom edge fixed", () => {
    const g = geometry();
    const start = g.getBounds();
    const fixedBottom = bottomEdge(start);

    expect(g.beginResize(press(start, midX(start), 0))).toBe(true);
    g.dragResize(drag(start.col + midX(start), start.row + 10, start));

    const end = g.getBounds();
    expect(end).toEqual({ ...start, row: start.row + 10, height: start.height - 10 });
    expect(bottomEdge(end)).toBe(fixedBottom);
  });

  it("resizes from the bottom edge with the top edge fixed", () => {
    const g = geometry();
    const start = g.getBounds();

    expect(g.beginResize(press(start, midX(start), start.height - 1))).toBe(true);
    g.dragResize(drag(start.col + midX(start), bottomEdge(start) + 5, start));

    expect(g.getBounds()).toEqual({ ...start, height: start.height + 5 });
  });

  it("resizes from every corner while keeping the opposite corner fixed", () => {
    const topLeft = geometry();
    const topLeftStart = topLeft.getBounds();
    expect(topLeft.beginResize(press(topLeftStart, 0, 0))).toBe(true);
    topLeft.dragResize(drag(topLeftStart.col + 10, topLeftStart.row + 10, topLeftStart));
    expect(topLeft.getBounds()).toEqual({
      ...topLeftStart,
      col: topLeftStart.col + 10,
      row: topLeftStart.row + 10,
      width: topLeftStart.width - 10,
      height: topLeftStart.height - 10,
    });

    const topRight = geometry();
    const topRightStart = topRight.getBounds();
    expect(topRight.beginResize(press(topRightStart, topRightStart.width - 1, 0))).toBe(true);
    topRight.dragResize(drag(rightEdge(topRightStart) + 10, topRightStart.row + 10, topRightStart));
    expect(topRight.getBounds()).toEqual({
      ...topRightStart,
      row: topRightStart.row + 10,
      width: topRightStart.width + 10,
      height: topRightStart.height - 10,
    });

    const bottomLeft = geometry();
    const bottomLeftStart = bottomLeft.getBounds();
    expect(bottomLeft.beginResize(press(bottomLeftStart, 0, bottomLeftStart.height - 1))).toBe(true);
    bottomLeft.dragResize(drag(bottomLeftStart.col + 10, bottomEdge(bottomLeftStart) + 5, bottomLeftStart));
    expect(bottomLeft.getBounds()).toEqual({
      ...bottomLeftStart,
      col: bottomLeftStart.col + 10,
      width: bottomLeftStart.width - 10,
      height: bottomLeftStart.height + 5,
    });

    const bottomRight = geometry();
    const bottomRightStart = bottomRight.getBounds();
    expect(bottomRight.beginResize(press(bottomRightStart, bottomRightStart.width - 1, bottomRightStart.height - 1))).toBe(true);
    bottomRight.dragResize(drag(rightEdge(bottomRightStart) + 10, bottomEdge(bottomRightStart) + 5, bottomRightStart));
    expect(bottomRight.getBounds()).toEqual({
      ...bottomRightStart,
      width: bottomRightStart.width + 10,
      height: bottomRightStart.height + 5,
    });
  });

  it("clamps pointer resizes to the 40x12 minimum", () => {
    const g = geometry();
    let start = g.getBounds();

    expect(g.beginResize(press(start, start.width - 1, midY(start)))).toBe(true);
    g.dragResize(drag(0, start.row + midY(start), start));
    expect(g.getBounds()).toEqual({ ...start, width: 40 });
    g.endResize();

    start = g.getBounds();
    expect(g.beginResize(press(start, midX(start), start.height - 1))).toBe(true);
    g.dragResize(drag(start.col + midX(start), 0, start));
    expect(g.getBounds()).toEqual({ ...start, height: 12 });
  });

  it("clamps pointer resizes to the screen bounds", () => {
    const g = geometry();
    const start = g.getBounds();

    expect(g.beginResize(press(start, start.width - 1, midY(start)))).toBe(true);
    g.dragResize(drag(500, start.row + midY(start), start));
    expect(g.getBounds()).toEqual({
      col: start.col,
      row: start.row,
      width: 100 - start.col,
      height: start.height,
    });
    g.endResize();

    const tall = g.getBounds();
    expect(g.beginResize(press(tall, midX(tall), tall.height - 1))).toBe(true);
    g.dragResize(drag(tall.col + midX(tall), 500, tall));
    expect(g.getBounds()).toEqual({
      col: tall.col,
      row: tall.row,
      width: tall.width,
      height: 30 - tall.row,
    });
  });

  it("clamps left/top growth to screen origin", () => {
    const g = geometry();
    let start = g.getBounds();

    expect(g.beginResize(press(start, 0, midY(start)))).toBe(true);
    g.dragResize(drag(-50, start.row + midY(start), start));
    expect(g.getBounds()).toEqual({
      col: 0,
      row: start.row,
      width: rightEdge(start) + 1,
      height: start.height,
    });
    g.endResize();

    start = g.getBounds();
    expect(g.beginResize(press(start, midX(start), 0))).toBe(true);
    g.dragResize(drag(start.col + midX(start), -50, start));
    expect(g.getBounds()).toEqual({
      col: start.col,
      row: 0,
      width: start.width,
      height: bottomEdge(start) + 1,
    });
  });

  it("anchors capturing to the event's actual component rectangle", () => {
    const g = geometry();
    // The rendered component rectangle differs from getBounds(); the press must still
    // resolve its edge/corner from screenX-x, screenY-y, width, and height.
    const actual = { col: 10, row: 5, width: 50, height: 20 };

    expect(g.beginResize(press(actual, 49, 10))).toBe(true);
    g.dragResize(drag(59 + 10, 15, actual));

    expect(g.getBounds()).toEqual({ col: 10, row: 5, width: 60, height: 20 });
  });

  it("captures only left-button presses on edges or corners", () => {
    const g = geometry();
    const start = g.getBounds();

    expect(g.beginResize(press(start, start.width - 1, midY(start), { button: "right" }))).toBe(false);
    expect(g.beginResize(press(start, start.width - 1, midY(start), { button: "middle" }))).toBe(false);
    expect(g.beginResize(press(start, start.width - 1, midY(start), { type: "move" }))).toBe(false);
    expect(g.beginResize(press(start, start.width - 1, midY(start), { type: "release" }))).toBe(false);
    expect(g.beginResize(press(start, start.width - 1, midY(start), { type: "click" }))).toBe(false);
    expect(g.beginResize(press(start, midX(start), midY(start)))).toBe(false);
    expect(g.isResizing).toBe(false);
  });

  it("clears drag state in endResize", () => {
    const g = geometry();
    const start = g.getBounds();

    expect(g.beginResize(press(start, start.width - 1, midY(start)))).toBe(true);
    g.endResize();
    expect(g.isResizing).toBe(false);

    const settled = g.getBounds();
    expect(g.dragResize(drag(rightEdge(start) + 20, start.row + midY(start), start))).toBe(false);
    expect(g.getBounds()).toEqual(settled);
  });

  it("rejects non-finite pointer coordinates", () => {
    const g = geometry();
    const start = g.getBounds();

    expect(g.beginResize(press(start, start.width - 1, midY(start), { screenX: Number.NaN }))).toBe(false);
    expect(g.beginResize(press(start, start.width - 1, midY(start), { screenX: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(g.beginResize(press(start, start.width - 1, midY(start), { screenY: Number.NEGATIVE_INFINITY }))).toBe(false);
    expect(g.isResizing).toBe(false);

    expect(g.beginResize(press(start, start.width - 1, midY(start)))).toBe(true);
    const before = g.getBounds();
    g.dragResize(drag(Number.NaN, Number.NaN, start));
    expect(g.getBounds()).toEqual(before);
    expectOnScreen(g, 100, 30);
  });
});

describe("BtwWindowGeometry full-width resizing", () => {
  it("captures only top and bottom edges in full-width mode", () => {
    const g = geometry();
    g.setFullWidth(true);
    const start = g.getBounds();

    expect(g.beginResize(press(start, 0, midY(start)))).toBe(false);
    expect(g.beginResize(press(start, start.width - 1, midY(start)))).toBe(false);
    expect(g.isResizing).toBe(false);

    expect(g.beginResize(press(start, midX(start), 0))).toBe(true);
    g.endResize();
    expect(g.beginResize(press(start, midX(start), start.height - 1))).toBe(true);
    g.endResize();
  });

  it("resizes height in full-width mode without changing width", () => {
    const g = geometry();
    g.setFullWidth(true);
    const start = g.getBounds();

    expect(g.beginResize(press(start, midX(start), start.height - 1))).toBe(true);
    g.dragResize(drag(start.col + midX(start), bottomEdge(start) + 5, start));

    expect(g.getBounds()).toEqual({ col: 0, row: 1, width: 100, height: start.height + 5 });
    expect(g.getHeight()).toBe(start.height + 5);
  });

  it("keeps the saved window rectangle across full/window toggles and reopens", () => {
    const g = geometry();
    g.resizeBy(12, 5);
    const saved = g.getBounds();
    // Right/bottom keyboard growth is capped at the terminal edge: 11 + 89 = 100.
    expect(saved).toEqual({ col: 11, row: 1, width: 89, height: 28 });

    g.setFullWidth(true);
    expect(g.getBounds()).toEqual({ col: 0, row: 1, width: 100, height: saved.height });

    // A second render/reopen must not discard the absolute window rectangle.
    expect(g.options.visible!(100, 30)).toBe(true);
    expect(g.getBounds()).toEqual({ col: 0, row: 1, width: 100, height: saved.height });

    g.setFullWidth(false);
    expect(g.getBounds()).toEqual(saved);
  });

  it("keeps height changes made in full-width mode when returning to window mode", () => {
    const g = geometry();
    g.setFullWidth(true);
    const start = g.getBounds();

    expect(g.beginResize(press(start, midX(start), start.height - 1))).toBe(true);
    g.dragResize(drag(start.col + midX(start), bottomEdge(start) + 5, start));
    g.endResize();
    expect(g.getHeight()).toBe(28);

    g.setFullWidth(false);
    expect(g.getBounds()).toEqual({ col: 11, row: 1, width: 78, height: 28 });
  });
});

describe("BtwWindowGeometry keyboard resizing", () => {
  it("moves the right and bottom edges with resizeBy", () => {
    const g = geometry(120, 40);
    const start = g.getBounds();

    g.resizeBy(10, 5);
    expect(g.getBounds()).toEqual({
      col: start.col,
      row: start.row,
      width: start.width + 10,
      height: start.height + 5,
    });
  });

  it("clamps keyboard resizing to the minimum and to the screen", () => {
    const g = geometry();
    const start = g.getBounds();

    g.resizeBy(-500, -500);
    expect(g.getBounds()).toEqual({ col: start.col, row: start.row, width: 40, height: 12 });

    g.resizeBy(500, 500);
    expect(g.getBounds()).toEqual({
      col: start.col,
      row: start.row,
      width: 100 - start.col,
      height: 30 - start.row,
    });
    expectOnScreen(g, 100, 30);
  });
});

describe("BtwWindowGeometry lifecycle", () => {
  it("reset clears the preferred rectangle", () => {
    const g = geometry();
    const initial = g.getBounds();

    g.resizeBy(10, 5);
    expect(g.getBounds()).not.toEqual(initial);

    g.reset();
    expect(g.getBounds()).toEqual(initial);
    expect(g.isResizing).toBe(false);
  });

  it("preserves the preferred size across terminal shrink and re-expand", () => {
    const g = geometry();
    g.resizeBy(12, 5);
    const preferred = g.getBounds();
    expect(preferred).toEqual({ col: 11, row: 1, width: 89, height: 28 });

    // The clamped 60x20 viewport cannot show the preferred 89x28 rectangle.
    g.updateViewport(60, 20);
    expect(g.getBounds()).toEqual({ col: 0, row: 0, width: 60, height: 20 });
    expectOnScreen(g, 60, 20);

    // Re-expanding restores the last preferred size, not the shrunken one.
    g.updateViewport(100, 30);
    expect(g.getBounds()).toEqual(preferred);
  });

  it("returns the clamped viewport height without reapplying the 32-row default cap", () => {
    const g = geometry(100, 60);
    expect(g.getHeight()).toBe(32);

    g.resizeBy(0, 10);
    expect(g.getHeight()).toBe(42);

    g.updateViewport(100, 20);
    expect(g.getHeight()).toBe(20);

    g.updateViewport(100, 60);
    expect(g.getHeight()).toBe(42);
  });

  it("cancels an active drag when the viewport changes", () => {
    const g = geometry();
    let start = g.getBounds();

    expect(g.beginResize(press(start, start.width - 1, midY(start)))).toBe(true);
    expect(g.isResizing).toBe(true);
    g.updateViewport(90, 28);
    expect(g.isResizing).toBe(false);

    start = g.getBounds();
    expect(g.beginResize(press(start, start.width - 1, midY(start)))).toBe(true);
    expect(g.isResizing).toBe(true);
    g.setFullWidth(true);
    expect(g.isResizing).toBe(false);
  });

  it("does not cancel an active drag when visibility runs for an unchanged viewport", () => {
    const g = geometry();
    const start = g.getBounds();

    expect(g.beginResize(press(start, start.width - 1, midY(start)))).toBe(true);
    // options.visible runs on every render before layout; only a real viewport change
    // may cancel an in-progress drag.
    expect(g.options.visible!(100, 30)).toBe(true);
    expect(g.isResizing).toBe(true);
    g.endResize();
  });
});
