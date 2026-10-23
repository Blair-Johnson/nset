import OpenSeadragon from "openseadragon";
import { Api, type Run, type ImageFrame } from "./api";
import { boundedIndex, element, isAbort, message, Latest } from "./utils";
interface Cached {
  url: string;
  bytes: number;
}
export class ImagePanel {
  private viewer: OpenSeadragon.Viewer;
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
  private status = element("div", "muted");
  private play = element("button", "", "Play");
  private speed = element("select");
  private cameraInfo = element("div", "muted camera-info");
  constructor(
    private host: HTMLElement,
    private api: Api,
  ) {
    const toolbar = element("div", "toolbar");
    this.runSelect.setAttribute("aria-label", "Image run");
    this.keySelect.setAttribute("aria-label", "Image key");
    toolbar.append(this.runSelect, this.keySelect);
    const button = (label: string, fn: () => void) => {
      const b = element("button", "", label);
      b.type = "button";
      b.onclick = fn;
      toolbar.append(b);
      return b;
    };
    button("← Previous", () => void this.step(-1));
    button("Next →", () => void this.step(1));
    this.play.onclick = () => this.togglePlay();
    toolbar.append(this.play);
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
    toolbar.append(this.speed);
    this.speed.setAttribute("aria-label", "Playback rate");
    button("Reset view", () => this.viewer.viewport.goHome());
    button("1:1 pixels", () => {
      const item = this.viewer.world.getItemAt(0);
      if (item)
        this.viewer.viewport.zoomTo(
          item.imageToViewportZoom(1),
          undefined,
          true,
        );
    });
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
    button("Rotate ↻", () =>
      this.viewer.viewport.setRotation(
        (this.viewer.viewport.getRotation() + 90) % 360,
      ),
    );
    button("Flip ↔", () =>
      this.viewer.viewport.setFlip(!this.viewer.viewport.getFlip()),
    );
    const fullscreen = button("Fullscreen", () => {
      const transition =
        document.fullscreenElement === this.host
          ? document.exitFullscreen()
          : this.host.requestFullscreen();
      void transition.catch((error) => {
        this.status.textContent = `Fullscreen unavailable: ${message(error)}`;
      });
    });
    this.host.addEventListener("fullscreenchange", () => {
      fullscreen.textContent =
        document.fullscreenElement === this.host
          ? "Exit fullscreen"
          : "Fullscreen";
      this.viewer.forceResize();
    });
    const canvas = element("div", "image-canvas");
    canvas.id = "image-viewer";
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
    this.host.append(
      toolbar,
      this.info,
      canvas,
      this.slider,
      this.status,
      this.cameraInfo,
      element(
        "p",
        "hint",
        "Native pixels · scroll to zoom, drag to pan · ← / → step frames · viewport retained across frames. One run/key at a time.",
      ),
    );
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
      gestureSettingsMouse: { clickToZoom: false },
    });
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
    this.host.addEventListener("keydown", (e) => {
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
    });
  }
  setActive(active: boolean) {
    this.active = active;
    if (!active) this.stop();
    else
      requestAnimationFrame(() => {
        if (this.active && this.needsHome && this.displayed) {
          this.viewer.viewport.resize(
            new OpenSeadragon.Point(
              this.viewer.container.clientWidth,
              this.viewer.container.clientHeight,
            ),
            true,
          );
          this.viewer.viewport.goHome(true);
          this.needsHome = false;
        }
      });
  }
  setRuns(runs: Run[]) {
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
  private reset() {
    this.stop();
    this.requests.next();
    this.frameAbort?.abort();
    this.prefetchAbort?.abort();
    this.viewer.close();
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
    this.info.textContent = "No frame loaded";
  }
  private async load() {
    const generation = this.metadata.next();
    this.metadataAbort?.abort();
    this.metadataAbort = new AbortController();
    this.reset();
    this.keySelect.replaceChildren();
    const run = this.runSelect.value;
    if (!run) {
      this.status.textContent = "Select a run to inspect image artifacts.";
      return;
    }
    this.status.textContent = "Loading image metadata…";
    try {
      const response = await this.api.json<{ images: ImageFrame[] }>(
        `/runs/${encodeURIComponent(run)}/images`,
        this.metadataAbort.signal,
      );
      if (!this.metadata.current(generation)) return;
      this.all = response.images;
      const keys = [...new Set(this.all.map((f) => f.key))].sort();
      for (const key of keys) {
        const o = element("option", "", key);
        o.value = key;
        this.keySelect.append(o);
      }
      this.filter();
    } catch (error) {
      if (this.metadata.current(generation) && !isAbort(error))
        this.status.textContent = message(error);
    }
  }
  private filter() {
    this.stop();
    this.requests.next();
    this.frameAbort?.abort();
    this.prefetchAbort?.abort();
    this.frames = this.all.filter((f) => f.key === this.keySelect.value);
    this.slider.max = String(Math.max(0, this.frames.length - 1));
    this.slider.disabled = !this.frames.length;
    if (this.frames.length) void this.show(0);
    else {
      this.viewer.close();
      this.info.textContent = "No images in this stream";
      this.status.textContent =
        "Log PNG, JPEG or WebP image artifacts to populate the timeline.";
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
    if (!this.frames.length) return;
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
    this.status.textContent = `Loading frame ${index + 1}/${this.frames.length}…`;
    try {
      const entry = await this.blob(frame, controller.signal);
      if (!this.requests.current(generation)) return;
      await new Promise<void>((resolve, reject) => {
        this.viewer.addTiledImage({
          tileSource: { type: "image", url: entry.url, buildPyramid: false },
          success: (event) => {
            const itemOpened = (
              event as unknown as { item: OpenSeadragon.TiledImage }
            ).item;
            if (!this.requests.current(generation)) {
              this.viewer.world.removeItem(itemOpened);
              resolve();
              return;
            }
            const bounds = this.viewer.viewport.getBounds(true);
            const first = !this.displayed;
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
                this.viewer.viewport.goHome(true);
                this.needsHome = false;
              } else this.needsHome = true;
            } else this.viewer.viewport.fitBounds(bounds, true);
            this.displayed = frame.id;
            this.info.textContent = `${this.runs.find((r) => r.id === frame.run_id)?.name ?? "Run"} / ${frame.key}  ·  step ${frame.step}  ·  ${new Date(frame.timestamp).toISOString()}  ·  ${index + 1} of ${this.frames.length}`;
            this.status.textContent = `${frame.content_type} · ${(frame.byte_length / 1024).toFixed(1)} KiB · native resolution · ${this.cache.size} cached frames`;
            this.evict(frame.id);
            resolve();
          },
          error: () =>
            reject(new Error("Image decoder could not open this frame.")),
        });
      });
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
        this.status.textContent = message(error);
        this.stop();
      }
    }
  }
  private async step(delta: number) {
    await this.show(this.index + delta);
  }
  private stop() {
    this.playing = false;
    clearTimeout(this.timer);
    this.play.textContent = "Play";
  }
  private togglePlay() {
    if (this.playing) {
      this.stop();
      return;
    }
    if (!this.frames.length) return;
    this.playing = true;
    this.play.textContent = "Pause";
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
    this.metadata.next();
    this.metadataAbort?.abort();
    this.reset();
    this.runSelect.replaceChildren();
    this.keySelect.replaceChildren();
    this.status.textContent = "Disconnected";
  }
  destroy() {
    this.clear();
    this.viewer.destroy();
  }
}
