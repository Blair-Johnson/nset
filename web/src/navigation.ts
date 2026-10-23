import type uPlot from "uplot";
import type { NavigationAxis, PlotInteraction } from "./workspace-types";

export type Bounds = [number, number];
export interface Viewport {
  x: Bounds;
  y: Bounds;
}
export interface NavigationScale {
  distr?: number;
  asinh?: number;
  dir?: number;
}
type Pin = "a" | "b" | "threshold";
type Pins = Record<Pin, number | null>;
export const HISTORY_LIMIT = 64;

export function transform(value: number, scale: NavigationScale): number {
  return scale.distr === 3
    ? Math.log(value)
    : scale.distr === 4
      ? Math.asinh(value / (scale.asinh ?? 1))
      : value;
}
export function inverse(value: number, scale: NavigationScale): number {
  return scale.distr === 3
    ? Math.exp(value)
    : scale.distr === 4
      ? Math.sinh(value) * (scale.asinh ?? 1)
      : value;
}
/** All navigation is affine in display space, not in raw logarithmic/asinh values. */
export function navigateRange(
  range: Bounds,
  scale: NavigationScale,
  factor = 1,
  fraction = 0,
  anchor = 0.5,
): Bounds | null {
  if (!(factor > 0) || ![factor, fraction, anchor].every(Number.isFinite))
    return null;
  if (
    !range.every(Number.isFinite) ||
    !(range[0] < range[1]) ||
    (scale.distr === 3 && range[0] <= 0)
  )
    return null;
  if (factor === 1 && fraction === 0) return [...range];
  const lo = transform(range[0], scale),
    hi = transform(range[1], scale);
  const span = hi - lo,
    center = lo + span * anchor;
  const next: Bounds = [
    inverse(
      center + (lo - center) / factor + span * fraction * (scale.dir ?? 1),
      scale,
    ),
    inverse(
      center + (hi - center) / factor + span * fraction * (scale.dir ?? 1),
      scale,
    ),
  ];
  return next.every(Number.isFinite) &&
    next[0] < next[1] &&
    (scale.distr !== 3 || next[0] > 0)
    ? next
    : null;
}
export const copyView = (v: Viewport): Viewport => ({
  x: [...v.x],
  y: [...v.y],
});
export const sameView = (a: Viewport, b: Viewport) =>
  a.x.every((v, i) => v === b.x[i]) && a.y.every((v, i) => v === b.y[i]);
export class ViewHistory {
  private views: Viewport[] = [];
  push(view: Viewport) {
    if (
      !this.views.length ||
      !sameView(this.views[this.views.length - 1], view)
    ) {
      this.views.push(copyView(view));
      if (this.views.length > HISTORY_LIMIT) this.views.shift();
    }
  }
  pop() {
    return this.views.pop();
  }
  get length() {
    return this.views.length;
  }
}
export function readViewport(u: uPlot): Viewport | null {
  const x: Bounds = [u.scales.x.min!, u.scales.x.max!],
    y: Bounds = [u.scales.y.min!, u.scales.y.max!];
  return [...x, ...y].every(Number.isFinite) && x[0] < x[1] && y[0] < y[1]
    ? { x, y }
    : null;
}
const editable = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest(
    'input, select, textarea, button, [contenteditable]:not([contenteditable="false"])',
  );
interface Gesture {
  id: number;
  x: number;
  y: number;
  view: Viewport;
  mode: PlotInteraction["mode"];
  pin?: Pin;
  moved: boolean;
}

