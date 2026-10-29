import type uPlot from "uplot";
import { cursorPlacement } from "./cursor-placement";
import type { NavigationAxis, PlotInteraction } from "./workspace-types";

// Keep the pure math exports usable in Node unit tests.
if (typeof document !== "undefined") void import("./zoom-selection.css");

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
type Pin = "a" | "b" | "threshold" | "yA" | "yB";
type Pins = Record<"a" | "b" | "threshold", number | null> & {
  yA?: number | null;
  yB?: number | null;
};
export const AXIS_TOLERANCE = 12;
export const MIN_DRAG = 3;
/** CSS-pixel tolerance, shared by both the preview and committed viewport. */
export function inferZoomAxes(dx: number, dy: number): NavigationAxis | null {
  const x = Math.abs(dx),
    y = Math.abs(dy);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < MIN_DRAG && y < MIN_DRAG) return null;
  if (x > AXIS_TOLERANCE && y > AXIS_TOLERANCE) return "both";
  return x >= y ? "x" : "y";
}
export const HISTORY_LIMIT = 64;
/** Minimum ms between wheel/pinch zoom redraws (~30 per second). */
export const WHEEL_INTERVAL = 33;

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
/** Move the old contact anchor to the new one while scaling in display space.
 * Fractions run from low to high on normal axes (x left→right, y bottom→top).
 * Translation is divided by the pinch factor: translating the old span would
 * drift the anchor whenever a pinch and a pan happen in the same frame. */
export function gestureRange(
  range: Bounds,
  scale: NavigationScale,
  factor: number,
  from: number,
  to: number,
): Bounds | null {
  return navigateRange(
    range,
    scale,
    factor,
    (from - to) / factor,
    scale.dir === -1 ? 1 - from : from,
  );
}
type Contact = { x: number; y: number };
type ContactPair = [Contact, Contact];
const midpoint = ([a, b]: ContactPair): Contact => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});
const separation = ([a, b]: ContactPair) => Math.hypot(a.x - b.x, a.y - b.y);
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
  entries(): Viewport[] {
    return this.views.map(copyView);
  }
  get length() {
    return this.views.length;
  }
}
/** Camera state that can be moved onto a freshly built chart of the same axes. */
export interface NavigationSnapshot {
  view: Viewport;
  history: Viewport[];
  zoomed: boolean;
}
export function readViewport(u: uPlot): Viewport | null {
  const x: Bounds = [u.scales.x.min!, u.scales.x.max!],
    y: Bounds = [u.scales.y.min!, u.scales.y.max!];
  return [...x, ...y].every(Number.isFinite) && x[0] < x[1] && y[0] < y[1]
    ? { x, y }
    : null;
}
const editable = (target: EventTarget | null, includeButtons = true) =>
  target instanceof Element &&
  !!target.closest(
    'input, select, textarea, [contenteditable]:not([contenteditable="false"])' +
      (includeButtons ? ", button" : ""),
  );
interface Gesture {
  id: number;
  x: number;
  y: number;
  view: Viewport;
  mode: PlotInteraction["mode"];
  pin?: Pin;
  moved: boolean;
  placement?: Pin;
}

