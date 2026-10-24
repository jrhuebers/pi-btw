import type { OverlayOptions, TuiMouseEvent } from "@earendil-works/pi-tui";

export type BtwWindowBounds = { col: number; row: number; width: number; height: number };
type ResizeGesture = {
  bounds: BtwWindowBounds;
  x: number;
  y: number;
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const dimension = (value: number): number => Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;

/** Session-local preferred geometry, independent of conversation and renderer state. */
export class BtwWindowGeometry {
  readonly options: OverlayOptions;
  private columns = 100;
  private rows = 30;
  private fullWidth = false;
  private preferred?: BtwWindowBounds;
  private current!: BtwWindowBounds;
  private gesture?: ResizeGesture;

  constructor() {
    // Pi 1.4 retains this options object. Its public visibility callback runs
    // before layout, so a terminal resize can clamp geometry in the same frame.
    this.options = {
      anchor: "top-left", margin: 0, minWidth: 1, nonCapturing: true,
      visible: (columns, rows) => {
        this.updateViewport(columns, rows);
        return true;
      },
    };
    this.apply();
  }

  get isResizing(): boolean { return this.gesture !== undefined; }
  getBounds(): BtwWindowBounds { return { ...this.current }; }
  getHeight(): number { return this.current.height; }

  setFullWidth(full: boolean): void {
    if (this.fullWidth === full) return;
    this.fullWidth = full;
    this.endResize();
    this.apply();
  }

  updateViewport(columns: number, rows: number): void {
    const nextColumns = dimension(columns);
    const nextRows = dimension(rows);
    if (nextColumns === this.columns && nextRows === this.rows) return;
    this.columns = nextColumns;
    this.rows = nextRows;
    this.endResize();
    this.apply();
  }

  private defaultBounds(): BtwWindowBounds {
    const sideSpace = this.columns > 4 ? 4 : 0;
    const verticalSpace = this.rows > 2 ? 2 : 0;
    const width = Math.min(this.columns - sideSpace, Math.max(72, Math.floor(this.columns * 0.78)));
    const height = Math.min(this.rows - verticalSpace, Math.max(18, Math.min(32, Math.floor(this.rows * 0.78))));
    return { col: Math.floor((this.columns - width) / 2), row: verticalSpace ? 1 : 0, width, height };
  }

  private apply(): void {
    const requested = this.preferred ?? this.defaultBounds();
    const width = this.fullWidth ? this.columns : clamp(requested.width, Math.min(40, this.columns), this.columns);
    const height = clamp(requested.height, Math.min(12, this.rows), this.rows);
    this.current = {
      col: this.fullWidth ? 0 : clamp(requested.col, 0, this.columns - width),
      row: clamp(requested.row, 0, this.rows - height), width, height,
    };
    Object.assign(this.options, {
      col: this.current.col, row: this.current.row,
      width: this.current.width, maxHeight: this.current.height,
    });
  }

  private remember(bounds: BtwWindowBounds): void {
    if (this.fullWidth) {
      // Full-width is a presentation mode, not a replacement for saved window width.
      this.preferred = { ...(this.preferred ?? this.defaultBounds()), row: bounds.row, height: bounds.height };
    } else {
      this.preferred = { ...bounds };
    }
    this.apply();
  }

  beginResize(event: TuiMouseEvent): boolean {
    if (event.type !== "press" || event.button !== "left" || event.shift || event.alt || event.ctrl) return false;
    if (![event.x, event.y, event.screenX, event.screenY, event.width, event.height].every(Number.isFinite)) return false;
    if (event.width < 1 || event.height < 1 || event.x < 0 || event.y < 0 || event.x >= event.width || event.y >= event.height) return false;
    const edges = {
      left: !this.fullWidth && event.x === 0,
      right: !this.fullWidth && event.x === event.width - 1,
      top: event.y === 0,
      bottom: event.y === event.height - 1,
    };
    if (!Object.values(edges).some(Boolean)) return false;
    this.gesture = {
      bounds: { col: event.screenX - event.x, row: event.screenY - event.y, width: event.width, height: event.height },
      x: event.screenX, y: event.screenY, ...edges,
    };
    return true;
  }

  dragResize(event: TuiMouseEvent): boolean {
    const start = this.gesture;
    if (!start || (event.type !== "drag" && event.type !== "release")) return false;
    if (!Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return false;
    const dx = Math.round(event.screenX - start.x);
    const dy = Math.round(event.screenY - start.y);
    let left = start.bounds.col;
    let right = left + start.bounds.width;
    let top = start.bounds.row;
    let bottom = top + start.bounds.height;
    if (start.left) left = clamp(left + dx, 0, right - Math.min(40, right));
    if (start.right) right = clamp(right + dx, left + Math.min(40, this.columns - left), this.columns);
    if (start.top) top = clamp(top + dy, 0, bottom - Math.min(12, bottom));
    if (start.bottom) bottom = clamp(bottom + dy, top + Math.min(12, this.rows - top), this.rows);
    const bounds = { col: left, row: top, width: right - left, height: bottom - top };
    if (bounds.col !== this.current.col || bounds.row !== this.current.row
      || bounds.width !== this.current.width || bounds.height !== this.current.height) {
      this.remember(bounds);
    }
    return true;
  }

  endResize(): void { this.gesture = undefined; }

  resizeBy(columnsDelta: number, rowsDelta: number): void {
    if (!Number.isFinite(columnsDelta) || !Number.isFinite(rowsDelta)) return;
    this.endResize();
    const bounds = this.getBounds();
    const next = {
      ...bounds,
      width: this.fullWidth ? bounds.width : clamp(bounds.width + Math.round(columnsDelta),
        Math.min(40, this.columns - bounds.col), this.columns - bounds.col),
      height: clamp(bounds.height + Math.round(rowsDelta), Math.min(12, this.rows - bounds.row), this.rows - bounds.row),
    };
    if (next.width !== bounds.width || next.height !== bounds.height) this.remember(next);
  }

  reset(): void {
    this.endResize();
    this.preferred = undefined;
    this.apply();
  }
}
