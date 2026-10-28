import { GestureScroll } from "./gesture-scroll";

type Drop = (id: string, targetId: string, after: boolean) => void;

/** Section-only pointer gesture. Never changes workspace collapse flags or chart DOM. */
export class SectionDrag {
  private cancelGesture?: () => void;

  cancel(): void {
    this.cancelGesture?.();
  }

  bind(dashboard: HTMLElement, drop: Drop): void {
    dashboard.onpointerdown = (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const header = target.closest<HTMLElement>(".section-heading");
      if (!header || header.parentElement?.parentElement !== dashboard) return;
      // The title is a fold button; only the non-control header area drags.
      if (
        target.closest(
          ".menu,summary,a,input,select,textarea,[contenteditable],[role=button],button",
        )
      )
        return;
      const sections = [
        ...dashboard.querySelectorAll<HTMLElement>(":scope > .chart-section"),
      ].filter((node) => !node.hidden && node.getClientRects().length);
      if (sections.length < 2) return;
      this.cancel();
      this.begin(event, dashboard, header, sections, drop);
    };
  }

  private begin(
    event: PointerEvent,
    dashboard: HTMLElement,
    header: HTMLElement,
    sections: HTMLElement[],
    drop: Drop,
  ): void {
    const source = header.parentElement!;
    const lifetime = new AbortController();
    const options = { signal: lifetime.signal };
    const pointer = event.pointerId;
    const startX = event.clientX,
      startY = event.clientY;
    const scrollport = new GestureScroll(dashboard);
    const scrollX = scrollport.x,
      scrollY = scrollport.y;
    let x = startX,
      y = startY,
      active = false,
      frame = 0;
    let toggles: {
      node: HTMLElement;
      text: string;
      expanded: string | null;
    }[] = [];
    const marker = document.createElement("div");
    marker.className = "section-drop-indicator";
    marker.setAttribute("aria-hidden", "true");
    const slot = () => {
      if (!scrollport.contains(x, y)) return;
      const headers = sections.map((node) => ({
        id: node.dataset.sectionId!,
        rect: node
          .querySelector<HTMLElement>(".section-heading")!
          .getBoundingClientRect(),
      }));
      const first = headers[0].rect,
        last = headers.at(-1)!.rect;
      const hit = document.elementFromPoint(x, y);
      if (
        !hit ||
        !dashboard.contains(hit) ||
        x < first.left ||
        x > first.right ||
        y < first.top - 12 ||
        y > last.bottom + 12
      )
        return;
      const target =
        headers.find(({ rect }) => y <= rect.bottom + 6) ?? headers.at(-1)!;
      const after = y >= target.rect.top + target.rect.height / 2;
      return { ...target, after };
    };
    const preview = () => {
      const next = slot();
      if (!next) return marker.remove();
      Object.assign(marker.style, {
        left: `${next.rect.left}px`,
        top: `${(next.after ? next.rect.bottom : next.rect.top) - 2}px`,
        width: `${next.rect.width}px`,
      });
      document.body.append(marker);
    };
    const finish = (commit = false) => {
      const next = active && commit ? slot() : undefined;
      this.cancelGesture = undefined;
      lifetime.abort();
      cancelAnimationFrame(frame);
      if (header.hasPointerCapture(pointer))
        header.releasePointerCapture(pointer);
      marker.remove();
      dashboard.classList.remove("section-dragging");
      source.classList.remove("section-drag-source");
      for (const { node, text, expanded } of toggles) {
        node.textContent = text;
        if (expanded === null) node.removeAttribute("aria-expanded");
        else node.setAttribute("aria-expanded", expanded);
      }
      if (active) scrollport.to(scrollX, scrollY);
      if (next) drop(source.dataset.sectionId!, next.id, next.after);
    };
    this.cancelGesture = () => finish();
    const autoScroll = () => {
      if (slot()) scrollport.by(scrollport.edgeSpeed(x, y));
      preview();
      frame = requestAnimationFrame(autoScroll);
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
          active = true;
          // A pointer-up after dragging can still synthesize a click on the toggle.
          // Retain the guard through cancellation; the next pointer-down clears it.
          const clicks = new AbortController();
          document.addEventListener(
            "click",
            (click) => {
              if (!click.detail) return; // Keyboard activation remains available.
              click.preventDefault();
              click.stopImmediatePropagation();
              clicks.abort();
            },
            { capture: true, signal: clicks.signal },
          );
          document.addEventListener(
            "pointerdown",
            (down) => {
              if (down.isPrimary) clicks.abort();
            },
            { capture: true, signal: clicks.signal },
          );
          toggles = sections.map((node) => {
            const toggle = node.querySelector<HTMLElement>(".section-toggle")!;
            const saved = {
              node: toggle,
              text: toggle.textContent!,
              expanded: toggle.getAttribute("aria-expanded"),
            };
            toggle.setAttribute("aria-expanded", "false");
            toggle.textContent = saved.text.replace(/^▾/, "▸");
            return saved;
          });
          dashboard.classList.add("section-dragging");
          source.classList.add("section-drag-source");
          try {
            header.setPointerCapture(pointer);
          } catch {
            finish();
            return;
          }
          // Lower section headers may have started far below the now-compact list.
          const first = sections[0].getBoundingClientRect();
          const bounds = scrollport.bounds();
          if (first.top < bounds.top) scrollport.by(first.top - bounds.top);
          else if (first.bottom > bounds.bottom)
            scrollport.by(first.bottom - bounds.bottom);
          frame = requestAnimationFrame(autoScroll);
        }
        move.preventDefault();
        preview();
      },
      options,
    );
    window.addEventListener(
      "pointerup",
      (up) => {
        if (up.pointerId !== pointer) return;
        x = up.clientX;
        y = up.clientY;
        finish(true);
      },
      options,
    );
    window.addEventListener(
      "pointercancel",
      (cancel) => {
        if (cancel.pointerId === pointer) finish();
      },
      options,
    );
    header.addEventListener(
      "lostpointercapture",
      (lost) => {
        if (lost.pointerId === pointer && lost.target === header) finish();
      },
      options,
    );
    window.addEventListener("blur", () => finish(), options);
    window.addEventListener("resize", () => finish(), options);
    window.addEventListener("pagehide", () => finish(), options);
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) finish();
      },
      options,
    );
    document.addEventListener(
      "keydown",
      (key) => {
        if (key.key === "Escape") {
          if (active) key.preventDefault();
          finish();
        }
      },
      { ...options, capture: true },
    );
    document.addEventListener(
      "pointerdown",
      (down) => {
        if (down.pointerId !== pointer) finish();
      },
      options,
    );
    header.addEventListener(
      "dragstart",
      (drag) => drag.preventDefault(),
      options,
    );
  }
}
