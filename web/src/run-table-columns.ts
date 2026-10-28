import { element } from "./utils";

/** Presentation-only widths, keyed by sort field (including exact parameter paths). */
export class RunTableColumns {
  private readonly group = element("colgroup");
  private readonly mobile = matchMedia("(max-width: 760px)");
  private fields: string[] = [];
  private readonly viewportObserver = new ResizeObserver(() =>
    this.updatePinnedName(),
  );

  private updatePinnedName() {
    const available = this.table.parentElement?.clientWidth ?? 0;
    this.table.classList.toggle(
      "run-name-unpinned",
      available > 0 && this.width("name") + 36 > available - 120,
    );
  }
  private active?: {
    handle: HTMLElement;
    key: string;
    pointerId: number;
    x: number;
    width: number;
    saved?: number;
  };

  constructor(
    private readonly table: HTMLTableElement,
    private readonly widths: Record<string, number>,
  ) {
    table.prepend(this.group);
    this.mobile.addEventListener("change", this.apply);
  }

  private minimum(key: string) {
    return key === "name" || key === "created_at"
      ? 120
      : key === "status"
        ? 100
        : 80;
  }

  private width(key: string) {
    const fallback =
      key === "name"
        ? this.mobile.matches
          ? 180
          : 240
        : key === "status"
          ? 120
          : key === "created_at"
            ? 176
            : key.startsWith("parameter:")
              ? 200
              : 176;
    const saved = this.widths[key];
    return this.clamp(key, Number.isFinite(saved) ? saved : fallback);
  }

  private clamp(key: string, width: number) {
    return Math.round(Math.min(1600, Math.max(this.minimum(key), width)));
  }

  setFields(fields: string[]) {
    this.cancelResize();
    this.fields = fields;
    if (this.table.parentElement)
      this.viewportObserver.observe(this.table.parentElement);
    this.group.replaceChildren(
      ...Array.from({ length: fields.length + 1 }, () => element("col")),
    );
    this.apply();
  }

  private apply = () => {
    const widths = [36, ...this.fields.map((key) => this.width(key))];
    Array.from(this.group.children).forEach((col, i) => {
      (col as HTMLElement).style.width = `${widths[i]}px`;
    });
    this.table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    this.updatePinnedName();
    for (const handle of this.table.querySelectorAll<HTMLElement>(
      ".column-resize-handle",
    ))
      handle.setAttribute(
        "aria-valuenow",
        String(this.width(handle.dataset.columnKey!)),
      );
  };

  private finish(commit: boolean) {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    if (!commit) {
      if (active.saved === undefined) delete this.widths[active.key];
      else this.widths[active.key] = active.saved;
      this.apply();
    }
    this.table.classList.remove("is-column-resizing");
    window.removeEventListener("keydown", this.escape, true);
    window.removeEventListener("blur", this.cancelResize);
    if (active.handle.hasPointerCapture(active.pointerId))
      active.handle.releasePointerCapture(active.pointerId);
  }

  cancelResize = () => this.finish(false);

  private escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelResize();
  };

  handle(key: string, label: string) {
    const handle = element("span", "column-resize-handle");
    handle.dataset.columnKey = key;
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", `Resize ${label} column`);
    handle.setAttribute("aria-valuemin", String(this.minimum(key)));
    handle.setAttribute("aria-valuemax", "1600");
    handle.setAttribute("aria-valuenow", String(this.width(key)));
    handle.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const reset = () => {
      this.cancelResize();
      delete this.widths[key];
      this.apply();
    };
    handle.ondblclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      reset();
    };
    handle.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Home") reset();
      else {
        this.cancelResize();
        this.widths[key] = this.clamp(
          key,
          this.width(key) +
            (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 64 : 16),
        );
        this.apply();
      }
    };
    handle.onpointerdown = (event) => {
      if (event.button !== 0 || this.active) return;
      event.preventDefault();
      event.stopPropagation();
      handle.focus({ preventScroll: true });
      this.active = {
        handle,
        key,
        pointerId: event.pointerId,
        x: event.clientX,
        width: this.width(key),
        saved: this.widths[key],
      };
      handle.setPointerCapture(event.pointerId);
      this.table.classList.add("is-column-resizing");
      window.addEventListener("keydown", this.escape, true);
      window.addEventListener("blur", this.cancelResize);
    };
    handle.onpointermove = (event) => {
      const active = this.active;
      if (!active || active.pointerId !== event.pointerId) return;
      this.widths[key] = this.clamp(
        key,
        active.width + event.clientX - active.x,
      );
      this.apply();
    };
    handle.onpointerup = (event) => {
      if (this.active?.pointerId === event.pointerId) this.finish(true);
    };
    handle.onpointercancel = handle.onlostpointercapture = (event) => {
      if (this.active?.pointerId === event.pointerId) this.cancelResize();
    };
    return handle;
  }

  destroy() {
    this.cancelResize();
    this.mobile.removeEventListener("change", this.apply);
    this.viewportObserver.disconnect();
  }
}
