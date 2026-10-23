import OpenSeadragon from "openseadragon";
import { Api, type Run, type ImageFrame } from "./api";
import { boundedIndex, element, isAbort, message, Latest } from "./utils";
import { plotIcon, type PlotIconName } from "./plot-icons";
import type { ResolvedSeries } from "./workspace-types";
import "./cards.css";
import "./image-viewer.css";
interface Cached {
  url: string;
  bytes: number;
}
/** Visible region in viewport coordinates (image width = 1), plus orientation. */
export interface ImageCamera {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flip: boolean;
}
const editableTarget = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest(
    'input, select, textarea, button, [contenteditable]:not([contenteditable="false"])',
  );
export class ImagePanel {
  private viewer: OpenSeadragon.Viewer;
  private sources?: ResolvedSeries[];
  private lifetime = new AbortController();
  private destroyed = false;
  private resume = false;
  private resumeFrame = false;
  private metadataPending = false;
  private compact: boolean;
  private runs: Run[] = [];
  private frames: ImageFrame[] = [];
  private all: ImageFrame[] = [];
  private index = 0;
  private cache = new Map<string, Cached>();
  private displayed?: string;
  private requested?: string;
  private metadata = new Latest();
  private requests = new Latest();
  private frameAbort?: AbortController;
  private metadataAbort?: AbortController;
  private prefetchAbort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private playing = false;
  private active = false;
  private needsHome = true;
  private runSelect = element("select");
  private keySelect = element("select");
  private slider = element("input");
  private info = element("div", "frame-info");
  private status = element("div", "image-frame-status");
  private play = element("button", "", "Play");
  private speed = element("select");
  private cameraInfo = element("div", "muted camera-info");
  /** Camera to apply instead of "home" when the first frame lands. */
  private pendingCamera?: ImageCamera;
  private space = false;
  private crop = element("div", "image-crop-selection");
  constructor(
    private host: HTMLElement,
    private api: Api,
    options: { compact?: boolean } = {},
  ) {
    this.compact = options.compact ?? false;
    this.host.classList.add("card-image-panel");
    this.host.classList.toggle("card-image-compact", this.compact);
    const toolbar = element("div", "card-image-toolbar");
    const timeline = element("div", "card-image-timeline");
    const extras = element("details", "card-image-more");
    const extrasSummary = element("summary", "", "More");
    extrasSummary.setAttribute("aria-label", "More image controls");
    extrasSummary.title = "More image controls";
    extras.append(extrasSummary);
    const extraControls = element("div", "card-image-menu");
    extras.append(extraControls);
    this.runSelect.setAttribute("aria-label", "Image run");
    this.keySelect.setAttribute("aria-label", "Image key");
    toolbar.append(this.runSelect, this.keySelect);
    const button = (label: string, fn: () => void, icon?: PlotIconName) => {
      const b = element("button", "", label);
      b.type = "button";
      b.title = label;
      b.setAttribute("aria-label", label);
      b.onclick = fn;
      // Compact cards use the same SVG icon vocabulary as scalar cards.
      if (icon && this.compact) {
        b.replaceChildren(plotIcon(icon));
        b.classList.add("card-image-icon");
      }
      toolbar.append(b);
      return b;
    };
    const previous = button("← Previous", () => void this.step(-1), "previous");
    const next = button("Next →", () => void this.step(1), "next");
    if (this.compact) {
      extrasSummary.replaceChildren(plotIcon("more"));
      extrasSummary.classList.add("card-image-icon");
      this.play.classList.add("card-image-icon");
      this.play.title = "Play";
      this.play.replaceChildren(plotIcon("play"));
    }
    timeline.append(previous, this.play, next);
    this.play.onclick = () => this.togglePlay();
    this.play.type = "button";
    this.play.setAttribute("aria-label", "Play image timeline");
    for (const [value, label] of [
      ["1000", "1 fps"],
      ["500", "2 fps"],
      ["200", "5 fps"],
      ["100", "10 fps"],
    ]) {
      const o = element("option", "", label);
      o.value = value;
      this.speed.append(o);
    }
    extraControls.append(this.speed);
    this.speed.setAttribute("aria-label", "Playback rate");
    button("Zoom out", () => this.viewer.viewport.zoomBy(1 / 1.5), "zoom-out");
    button("Zoom in", () => this.viewer.viewport.zoomBy(1.5), "zoom-in");
    if (!this.compact) {
      toolbar.lastElementChild!.textContent = "+";
      toolbar.lastElementChild!.previousElementSibling!.textContent = "−";
    }
    button(
      this.compact ? "Fit" : "Reset view",
      () => this.viewer.viewport.goHome(),
      "fit-image",
    );
    button(
      "1:1 pixels",
      () => {
        const item = this.viewer.world.getItemAt(0);
        if (item)
          this.viewer.viewport.zoomTo(
            item.imageToViewportZoom(1),
            undefined,
            true,
          );
      },
      "actual-size",
    );
    let smoothPixels = true;
    const sampling = button("Pixels: smooth", () => {
      smoothPixels = !smoothPixels;
      this.viewer.drawer.setImageSmoothingEnabled(smoothPixels);
      this.viewer.forceRedraw();
      sampling.textContent = smoothPixels
        ? "Pixels: smooth"
        : "Pixels: nearest";
    });
    sampling.title =
      "Choose smooth resampling or nearest-pixel rendering at high magnification";
    const rotate = button("Rotate ↻", () =>
      this.viewer.viewport.setRotation(
        (this.viewer.viewport.getRotation() + 90) % 360,
      ),
    );
    const flip = button("Flip ↔", () =>
      this.viewer.viewport.setFlip(!this.viewer.viewport.getFlip()),
    );
    extraControls.append(sampling, rotate, flip);
    toolbar.append(extras);
    const fullscreen = button("Fullscreen", () => {
      const transition =
        document.fullscreenElement === this.host
          ? document.exitFullscreen()
          : this.host.requestFullscreen();
      void transition.catch((error) => {
        this.status.textContent = `Fullscreen unavailable: ${message(error)}`;
      });
    });
    fullscreen.hidden = this.compact;
    this.host.addEventListener(
      "fullscreenchange",
      () => {
        fullscreen.textContent =
          document.fullscreenElement === this.host
            ? "Exit fullscreen"
            : "Fullscreen";
        this.viewer.forceResize();
      },
      { signal: this.lifetime.signal },
    );
    const canvas = element("div", "image-canvas");
    canvas.dataset.role = "image-viewer";
    canvas.title =
      "Drag to zoom to a region · right-drag or Space+drag to pan · Ctrl+scroll to zoom · double-click to fit";
    canvas.setAttribute("aria-label", "Native resolution image viewport");
    canvas.tabIndex = 0;
    this.slider.type = "range";
    this.slider.min = "0";
    this.slider.max = "0";
    this.slider.value = "0";
    this.slider.setAttribute("aria-label", "Image frame timeline");
    this.slider.oninput = () => {
      this.stop();
      void this.show(Number(this.slider.value));
    };
    timeline.append(this.slider, this.info);
    this.host.append(toolbar, canvas, timeline, this.cameraInfo);
    this.status.setAttribute("role", "status");
    this.cameraInfo.hidden = this.compact;
    this.viewer = OpenSeadragon({
      element: canvas,
      showNavigationControl: false,
      showNavigator: false,
      preserveViewport: true,
      visibilityRatio: 0.1,
      minZoomImageRatio: 0.5,
      maxZoomPixelRatio: 8,
      animationTime: 0.15,
      blendTime: 0,
      crossOriginPolicy: false,
      gestureSettingsMouse: {
        clickToZoom: false,
        scrollToZoom: false,
        dblClickToZoom: false,
        // Mouse drags are handled below (crop-zoom / right or Space pan).
        dragToPan: false,
        flickEnabled: false,
      },
    });
    canvas.append(this.status);
    this.crop.hidden = true;
    canvas.append(this.crop);
    this.installPointerNavigation(canvas);
    this.viewer.addHandler("canvas-scroll", (event) => {
      // OpenSeadragon must not consume ordinary dashboard scrolling.
      (event as unknown as { preventDefault: boolean }).preventDefault = false;
    });
    canvas.addEventListener(
      "wheel",
      (event) => {
        if (!(event.altKey || event.ctrlKey) || !this.active) return;
        if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
        const viewport = this.viewer.viewport;
        const rect = this.viewer.container.getBoundingClientRect();
        const size = viewport.getContainerSize();
        if (rect.width <= 0 || rect.height <= 0) return;
        const position = new OpenSeadragon.Point(
          ((event.clientX - rect.left) * size.x) / rect.width,
          ((event.clientY - rect.top) * size.y) / rect.height,
        );
        // Match OSD's native scroll handler: flip screen x before its
        // rotation-aware conversion, using the current animated camera.
        if (viewport.getFlip()) position.x = size.x - position.x;
        const reference = viewport.pointFromPixel(position, true);
        // Retain pixel-wheel sensitivity; normalize line/page devices and
        // bound finite extreme deltas before exponentiation can overflow.
        const unit =
          event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? size.y
              : 1;
        const exponent = Math.max(
          -4,
          Math.min(4, -event.deltaY * unit * 0.002),
        );
        event.preventDefault();
        viewport.zoomBy(Math.exp(exponent), reference);
        viewport.applyConstraints();
      },
      { passive: false, signal: this.lifetime.signal },
    );
    const updateCamera = () => {
      const item = this.viewer.world.getItemAt(0);
      if (!item) {
        this.cameraInfo.textContent = "No image camera";
        delete canvas.dataset.zoom;
        delete canvas.dataset.centerX;
        delete canvas.dataset.centerY;
        return;
      }
      const zoom = this.viewer.viewport.getZoom(true);
      const center = this.viewer.viewport.getCenter(true);
      const size = item.getContentSize();
      canvas.dataset.zoom = String(zoom);
      canvas.dataset.centerX = String(center.x);
      canvas.dataset.centerY = String(center.y);
      canvas.dataset.pixelZoom = String(item.viewportToImageZoom(zoom));
      this.cameraInfo.textContent = `${size.x} × ${size.y} native pixels · ${(item.viewportToImageZoom(zoom) * 100).toFixed(1)}% pixel magnification · pan/zoom retained while scrubbing`;
    };
    for (const name of [
      "viewport-change",
      "animation",
      "resize",
      "open",
      "close",
    ] as const) {
      this.viewer.addHandler(name, updateCamera);
    }
    this.viewer.world.addHandler("add-item", updateCamera);
    this.viewer.world.addHandler("remove-item", updateCamera);
    this.runSelect.onchange = () => void this.load();
    this.keySelect.onchange = () => this.filter();
    this.host.addEventListener(
      "keydown",
      (e) => {
        if (
          !this.active ||
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLSelectElement ||
          e.target instanceof HTMLTextAreaElement
        )
          return;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          this.stop();
          void this.step(e.key === "ArrowLeft" ? -1 : 1);
        }
      },
      { signal: this.lifetime.signal },
    );
  }
  setActive(active: boolean) {
    if (this.destroyed || this.active === active) return;
    this.active = active;
    if (!active) {
      this.resume = this.metadataPending;
      this.resumeFrame =
        !this.resume && !!this.requested && this.requested !== this.displayed;
      this.metadataPending = false;
      this.stop();
      this.metadata.next();
      this.requests.next();
      this.metadataAbort?.abort();
      this.frameAbort?.abort();
      this.prefetchAbort?.abort();
    } else
      requestAnimationFrame(() => {
        if (this.destroyed || !this.active) return;
        if (this.resume) {
          this.resume = false;
          void this.load();
          return;
        }
        if (this.resumeFrame) {
          this.resumeFrame = false;
          void this.show(this.index);
        }
        if (this.active && this.needsHome && this.displayed) {
          this.viewer.viewport.resize(
            new OpenSeadragon.Point(
              this.viewer.container.clientWidth,
              this.viewer.container.clientHeight,
            ),
            true,
          );
          this.home();
          this.needsHome = false;
        }
      });
  }
  setSources(sources: ResolvedSeries[]): void {
    this.sources = sources.filter((source) => source.kind === "image");
    const previous = this.runSelect.value;
    this.runs = [
      ...new Map(
        this.sources.map((source) => [source.runId, source.run]),
      ).values(),
    ];
    this.runSelect.replaceChildren();
    for (const run of this.runs) {
      const option = element("option", "", run.name);
      option.value = run.id;
      this.runSelect.append(option);
    }
    if (this.runs.some((run) => run.id === previous))
      this.runSelect.value = previous;
    this.runSelect.hidden = this.compact && this.runs.length <= 1;
    void this.load();
  }
  setRuns(runs: Run[]) {
    this.sources = undefined;
    const previous = this.runSelect.value;
    this.runs = runs;
    this.runSelect.replaceChildren();
    for (const run of runs) {
      const option = element("option", "", run.name);
      option.value = run.id;
      this.runSelect.append(option);
    }
    if (runs.some((r) => r.id === previous)) this.runSelect.value = previous;
    if (this.runSelect.value !== previous || !runs.length) void this.load();
  }
  async refresh() {
    await this.load();
  }
  /** Fit the current image without clearing its source, frame, or cache. */
  fit(): void {
    this.viewer.viewport.goHome();
  }
  /** Current visible region, or null before a frame is shown. */
  camera(): ImageCamera | null {
    if (!this.displayed || !this.viewer.world.getItemCount()) return null;
    const viewport = this.viewer.viewport;
    const b = viewport.getBounds(true);
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
    return {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      rotation: viewport.getRotation(true),
      flip: viewport.getFlip(),
    };
  }
  /** Show a region handed over from another panel (fit to this viewport's aspect). */
  setCamera(camera: ImageCamera | null | undefined): void {
    if (!camera) return;
    if (this.displayed && this.active && !this.needsHome)
      this.applyCamera(camera);
    else this.pendingCamera = camera;
  }
  private applyCamera(camera: ImageCamera) {
    const viewport = this.viewer.viewport;
    viewport.setRotation(camera.rotation, true);
    viewport.setFlip(camera.flip);
    // getBounds() reports the rotated region; fitBounds() undoes that rotation,
    // then fits the limiting dimension without distorting the image.
    viewport.fitBounds(
      new OpenSeadragon.Rect(
        camera.x,
        camera.y,
        camera.width,
        camera.height,
        -camera.rotation,
      ),
      true,
    );
  }
  private home() {
    const camera = this.pendingCamera;
    this.pendingCamera = undefined;
    if (camera) this.applyCamera(camera);
    else this.viewer.viewport.goHome(true);
  }
  /**
   * Mouse/pen use the same scheme as scalar plots: drag selects a region to
   * zoom into, right-drag or Space+drag pans, double-click fits. Touch keeps
   * OpenSeadragon's native pan/pinch.
   */
  private installPointerNavigation(canvas: HTMLElement) {
    const signal = this.lifetime.signal;
    const MIN_DRAG = 3;
    let drag:
      | {
          id: number;
          x: number;
          y: number;
          mode: "zoom" | "pan";
          center: OpenSeadragon.Point;
          moved: boolean;
        }
      | undefined;
    const local = (e: PointerEvent | MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
        y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
        w: r.width,
        h: r.height,
      };
    };
    const hovered = () => canvas.matches(":hover");
    const cursor = () => {
      canvas.style.cursor =
        drag?.mode === "pan" ? "grabbing" : this.space ? "grab" : "crosshair";
    };
    const finish = (e: PointerEvent | null, commit: boolean) => {
      const g = drag;
      if (!g || (e && e.pointerId !== g.id)) return;
      drag = undefined;
      this.crop.hidden = true;
      canvas.classList.remove("image-selecting");
      try {
        if (canvas.hasPointerCapture(g.id)) canvas.releasePointerCapture(g.id);
      } catch {
        /* capture already gone */
      }
      cursor();
      const viewport = this.viewer.viewport;
      if (g.mode === "pan") {
        if (!commit) viewport.panTo(g.center, true);
        viewport.applyConstraints();
        return;
      }
      if (!commit || !e || !g.moved) return;
      const p = local(e);
      const sw = Math.abs(p.x - g.x),
        sh = Math.abs(p.y - g.y);
      if (sw < MIN_DRAG || sh < MIN_DRAG || !p.w || !p.h) return;
      // Fit the selected screen rectangle to this viewport, limited by
      // whichever dimension runs out first; the image is never stretched.
      const size = viewport.getContainerSize();
      const scaleX = size.x / p.w,
        scaleY = size.y / p.h;
      const centerPixel = new OpenSeadragon.Point(
        ((p.x + g.x) / 2) * scaleX,
        ((p.y + g.y) / 2) * scaleY,
      );
      if (viewport.getFlip()) centerPixel.x = size.x - centerPixel.x;
      const center = viewport.pointFromPixel(centerPixel, true);
      const factor = Math.min(p.w / sw, p.h / sh);
      viewport.panTo(center, false);
      viewport.zoomTo(viewport.getZoom(true) * factor, undefined, false);
      viewport.applyConstraints();
    };
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), {
      signal,
    });
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (
          e.pointerType === "touch" ||
          !this.active ||
          drag ||
          (e.button !== 0 && e.button !== 2) ||
          editableTarget(e.target) ||
          !this.viewer.world.getItemCount()
        )
          return;
        const p = local(e);
        drag = {
          id: e.pointerId,
          x: p.x,
          y: p.y,
          mode: e.button === 2 || this.space ? "pan" : "zoom",
          center: this.viewer.viewport.getCenter(true),
          moved: false,
        };
        // Keep OpenSeadragon's tracker out of mouse gestures we own.
        e.preventDefault();
        e.stopPropagation();
        canvas.focus({ preventScroll: true });
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic events may not support capture */
        }
        cursor();
      },
      { signal, capture: true },
    );
    canvas.addEventListener(
      "pointermove",
      (e) => {
        const g = drag;
        if (!g || e.pointerId !== g.id) return;
        e.stopPropagation();
        const p = local(e);
        g.moved ||= Math.hypot(p.x - g.x, p.y - g.y) >= MIN_DRAG;
        if (!g.moved) return;
        if (g.mode === "pan") {
          const viewport = this.viewer.viewport;
          const size = viewport.getContainerSize();
          let dx = ((p.x - g.x) * size.x) / (p.w || 1);
          const dy = ((p.y - g.y) * size.y) / (p.h || 1);
          if (viewport.getFlip()) dx = -dx;
          const delta = viewport.deltaPointsFromPixels(
            new OpenSeadragon.Point(-dx, -dy),
            true,
          );
          viewport.panTo(g.center.plus(delta), true);
        } else {
          canvas.classList.add("image-selecting");
          this.crop.hidden = false;
          Object.assign(this.crop.style, {
            left: `${Math.min(p.x, g.x)}px`,
            top: `${Math.min(p.y, g.y)}px`,
            width: `${Math.abs(p.x - g.x)}px`,
            height: `${Math.abs(p.y - g.y)}px`,
          });
        }
      },
      { signal, capture: true },
    );
    canvas.addEventListener(
      "pointerup",
      (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        e.stopPropagation();
        finish(e, true);
      },
      { signal, capture: true },
    );
    for (const type of ["pointercancel", "lostpointercapture"] as const)
      canvas.addEventListener(type, (e) => finish(e, false), { signal });
    canvas.addEventListener(
      "dblclick",
      (e) => {
        if (editableTarget(e.target)) return;
        e.preventDefault();
        this.viewer.viewport.goHome();
      },
      { signal },
    );
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && drag) {
          finish(null, false);
          return;
        }
        if (
          e.code !== "Space" ||
          !this.active ||
          e.ctrlKey ||
          e.metaKey ||
          e.altKey ||
          editableTarget(e.target)
        )
          return;
        if (!hovered() && !drag) return;
        e.preventDefault();
        if (!this.space) {
          this.space = true;
          cursor();
        }
      },
      { signal },
    );
    const releaseSpace = () => {
      if (!this.space) return;
      this.space = false;
      cursor();
    };
    window.addEventListener(
      "keyup",
      (e) => {
        if (e.code === "Space") releaseSpace();
      },
      { signal },
    );
    window.addEventListener(
      "blur",
      () => {
        releaseSpace();
        finish(null, false);
      },
      { signal },
    );
    cursor();
  }

  private clearFrameInfo() {
    this.info.textContent = "No frame loaded";
    this.info.removeAttribute("data-step");
    this.info.removeAttribute("title");
  }
  private reset() {
    this.stop();
    this.requests.next();
    this.frameAbort?.abort();
    this.prefetchAbort?.abort();
    this.viewer.close();
    this.clearFrameInfo();
    this.displayed = undefined;
    this.requested = undefined;
    this.needsHome = true;
    for (const entry of this.cache.values()) URL.revokeObjectURL(entry.url);
    this.cache.clear();
    this.frames = [];
    this.all = [];
    this.slider.max = "0";
    this.slider.value = "0";
    this.slider.disabled = true;
  }
  private async load() {
    if (this.destroyed) return;
    this.resume = false;
    this.resumeFrame = false;
    const previousKey = this.keySelect.value;
    const generation = this.metadata.next();
    this.metadataAbort?.abort();
    this.metadataAbort = new AbortController();
    this.reset();
    this.keySelect.replaceChildren();
    const run = this.runSelect.value;
    if (!run) {
      this.status.textContent = "No images selected";
      return;
    }
    this.status.textContent = "Loading image metadata…";
    this.metadataPending = true;
    try {
      const response = await this.api.json<{ images: ImageFrame[] }>(
        `/runs/${encodeURIComponent(run)}/images`,
        this.metadataAbort.signal,
      );
      if (!this.metadata.current(generation)) return;
      this.all = response.images;
      const keys = this.sources
        ? [
            ...new Set(
              this.sources
                .filter((source) => source.runId === run)
                .map((source) => source.key),
            ),
          ]
        : [...new Set(this.all.map((f) => f.key))].sort();
      for (const key of keys) {
        const o = element("option", "", key);
        o.value = key;
        this.keySelect.append(o);
      }
      if (keys.includes(previousKey)) this.keySelect.value = previousKey;
      this.keySelect.hidden = this.compact && keys.length <= 1;
      this.filter();
    } catch (error) {
      if (this.metadata.current(generation) && !isAbort(error))
        this.status.textContent = message(error);
    } finally {
      if (this.metadata.current(generation)) this.metadataPending = false;
    }
  }
  private filter() {
    this.stop();
    this.requests.next();
    this.frameAbort?.abort();
    this.prefetchAbort?.abort();
    this.viewer.close();
    this.clearFrameInfo();
    this.displayed = undefined;
    this.requested = undefined;
    this.needsHome = true;
    this.frames = this.all.filter((f) => f.key === this.keySelect.value);
    this.slider.max = String(Math.max(0, this.frames.length - 1));
    this.slider.disabled = !this.frames.length;
    if (this.frames.length) void this.show(0);
    else {
      this.status.textContent = "No images found";
    }
  }
  private async blob(frame: ImageFrame, signal: AbortSignal): Promise<Cached> {
    const hit = this.cache.get(frame.id);
    if (hit) {
      this.cache.delete(frame.id);
      this.cache.set(frame.id, hit);
      return hit;
    }
    const response = await this.api.response(
      `/images/${encodeURIComponent(frame.id)}/content`,
      signal,
    );
    const blob = await response.blob();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (!["image/png", "image/jpeg", "image/webp"].includes(blob.type))
      throw new Error(
        "Unsupported image response; expected PNG, JPEG or WebP.",
      );
    const entry = { url: URL.createObjectURL(blob), bytes: blob.size };
    const raced = this.cache.get(frame.id);
    if (raced) {
      URL.revokeObjectURL(entry.url);
      return raced;
    }
    this.cache.set(frame.id, entry);
    this.evict(frame.id);
    return entry;
  }
  private evict(protect?: string) {
    let bytes = 0;
    for (const c of this.cache.values()) bytes += c.bytes;
    for (const [id, entry] of this.cache) {
      if (this.cache.size <= 6 && bytes <= 64 * 1024 * 1024) break;
      if (id === this.displayed || id === this.requested || id === protect)
        continue;
      URL.revokeObjectURL(entry.url);
      this.cache.delete(id);
      bytes -= entry.bytes;
    }
  }
  async show(requested: number): Promise<void> {
    if (this.destroyed || !this.frames.length) return;
    const index = boundedIndex(requested, this.frames.length);
    this.index = index;
    this.slider.value = String(index);
    const frame = this.frames[index];
    this.requested = frame.id;
    this.prefetchAbort?.abort();
    const generation = this.requests.next();
    this.frameAbort?.abort();
    const controller = new AbortController();
    this.frameAbort = controller;
    // Keep the last decoded image and metadata visible while preparing.
    this.status.textContent = "";
    try {
      const entry = await this.blob(frame, controller.signal);
      if (!this.requests.current(generation)) return;
      const itemOpened = await this.prepare(entry.url, controller.signal);
      if (!this.requests.current(generation)) {
        this.viewer.world.removeItem(itemOpened);
        return;
      }
      const bounds = this.viewer.viewport.getBounds(true);
      const first = !this.displayed;
      // Both changes land in one draw; never expose an empty world or an
      // undecoded replacement, including frames with transparent pixels.
      itemOpened.setOpacity(1);
      for (let i = this.viewer.world.getItemCount() - 1; i >= 0; i--) {
        const item = this.viewer.world.getItemAt(i);
        if (item !== itemOpened) this.viewer.world.removeItem(item);
      }
      if (first) {
        if (this.active) {
          this.viewer.viewport.resize(
            new OpenSeadragon.Point(
              this.viewer.container.clientWidth,
              this.viewer.container.clientHeight,
            ),
            true,
          );
          this.home();
          this.needsHome = false;
        } else this.needsHome = true;
      } else this.viewer.viewport.fitBounds(bounds, true);
      this.displayed = frame.id;
      this.viewer.forceRedraw();
      this.info.textContent = `${this.runs.find((r) => r.id === frame.run_id)?.name ?? "Run"} / ${frame.key}  ·  step ${frame.step}  ·  ${new Date(frame.timestamp).toISOString()}  ·  ${index + 1} of ${this.frames.length}`;
      if (this.compact) {
        this.info.textContent = `Step ${frame.step} · ${index + 1} / ${this.frames.length}`;
        this.info.title = `${this.runs.find((run) => run.id === frame.run_id)?.name ?? "Run"} · ${frame.key} · ${new Date(frame.timestamp).toISOString()}`;
      }
      this.info.dataset.step = String(frame.step);
      this.evict(frame.id);
      if (!this.requests.current(generation)) return;
      this.prefetchAbort?.abort();
      const prefetch = new AbortController();
      this.prefetchAbort = prefetch;
      const next = this.frames[index + 1];
      if (next)
        void this.blob(next, prefetch.signal)
          .then(() => this.evict(frame.id))
          .catch(() => {});
    } catch (error) {
      if (this.requests.current(generation) && !isAbort(error)) {
        const failed = this.cache.get(frame.id);
        if (failed && frame.id !== this.displayed) {
          URL.revokeObjectURL(failed.url);
          this.cache.delete(frame.id);
        }
        if (!this.displayed) this.info.textContent = "Frame unavailable";
        this.status.textContent = `Frame unavailable: ${message(error)}`;
        this.stop();
      }
    }
  }
  /** Invisible staging; cancellation settles even during decode. */
  private prepare(
    url: string,
    signal: AbortSignal,
  ): Promise<OpenSeadragon.TiledImage> {
    return new Promise((resolve, reject) => {
      let item: OpenSeadragon.TiledImage | undefined;
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        item?.removeHandler("fully-loaded-change", ready);
        this.viewer.removeHandler("tile-load-failed", failed);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (item) this.viewer.world.removeItem(item);
        reject(error);
      };
      const abort = () => fail(new DOMException("Aborted", "AbortError"));
      const ready = () => {
        if (settled || !item?.getFullyLoaded()) return;
        if (signal.aborted) return abort();
        settled = true;
        cleanup();
        resolve(item);
      };
      const failed = (event: OpenSeadragon.ViewerEvent) => {
        if (
          (event as unknown as { tiledImage: OpenSeadragon.TiledImage })
            .tiledImage === item
        )
          fail(new Error("Image decoder could not load this frame."));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      const decoded = new Image();
      decoded.src = url;
      void decoded.decode().then(
        () => {
          if (settled) return;
          this.viewer.addHandler("tile-load-failed", failed);
          this.viewer.addTiledImage({
            tileSource: { type: "image", url, buildPyramid: false },
            opacity: 0,
            preload: true,
            success: (event) => {
              const opened = (
                event as unknown as { item: OpenSeadragon.TiledImage }
              ).item;
              if (settled) {
                if (!this.destroyed) this.viewer.world.removeItem(opened);
                return;
              }
              item = opened;
              item.addHandler("fully-loaded-change", ready);
              ready();
            },
            error: () =>
              fail(new Error("Image decoder could not open this frame.")),
          });
        },
        () => fail(new Error("Image decoder could not decode this frame.")),
      );
    });
  }
  private async step(delta: number) {
    await this.show(this.index + delta);
  }
  private stop() {
    this.playing = false;
    clearTimeout(this.timer);
    if (this.compact) {
      this.play.replaceChildren(plotIcon("play"));
      this.play.title = "Play";
    } else this.play.textContent = "Play";
    this.play.setAttribute("aria-pressed", "false");
  }
  private togglePlay() {
    if (this.playing) {
      this.stop();
      return;
    }
    if (!this.frames.length) return;
    this.playing = true;
    if (this.compact) {
      this.play.replaceChildren(plotIcon("pause"));
      this.play.title = "Pause";
    } else this.play.textContent = "Pause";
    this.play.setAttribute("aria-pressed", "true");
    const advance = async () => {
      if (!this.playing) return;
      if (this.index >= this.frames.length - 1) {
        this.stop();
        return;
      }
      await this.step(1);
      if (this.playing)
        this.timer = setTimeout(() => void advance(), Number(this.speed.value));
    };
    this.timer = setTimeout(() => void advance(), Number(this.speed.value));
  }
  clear() {
    this.resume = false;
    this.resumeFrame = false;
    this.metadataPending = false;
    this.metadata.next();
    this.metadataAbort?.abort();
    this.reset();
    this.runSelect.replaceChildren();
    this.keySelect.replaceChildren();
    this.status.textContent = "Disconnected";
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lifetime.abort();
    this.clear();
    this.viewer.destroy();
    this.host.classList.remove("card-image-panel", "card-image-compact");
    this.host.replaceChildren();
  }
}
