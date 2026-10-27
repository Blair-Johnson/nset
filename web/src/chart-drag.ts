export interface ChartDropTarget {
  sectionId: string;
  id?: string;
  after: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DragOptions {
  valid(): boolean;
  target(x: number, y: number): ChartDropTarget | undefined;
  drop(target: ChartDropTarget): void;
}

/** In-page gesture: no native drag session, DataTransfer, or model edits during preview. */
export class ChartDrag {
  private gesture?: { valid(): boolean; cancel(): void };

  cancel(): void {
    this.gesture?.cancel();
  }

  validate(): void {
    if (this.gesture && !this.gesture.valid()) this.cancel();
  }

  begin(event: PointerEvent, header: HTMLElement, options: DragOptions): void {
    if (!event.isPrimary || event.button !== 0) return;
    this.cancel();
    event.preventDefault();
    const lifetime = new AbortController();
    const listeners = { signal: lifetime.signal };
    const pointer = event.pointerId;
    const startX = event.clientX,
      startY = event.clientY;
    let x = startX,
      y = startY,
      active = false,
      ended = false,
      frame = 0;
    const marker = document.createElement("div");
    marker.className = "card-drop-indicator";
    marker.setAttribute("aria-hidden", "true");
    const connected = () =>
      header.isConnected && header.getClientRects().length > 0;
    const valid = () => connected() && options.valid();
    const inside = () => x >= 0 && x < innerWidth && y >= 0 && y < innerHeight;
    const target = () => (inside() ? options.target(x, y) : undefined);
    const finish = (commit = false) => {
      if (ended) return;
      const next = active && commit && valid() ? target() : undefined;
      ended = true;
      this.gesture = undefined;
      lifetime.abort();
      cancelAnimationFrame(frame);
      if (header.hasPointerCapture(pointer))
        header.releasePointerCapture(pointer);
      marker.remove();
      header.classList.remove("card-reordering");
      document.body.classList.remove("chart-dragging");
      if (next) options.drop(next);
    };
    this.gesture = { valid, cancel: () => finish() };
    const preview = () => {
      if (!connected()) return finish();
      const next = target();
      if (!next) return marker.remove();
      Object.assign(marker.style, {
        left: `${next.left}px`,
        top: `${next.top}px`,
        width: `${next.width}px`,
        height: `${next.height}px`,
      });
      document.body.append(marker);
    };
    const scroll = () => {
      if (ended) return;
      if (inside()) {
        const speed = y < 48 ? -12 : y > innerHeight - 48 ? 12 : 0;
        if (speed) window.scrollBy(0, speed);
      }
      preview();
      if (!ended) frame = requestAnimationFrame(scroll);
    };
    window.addEventListener(
      "pointermove",
      (move) => {
        if (move.pointerId !== pointer) return;
        if (!(move.buttons & 1)) return finish();
        x = move.clientX;
        y = move.clientY;
        if (!active) {
          if (Math.hypot(x - startX, y - startY) < 6) return;
          if (!valid()) return finish();
          try {
            header.setPointerCapture(pointer);
          } catch {
            finish();
            return;
          }
          active = true;
          header.classList.add("card-reordering");
          document.body.classList.add("chart-dragging");
          // Suppress only the click synthesized by this drag, never keyboard activation.
          const clicks = new AbortController();
          document.addEventListener(
            "click",
            (click) => {
              if (!click.detail) return;
              click.preventDefault();
              click.stopImmediatePropagation();
              clicks.abort();
            },
            { capture: true, signal: clicks.signal },
          );
          document.addEventListener("pointerdown", () => clicks.abort(), {
            capture: true,
            once: true,
            signal: clicks.signal,
          });
          frame = requestAnimationFrame(scroll);
        }
        move.preventDefault();
        preview();
      },
      listeners,
    );
    window.addEventListener(
      "pointerup",
      (up) => {
        if (up.pointerId !== pointer) return;
        x = up.clientX;
        y = up.clientY;
        if (active) up.preventDefault();
        finish(true);
      },
      listeners,
    );
    window.addEventListener(
      "pointercancel",
      (cancel) => {
        if (cancel.pointerId === pointer) finish();
      },
      listeners,
    );
    header.addEventListener(
      "lostpointercapture",
      (lost) => {
        if (lost.pointerId === pointer && lost.target === header) finish();
      },
      listeners,
    );
    header.addEventListener(
      "dragstart",
      (drag) => drag.preventDefault(),
      listeners,
    );
    window.addEventListener("blur", () => finish(), listeners);
    window.addEventListener("resize", () => finish(), listeners);
    window.addEventListener("pagehide", () => finish(), listeners);
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) finish();
      },
      listeners,
    );
    document.addEventListener(
      "keydown",
      (key) => {
        if (key.key !== "Escape") return;
        if (active) key.preventDefault();
        finish();
      },
      { ...listeners, capture: true },
    );
    window.addEventListener("pointerdown", () => finish(), {
      ...listeners,
      capture: true,
    });
  }
}