/** Opt-in DOM controller. One instance belongs to exactly one rendered uPlot. */
export class PlotNavigation {
  private history = new ViewHistory();
  private fit: Viewport;
  private gesture?: Gesture;
  private space = false;
  private abort = new AbortController();
  private previousTouchAction: string;
  constructor(
    private u: uPlot,
    private options: PlotInteraction,
    private getPins: () => Pins,
    private putPin: (pin: Pin, value: number | null) => void,
  ) {
    this.fit = readViewport(u)!;
    // Fit is captured after trusted configured range resolution. Interactive limits
    // must not be fed back through hard editor ranges or native x->y autoscaling.
    for (const axis of ["x", "y"] as const) {
      u.scales[axis].range = (_u, lo, hi) => [lo, hi];
      u.scales[axis].auto = () => false;
    }
    u.cursor.drag!.x = u.cursor.drag!.y = u.cursor.drag!.setScale = false;
    u.root.tabIndex = 0;
    u.root.setAttribute("role", "group");
    u.root.setAttribute(
      "aria-label",
      "Interactive plot. Plus and minus zoom, arrows pan, 0 fits, Backspace goes back.",
    );
    this.previousTouchAction = u.over.style.touchAction;
    u.over.style.touchAction = "none";
    const signal = this.abort.signal;
    u.over.addEventListener("pointerdown", this.down, { signal });
    u.over.addEventListener("pointermove", this.move, { signal });
    u.over.addEventListener("pointerup", this.up, { signal });
    u.over.addEventListener("pointercancel", this.cancel, { signal });
    u.over.addEventListener("lostpointercapture", this.cancel, { signal });
    u.over.addEventListener(
      "pointerleave",
      () => this.options.onHover?.(null),
      { signal },
    );
    u.over.addEventListener("wheel", this.wheel, { signal, passive: false });
    u.over.addEventListener("dblclick", this.doubleClick, { signal });
    u.root.addEventListener("keydown", this.keydown, { signal });
    u.root.addEventListener("keyup", this.keyup, { signal });
    u.root.addEventListener("focusout", this.blur, { signal });
    window.addEventListener("blur", this.blur, { signal });
    this.cursor();
  }
  configure(options: PlotInteraction) {
    this.cancel();
    this.options.onHover?.(null);
    this.options = options;
    this.cursor();
  }
  viewport() {
    return readViewport(this.u);
  }
  canGoBack() {
    return this.history.length > 0;
  }
  private apply(next: Viewport, remember = true) {
    const before = this.viewport();
    if (!before || sameView(before, next)) return;
    if (remember) this.history.push(before);
    this.u.batch(() => {
      this.u.setScale("x", { min: next.x[0], max: next.x[1] });
      this.u.setScale("y", { min: next.y[0], max: next.y[1] });
    });
    this.options.onViewChange?.();
  }
  zoom(
    factor: number,
    axis: NavigationAxis = this.options.axis,
    anchors = { x: 0.5, y: 0.5 },
  ) {
    this.cancel();
    const view = this.viewport();
    if (!view) return;
    const x =
      axis === "y"
        ? view.x
        : navigateRange(view.x, this.u.scales.x, factor, 0, anchors.x);
    const y =
      axis === "x"
        ? view.y
        : navigateRange(view.y, this.u.scales.y, factor, 0, anchors.y);
    if (x && y) this.apply({ x, y });
  }
  pan(dx: number, dy: number) {
    this.cancel();
    const view = this.viewport();
    if (view) this.panFrom(view, dx, dy, true);
  }
  private panFrom(view: Viewport, dx: number, dy: number, remember: boolean) {
    const x = navigateRange(view.x, this.u.scales.x, 1, dx),
      y = navigateRange(view.y, this.u.scales.y, 1, dy);
    if (x && y) this.apply({ x, y }, remember);
  }
  reset() {
    this.cancel();
    this.apply(copyView(this.fit));
  }
  back() {
    this.cancel();
    const previous = this.history.pop();
    if (previous) {
      this.apply(previous, false);
    }
  }
  private cursor() {
    this.u.over.style.cursor =
      this.space || this.options.mode === "pan"
        ? this.gesture
          ? "grabbing"
          : "grab"
        : "crosshair";
  }
  private xy(e: PointerEvent | WheelEvent) {
    const r = this.u.over.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
      y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
      w: r.width,
      h: r.height,
      inside:
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom,
    };
  }
  private pinAt(pin: Pin, x: number, y: number) {
    const value = this.u.posToVal(
      pin === "threshold" ? y : x,
      pin === "threshold" ? "y" : "x",
    );
    if (Number.isFinite(value)) {
      this.putPin(pin, value);
      this.options.onPin?.(pin, value);
    }
  }
  private down = (e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary || this.gesture) return;
    const view = this.viewport();
    if (!view) return;
    e.preventDefault();
    this.u.root.focus({ preventScroll: true });
    const { x, y } = this.xy(e),
      mode = this.space ? "pan" : this.options.mode;
    let pin: Pin | undefined;
    if (mode === "inspect") {
      const pins = this.getPins();
      const near = (["a", "b"] as const)
        .map((p) => ({
          p,
          distance:
            pins[p] === null
              ? Infinity
              : Math.abs(this.u.valToPos(pins[p]!, "x") - x),
        }))
        .sort((a, b) => a.distance - b.distance);
      pin = near[0].distance <= 8 ? near[0].p : this.options.activePin;
    } else if (mode === "threshold") pin = "threshold";
    this.gesture = {
      id: e.pointerId,
      x,
      y,
      view,
      mode,
      pin,
      moved: false,
    };
    try {
      this.u.over.setPointerCapture(e.pointerId);
    } catch {
      this.gesture = undefined;
    }
    this.cursor();
  };
  private move = (e: PointerEvent) => {
    const { x, y, w, h, inside } = this.xy(e);
    const value = this.u.posToVal(x, "x");
    this.options.onHover?.(inside && Number.isFinite(value) ? value : null);
    const g = this.gesture;
    if (!g || e.pointerId !== g.id || !w || !h) return;
    g.moved ||= Math.hypot(x - g.x, y - g.y) >= 3;
    if (!g.moved) return;
    if (g.mode === "pan")
      this.panFrom(
        g.view,
        this.options.axis === "y" ? 0 : -(x - g.x) / w,
        this.options.axis === "x" ? 0 : (y - g.y) / h,
        false,
      );
    else if (g.pin) this.pinAt(g.pin, x, y);
    else if (g.mode === "zoom")
      this.u.setSelect(
        {
          left: this.options.axis === "y" ? 0 : Math.min(x, g.x),
          top: this.options.axis === "x" ? 0 : Math.min(y, g.y),
          width: this.options.axis === "y" ? w : Math.abs(x - g.x),
          height: this.options.axis === "x" ? h : Math.abs(y - g.y),
        },
        false,
      );
  };
  private release() {
    const g = this.gesture;
    this.gesture = undefined;
    if (g && this.u.over.hasPointerCapture(g.id))
      this.u.over.releasePointerCapture(g.id);
    this.u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    this.cursor();
    return g;
  }
  private up = (e: PointerEvent) => {
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) return;
    this.move(e);
    const { x, y } = this.xy(e);
    if (g.pin) this.pinAt(g.pin, x, y);
    if (g.mode === "zoom" && g.moved) {
      const axis = this.options.axis;
      if (
        (axis === "y" || Math.abs(x - g.x) >= 3) &&
        (axis === "x" || Math.abs(y - g.y) >= 3)
      ) {
        const xs = [this.u.posToVal(x, "x"), this.u.posToVal(g.x, "x")].sort(
          (a, b) => a - b,
        ) as Bounds;
        const ys = [this.u.posToVal(y, "y"), this.u.posToVal(g.y, "y")].sort(
          (a, b) => a - b,
        ) as Bounds;
        this.apply({
          x: axis === "y" ? g.view.x : xs,
          y: axis === "x" ? g.view.y : ys,
        });
      }
    } else if (g.mode === "pan" && !sameView(g.view, this.viewport()!)) {
      this.history.push(g.view);
      this.options.onViewChange?.();
    }
    this.release();
  };
  cancelGesture() {
    this.cancel();
  }
  private cancel = () => {
    const g = this.release();
    if (g?.mode === "pan") this.apply(g.view, false);
    // Pin movements are already published in data coordinates; cancellation keeps
    // the last published value so the visible line and external readout agree.
  };
  private wheel = (e: WheelEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || this.gesture) return;
    const { x, y, w, h } = this.xy(e);
    if (!w || !h) return;
    e.preventDefault();
    const view = this.viewport()!;
    const anchor = (axis: "x" | "y", pos: number) =>
      (transform(this.u.posToVal(pos, axis), this.u.scales[axis]) -
        transform(view[axis][0], this.u.scales[axis])) /
      (transform(view[axis][1], this.u.scales[axis]) -
        transform(view[axis][0], this.u.scales[axis]));
    const delta =
      e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? h : 1);
    this.zoom(
      Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002),
      e.shiftKey ? "x" : this.options.axis,
      { x: anchor("x", x), y: anchor("y", y) },
    );
  };
  private doubleClick = (e: MouseEvent) => {
    e.preventDefault();
    this.reset();
  };
  private keydown = (e: KeyboardEvent) => {
    if (editable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Space") {
      e.preventDefault();
      this.space = true;
      this.cursor();
      return;
    }
    const keys: Record<string, () => void> = {
      "+": () => this.zoom(1.25),
      "=": () => this.zoom(1.25),
      "-": () => this.zoom(0.8),
      "0": () => this.reset(),
      Backspace: () => this.back(),
      Escape: () => this.cancel(),
      ArrowLeft: () => this.pan(this.options.axis === "y" ? 0 : -0.1, 0),
      ArrowRight: () => this.pan(this.options.axis === "y" ? 0 : 0.1, 0),
      ArrowUp: () => this.pan(0, this.options.axis === "x" ? 0 : 0.1),
      ArrowDown: () => this.pan(0, this.options.axis === "x" ? 0 : -0.1),
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  };
  private keyup = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      this.space = false;
      this.cursor();
    }
  };
  private blur = () => {
    this.space = false;
    this.cancel();
  };
  destroy() {
    this.cancel();
    this.abort.abort();
    this.options.onHover?.(null);
    this.u.over.style.touchAction = this.previousTouchAction;
    this.u.over.style.cursor = "";
  }
}