/** Opt-in DOM controller. One instance belongs to exactly one rendered uPlot. */
export class PlotNavigation {
  private history = new ViewHistory();
  private fit: Viewport;
  private gesture?: Gesture;
  private contacts = new Map<number, Contact>();
  private contactView?: Viewport;
  private pinch?: { view: Viewport; points: ContactPair };
  private space = false;
  private pointerButtons = 0;
  private touchInput = false;
  private active = false;
  private destroyed = false;
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
      // Native setSeries(show) still requests an automatic range with null
      // bounds even when auto is false. Visibility must not erase the camera
      // (including when every trace is hidden); explicit navigation stays exact.
      u.scales[axis].range = (_u, lo, hi) => [
        lo ?? u.scales[axis].min!,
        hi ?? u.scales[axis].max!,
      ];
      u.scales[axis].auto = () => false;
    }
    u.cursor.drag!.x = u.cursor.drag!.y = u.cursor.drag!.setScale = false;
    u.root.tabIndex = 0;
    u.root.setAttribute("role", "group");
    u.root.setAttribute(
      "aria-label",
      "Interactive plot. Drag to zoom, right-drag or Space-drag to pan, Ctrl+scroll zooms. Plus and minus zoom, arrows pan, 0 fits, Backspace goes back.",
    );
    this.previousTouchAction = u.over.style.touchAction;
    u.over.style.touchAction = "none";
    u.root.classList.add("plot-navigation");
    this.setActive(true);
    this.publishView();
  }
  /** Detach input fan-out without losing the fit, camera, history, or pins. */
  setActive(active: boolean): void {
    if (this.destroyed || this.active === active) return;
    this.active = active;
    if (active) {
      this.abort = new AbortController();
      this.listen();
      this.cursor();
    } else {
      this.abort.abort();
      this.cancelGesture();
      this.space = false;
      this.pointerButtons = 0;
      this.touchInput = false;
      this.options.onHover?.(null);
      this.u.over.style.touchAction = this.previousTouchAction;
      this.u.over.style.cursor = "";
    }
  }
  private listen() {
    const u = this.u;
    const signal = this.abort.signal;
    u.over.addEventListener("pointerdown", this.down, { signal });
    u.over.addEventListener("contextmenu", this.contextmenu, { signal });
    u.over.addEventListener("pointermove", this.move, { signal });
    u.over.addEventListener("pointerup", this.up, { signal });
    u.over.addEventListener("pointercancel", this.cancel, { signal });
    u.over.addEventListener("lostpointercapture", this.cancel, { signal });
    u.over.addEventListener(
      "pointerleave",
      (e) => {
        // Touch release generates pointerleave even though the inspected point
        // is still useful. Keep it until the next gesture/tool change.
        if (this.options.mode === "navigate") {
          if (e.pointerType !== "touch" && !this.contacts.size)
            this.suppressHover();
        } else this.options.onHover?.(null);
      },
      { signal },
    );
    // uPlot also installs legacy mouse/touch listeners. Do not let those start
    // native selection or clear the explicit touch cursor after every move.
    for (const type of [
      "touchstart",
      "touchmove",
      "touchend",
      "touchcancel",
      "mousedown",
      "mousemove",
      "mouseup",
      "click",
      "dblclick",
      "mouseout",
      "mouseleave",
    ])
      u.over.addEventListener(type, this.nativeEvent, {
        signal,
        capture: true,
        passive: false,
      });
    u.over.addEventListener("wheel", this.wheel, { signal, passive: false });
    u.over.addEventListener("dblclick", this.doubleClick, { signal });
    u.root.addEventListener("keydown", this.keydown, { signal });
    u.root.addEventListener("keyup", this.keyup, { signal });
    u.root.addEventListener("focusout", this.blur, { signal });
    window.addEventListener("blur", this.blur, { signal });
    window.addEventListener("keydown", this.spaceDown, { signal });
    // Only this window listener cycles: a focused plot's bubbling key must not
    // also cycle in its root handler. Abort owns every listener on teardown.
    window.addEventListener("keydown", this.cycleCursor, { signal });
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
    ])
      window.addEventListener(type, this.trackButtons, {
        signal,
        capture: true,
      });
    window.addEventListener("keyup", this.keyup, { signal });
  }
  configure(options: PlotInteraction) {
    if (!this.active) {
      this.options = options;
      return;
    }
    this.cancel();
    if (
      this.options.mode !== options.mode &&
      (this.options.mode === "navigate" || options.mode === "navigate")
    )
      this.suppressHover();
    else this.options.onHover?.(null);
    this.options = options;
    this.cursor();
  }
  viewport() {
    return readViewport(this.u);
  }
  canGoBack() {
    return this.history.length > 0;
  }
  snapshot(): NavigationSnapshot | null {
    const view = this.viewport();
    if (!view) return null;
    return {
      view: copyView(view),
      history: this.history.entries(),
      zoomed: !sameView(view, this.fit),
    };
  }
  /** Live data must not change coordinates beneath an uncommitted gesture. */
  interacting(): boolean {
    return !!this.gesture || this.contacts.size > 0 || !!this.wheelPending;
  }
  /** Replace the reset target, retaining both the camera and every Back entry. */
  updateFit(fit: Viewport): void {
    const follow = !this.snapshot()?.zoomed;
    this.fit = copyView(fit);
    if (follow) this.apply(copyView(fit), false);
  }
  /** Re-apply a zoomed camera and its back-history; an un-zoomed plot keeps its new fit. */
  restore(snapshot: NavigationSnapshot) {
    for (const view of snapshot.history) this.history.push(view);
    if (snapshot.zoomed) this.apply(copyView(snapshot.view), false);
  }
  /** Display a view exactly (e.g. a camera handed over from another panel). */
  show(view: Viewport) {
    this.cancel();
    this.apply(copyView(view), false);
  }
  private apply(next: Viewport, remember = true) {
    const before = this.viewport();
    if (!before || sameView(before, next)) return;
    if (remember) this.history.push(before);
    this.u.batch(() => {
      this.u.setScale("x", { min: next.x[0], max: next.x[1] });
      this.u.setScale("y", { min: next.y[0], max: next.y[1] });
    });
    this.publishView();
    this.options.onViewChange?.();
  }
  /** Inspectable camera (tests, probes); not used for app state. */
  private publishView() {
    const v = this.viewport();
    if (v) this.u.root.dataset.view = JSON.stringify(v);
  }
  zoom(
    factor: number,
    axis: NavigationAxis = this.options.axis,
    anchors = { x: 0.5, y: 0.5 },
    remember = true,
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
    if (x && y) this.apply({ x, y }, remember);
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
    this.u.root.dataset.cursorPlacement = cursorPlacement(this.options);
    this.u.root.dataset.navigationTool = this.options.mode;
    // Both ordinary box/cursor dragging and the opt-in tool own plot contacts.
    // Never apply this policy to the card, toolbar, or surrounding page.
    this.u.over.style.touchAction = "none";
    this.u.over.style.cursor =
      this.gesture?.mode === "pan" ||
      this.space ||
      (!this.options.directGestures && this.options.mode === "pan")
        ? this.gesture
          ? "grabbing"
          : "grab"
        : "crosshair";
  }
  private xy(e: PointerEvent | WheelEvent, clamp = true) {
    const r = this.u.over.getBoundingClientRect();
    return {
      x: clamp
        ? Math.max(0, Math.min(r.width, e.clientX - r.left))
        : e.clientX - r.left,
      y: clamp
        ? Math.max(0, Math.min(r.height, e.clientY - r.top))
        : e.clientY - r.top,
      w: r.width,
      h: r.height,
      inside:
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom,
    };
  }
  private suppressHover() {
    this.u.root.classList.add("plot-pan-hover-hidden");
    this.u.setCursor({ left: -10, top: -10 }, false);
    this.options.onHover?.(null);
  }
  private zoomAxes(g: Gesture, x: number, y: number) {
    return this.options.inferZoomAxes
      ? inferZoomAxes(x - g.x, y - g.y)
      : this.options.axis;
  }
  private nearestPin(x: number, y: number, axis?: "x" | "y"): Pin | undefined {
    const pins = this.getPins();
    const candidates: Pin[] =
      axis === "x"
        ? ["a", "b"]
        : axis === "y"
          ? ["yA", "yB"]
          : ["a", "b", "yA", "yB"];
    let closest: Pin | undefined,
      distance = 8;
    for (const pin of candidates) {
      const value = pins[pin];
      if (value == null || !Number.isFinite(value)) continue;
      const horizontal = pin === "yA" || pin === "yB";
      const d = Math.abs(
        this.u.valToPos(value, horizontal ? "y" : "x") - (horizontal ? y : x),
      );
      if (d <= distance) {
        closest = pin;
        distance = d;
      }
    }
    return closest;
  }
  private pinAt(pin: Pin, x: number, y: number) {
    const horizontal = pin === "threshold" || pin === "yA" || pin === "yB";
    const value = this.u.posToVal(horizontal ? y : x, horizontal ? "y" : "x");
    if (Number.isFinite(value)) {
      this.putPin(pin, value);
      if (pin === "yA" || pin === "yB")
        this.options.onHorizontalPin?.(pin === "yA" ? "a" : "b", value);
      else this.options.onPin?.(pin, value);
      return true;
    }
    return false;
  }
  private nativeEvent = (e: Event) => {
    if (
      this.options.mode !== "navigate" ||
      (!e.type.startsWith("touch") && !this.touchInput)
    )
      return;
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
  };
  private inspectAt({ x, y }: Contact) {
    const rect = this.u.over.getBoundingClientRect();
    x = Math.max(0, Math.min(rect.width, x));
    y = Math.max(0, Math.min(rect.height, y));
    this.u.root.classList.remove("plot-pan-hover-hidden");
    this.u.setCursor({ left: x, top: y }, false);
    const value = this.u.posToVal(x, "x");
    this.options.onHover?.(Number.isFinite(value) ? value : null, [x, y]);
  }
  private rebaseContacts() {
    const points = [...this.contacts.values()];
    this.pinch =
      points.length === 2
        ? { view: this.viewport()!, points: points as ContactPair }
        : undefined;
    if (points.length === 1) this.inspectAt(points[0]);
    else if (points.length > 1) this.suppressHover();
  }
  private contactDown(e: PointerEvent) {
    if (e.button !== 0 || (e.pointerType !== "touch" && !e.isPrimary)) return;
    const view = this.viewport();
    if (!view) return;
    e.preventDefault();
    this.u.root.focus({ preventScroll: true });
    if (!this.contacts.size) this.contactView = view;
    this.contacts.set(e.pointerId, this.xy(e, false));
    try {
      this.u.over.setPointerCapture(e.pointerId);
    } catch {
      this.cancelContacts();
      return;
    }
    this.rebaseContacts();
  }
  private contactMove(e: PointerEvent) {
    const point = this.xy(e, false);
    if (!this.contacts.has(e.pointerId)) {
      if (!this.contacts.size && e.pointerType !== "touch" && point.inside)
        this.inspectAt(point);
      return;
    }
    e.preventDefault();
    this.contacts.set(e.pointerId, point);
    if (this.contacts.size === 1) {
      this.inspectAt(point);
      return;
    }
    this.suppressHover();
    const g = this.pinch;
    if (!g || this.contacts.size !== 2 || !point.w || !point.h) return;
    const points = [...this.contacts.values()] as ContactPair;
    // Coincident contacts have no stable scale; wait for a usable baseline.
    if (separation(g.points) < MIN_DRAG) {
      this.rebaseContacts();
      return;
    }
    const factor = separation(points) / separation(g.points);
    const start = midpoint(g.points),
      end = midpoint(points);
    const x = gestureRange(
      g.view.x,
      this.u.scales.x,
      factor,
      start.x / point.w,
      end.x / point.w,
    );
    const y = gestureRange(
      g.view.y,
      this.u.scales.y,
      factor,
      1 - start.y / point.h,
      1 - end.y / point.h,
    );
    if (x && y) this.apply({ x, y }, false);
  }
  private contactUp(e: PointerEvent) {
    if (!this.contacts.has(e.pointerId)) return;
    this.contactMove(e);
    this.contacts.delete(e.pointerId);
    // Delete before releasing: our expected lost-capture event is not a cancel.
    if (this.u.over.hasPointerCapture(e.pointerId))
      this.u.over.releasePointerCapture(e.pointerId);
    this.rebaseContacts();
    if (!this.contacts.size) {
      const before = this.contactView,
        after = this.viewport();
      this.contactView = undefined;
      if (before && after && !sameView(before, after)) {
        this.history.push(before);
        this.options.onViewChange?.();
      }
    }
  }
  private cancelContacts() {
    const ids = [...this.contacts.keys()],
      before = this.contactView;
    this.contacts.clear();
    this.contactView = undefined;
    this.pinch = undefined;
    for (const id of ids)
      if (this.u.over.hasPointerCapture(id))
        this.u.over.releasePointerCapture(id);
    if (before) {
      this.suppressHover();
      this.apply(before, false);
    }
  }
  private contextmenu = (e: MouseEvent) => {
    if (this.options.directGestures) e.preventDefault();
  };
  private down = (e: PointerEvent) => {
    this.touchInput = e.pointerType === "touch";
    if (this.options.mode === "navigate" && this.touchInput) {
      this.contactDown(e);
      return;
    }
    const direct = this.options.directGestures;
    if (
      (e.button !== 0 && !(direct && e.button === 2)) ||
      !e.isPrimary ||
      this.gesture
    )
      return;
    const view = this.viewport();
    if (!view) return;
    e.preventDefault();
    this.u.root.focus({ preventScroll: true });
    const { x, y } = this.xy(e);
    let mode =
      this.space || (direct && e.button === 2) ? "pan" : this.options.mode;
    if (
      direct &&
      mode !== "inspect" &&
      mode !== "threshold" &&
      !this.space &&
      e.button !== 2
    )
      mode = "zoom";
    let pin: Pin | undefined;
    let placement: Pin | undefined;
    const pending = mode === "inspect" || mode === "threshold";
    const axis = this.options.cursorAxis ?? "x";
    const nextPin: Pin =
      mode === "threshold"
        ? "threshold"
        : axis === "y"
          ? this.options.activePin === "a"
            ? "yA"
            : "yB"
          : this.options.activePin;
    if (direct && mode !== "pan") {
      // Dragging an existing line moves it. While placement is armed, only lines
      // of the armed axis are grabbable (a vertical cursor never blocks placing a
      // horizontal one), and a click without movement still places the next
      // cursor even right beside an existing line, for tight A/B spacing.
      pin = this.nearestPin(x, y, pending ? axis : undefined);
      mode = pin ? "inspect" : "zoom";
      if (pending) placement = nextPin;
    } else if (mode === "inspect") {
      pin = this.nearestPin(x, y, axis) ?? nextPin;
    } else if (mode === "threshold") pin = "threshold";
    this.gesture = {
      id: e.pointerId,
      x,
      y,
      view,
      mode,
      pin,
      moved: false,
      placement,
    };
    try {
      this.u.over.setPointerCapture(e.pointerId);
    } catch {
      this.gesture = undefined;
    }
    if (this.gesture?.mode === "pan") this.suppressHover();
    this.cursor();
  };
  private move = (e: PointerEvent) => {
    this.touchInput = e.pointerType === "touch";
    if (this.options.mode === "navigate" && this.touchInput) {
      this.contactMove(e);
      return;
    }
    const { x, y, w, h, inside } = this.xy(e);
    const g = this.gesture;
    if (g?.mode === "pan") this.suppressHover();
    else {
      // Only fresh pointer movement may re-enable hover, never pan release/cancel.
      if (e.type === "pointermove")
        this.u.root.classList.remove("plot-pan-hover-hidden");
      const value = this.u.posToVal(x, "x");
      this.options.onHover?.(inside && Number.isFinite(value) ? value : null, [
        x,
        y,
      ]);
    }
    if (!g || e.pointerId !== g.id || !w || !h) return;
    g.moved ||= Math.hypot(x - g.x, y - g.y) >= MIN_DRAG;
    if (!g.moved) return;
    if (g.mode === "pan")
      this.panFrom(
        g.view,
        this.options.axis === "y" ? 0 : -(x - g.x) / w,
        this.options.axis === "x" ? 0 : (y - g.y) / h,
        false,
      );
    else if (g.pin) this.pinAt(g.pin, x, y);
    else if (g.mode === "zoom") {
      const axis = this.zoomAxes(g, x, y);
      this.u.root.classList.toggle("plot-zoom-selecting", axis !== null);
      // Whole CSS pixels: fractional edges leave partially repainted slivers.
      const left = Math.round(axis === "y" ? 0 : Math.min(x, g.x)),
        top = Math.round(axis === "x" ? 0 : Math.min(y, g.y));
      this.u.setSelect(
        axis
          ? {
              left,
              top,
              width: Math.round(axis === "y" ? w : Math.max(x, g.x)) - left,
              height: Math.round(axis === "x" ? h : Math.max(y, g.y)) - top,
            }
          : { left: 0, top: 0, width: 0, height: 0 },
        false,
      );
    }
  };
  private release() {
    const g = this.gesture;
    this.gesture = undefined;
    if (g?.mode === "pan") this.suppressHover();
    if (g && this.u.over.hasPointerCapture(g.id))
      this.u.over.releasePointerCapture(g.id);
    this.u.root.classList.remove("plot-zoom-selecting");
    this.u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    this.cursor();
    return g;
  }
  private up = (e: PointerEvent) => {
    this.touchInput = e.pointerType === "touch";
    if (this.options.mode === "navigate" && this.touchInput) {
      this.contactUp(e);
      return;
    }
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) return;
    this.move(e);
    const { x, y } = this.xy(e);
    // A grabbed line only moves on a real drag; a click must not nudge it.
    if (g.pin && (g.moved || !g.placement)) this.pinAt(g.pin, x, y);
    if (g.mode === "zoom" && g.moved) {
      const axis = this.zoomAxes(g, x, y);
      if (
        axis &&
        (axis === "y" || Math.abs(x - g.x) >= MIN_DRAG) &&
        (axis === "x" || Math.abs(y - g.y) >= MIN_DRAG)
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
    if (
      g.placement &&
      !g.moved &&
      this.xy(e).inside &&
      this.pinAt(g.placement, x, y)
    ) {
      const first = g.placement === "a" || g.placement === "yA";
      this.options = {
        ...this.options,
        mode: first ? "inspect" : "zoom",
        activePin: first ? "b" : this.options.activePin,
      };
      this.cursor();
      // Reconfiguration is safe now: no live gesture/capture can be cancelled.
      this.options.onPlacementComplete?.(g.placement);
    }
  };
  cancelGesture() {
    if (this.wheelPending) clearTimeout(this.wheelPending.timer);
    this.wheelPending = undefined;
    this.wheelLast = 0;
    this.wheelBurstUntil = 0;
    this.cancel();
  }
  private cancel = (event?: PointerEvent) => {
    if (event?.pointerType === "touch" && this.options.mode === "navigate") {
      if (this.contacts.has(event.pointerId)) this.cancelContacts();
      return;
    }
    this.cancelContacts();
    if (event && this.gesture && event.pointerId !== this.gesture.id) return;
    const g = this.release();
    if (g?.mode === "pan") this.apply(g.view, false);
    // Pin movements are already published in data coordinates; cancellation keeps
    // the last published value so the visible line and external readout agree.
  };
  // Wheel/pinch events arrive far faster than redraws are worth doing (and
  // 120 Hz displays double the frame rate). Merge them and apply at most one
  // zoom per WHEEL_INTERVAL ms; one Back-history entry per burst.
  private wheelPending?: {
    factor: number;
    axis: NavigationAxis;
    anchors: { x: number; y: number };
    timer: ReturnType<typeof setTimeout>;
  };
  private wheelLast = 0;
  private wheelBurstUntil = 0;
  private flushWheel = () => {
    const next = this.wheelPending;
    this.wheelPending = undefined;
    if (!next) return;
    const now = performance.now();
    this.wheelLast = now;
    // A pause longer than this starts a new burst (new Back step).
    const remember = now > this.wheelBurstUntil;
    this.wheelBurstUntil = now + 250;
    this.zoom(next.factor, next.axis, next.anchors, remember);
  };
  private wheel = (e: WheelEvent) => {
    // Ctrl+wheel (and trackpad pinch, which browsers report as ctrl+wheel) or
    // Alt+wheel zooms the hovered plot; a plain wheel keeps scrolling the page.
    if (!(e.altKey || e.ctrlKey) || e.metaKey || this.gesture) return;
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
    const factor = Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002);
    const axis = e.shiftKey ? "x" : this.options.axis;
    const anchors = { x: anchor("x", x), y: anchor("y", y) };
    const pending = this.wheelPending;
    if (pending) {
      pending.factor *= factor;
      pending.axis = axis;
      pending.anchors = anchors;
      return;
    }
    const wait = Math.max(
      0,
      this.wheelLast + WHEEL_INTERVAL - performance.now(),
    );
    this.wheelPending = {
      factor,
      axis,
      anchors,
      timer: setTimeout(this.flushWheel, wait),
    };
  };
  private doubleClick = (e: MouseEvent) => {
    e.preventDefault();
    this.reset();
  };
  private trackButtons = (e: Event) => {
    this.pointerButtons =
      e.type === "pointercancel" ? 0 : (e as PointerEvent).buttons;
  };
  private cycleCursor = (e: KeyboardEvent) => {
    if (
      e.key.toLowerCase() !== "c" ||
      e.defaultPrevented ||
      e.repeat ||
      e.isComposing ||
      e.keyCode === 229 ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      editable(e.target, false) ||
      editable(document.activeElement, false) ||
      this.gesture ||
      this.contacts.size > 0 ||
      this.pointerButtons ||
      this.space ||
      !this.u.over.matches(":hover") ||
      !this.options.onCursorModeCycle
    )
      return;
    e.preventDefault();
    // The card owns placement state and UI. Do not focus, place, clear, or
    // mutate pins here; its callback reconfigures this controller synchronously.
    this.options.onCursorModeCycle();
  };
  private spaceDown = (e: KeyboardEvent) => {
    // A toolbar click leaves its button focused. Over the plot, Space must pan,
    // not activate that old button on keyup (which can re-enable touch mode).
    if (
      !this.options.directGestures ||
      e.code !== "Space" ||
      editable(e.target, false) ||
      (editable(e.target) && !this.u.over.matches(":hover")) ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey
    )
      return;
    this.space = true;
    // Holding Space before the initial plot click should work, without taking
    // keyboard scrolling away from the rest of the workspace.
    if (this.u.over.matches(":hover")) e.preventDefault();
    this.cursor();
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
      Escape: () => {
        this.cancel();
        if (this.options.mode === "navigate") this.suppressHover();
      },
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
    this.pointerButtons = 0;
    this.cancel();
  };
  destroy() {
    if (this.destroyed) return;
    this.setActive(false);
    this.destroyed = true;
    this.options.onHover?.(null);
    this.u.over.style.touchAction = this.previousTouchAction;
    this.u.over.style.cursor = "";
    delete this.u.root.dataset.cursorPlacement;
    delete this.u.root.dataset.navigationTool;
    this.u.root.classList.remove("plot-navigation", "plot-pan-hover-hidden");
  }
}
