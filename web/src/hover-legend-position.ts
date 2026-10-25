export type LegendSide = "left" | "right";
type Point = readonly [number, number];
type Bounds = { x: number; y: number; width: number; height: number };
export type LegendCorners = Record<LegendSide, Bounds>;

const APPROACH = 12;
const RELEASE = 28;

function near([x, y]: Point, box: Bounds, padding: number): boolean {
  return (
    x >= box.x - padding &&
    x <= box.x + box.width + padding &&
    y >= box.y - padding &&
    y <= box.y + box.height + padding
  );
}

/** Prefer right, but keep the current corner if neither can clear the crosshair.
 * Separate approach/release margins prevent chatter at a corner's boundary. */
export function legendSide(
  side: LegendSide,
  pointer: Point,
  boxes: LegendCorners,
): LegendSide {
  if (side === "right") {
    return near(pointer, boxes.right, APPROACH) &&
      !near(pointer, boxes.left, RELEASE)
      ? "left"
      : "right";
  }
  // If the left corner is in the way, use right as soon as it is safe; otherwise
  // restore the preferred corner only after leaving its wider release margin.
  return !near(pointer, boxes.right, RELEASE) ||
    (near(pointer, boxes.left, APPROACH) &&
      !near(pointer, boxes.right, APPROACH))
    ? "right"
    : "left";
}

/** Popup and uPlot bounds are cached in plot-local CSS pixels. Pointer updates
 * never read layout; resize notifications also re-evaluate a stationary touch. */
export class HoverLegendPosition {
  private side: LegendSide = "right";
  private pointer: Point | null = null;
  private corners?: LegendCorners;
  private overlay?: HTMLElement;
  private frame = 0;
  private resize = new ResizeObserver(() => this.schedule());
  private mutation = new MutationObserver(() => this.schedule());

  constructor(
    private popup: HTMLElement,
    private plotHost: HTMLElement,
  ) {
    const parent = popup.parentElement!;
    this.resize.observe(parent);
    // Includes clipping notices, whose height can move the plot without resizing it.
    for (const child of parent.children) this.resize.observe(child);
    // uPlot can replace its root on a data/config render.
    this.mutation.observe(plotHost, { childList: true });
    this.schedule();
  }

  update(pointer: Point | null): void {
    this.pointer = pointer;
    if (!pointer) {
      this.setSide("right");
    } else if (this.corners) {
      this.setSide(legendSide(this.side, pointer, this.corners));
    }
  }

  private setSide(side: LegendSide): void {
    if (side === this.side) return;
    this.side = side;
    this.popup.dataset.side = side;
  }

  private schedule(): void {
    if (!this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.measure();
      });
  }

  private measure(): void {
    const overlay =
      this.plotHost.querySelector<HTMLElement>(".u-over") ?? undefined;
    if (overlay !== this.overlay) {
      if (this.overlay) this.resize.unobserve(this.overlay);
      this.overlay = overlay;
      if (overlay) this.resize.observe(overlay);
    }
    if (!overlay || !this.popup.childElementCount) {
      this.corners = undefined;
      return;
    }
    const parent = this.popup.offsetParent as HTMLElement | null;
    if (!parent) return;
    const plot = overlay.getBoundingClientRect();
    const popup = this.popup.getBoundingClientRect();
    const container = parent.getBoundingClientRect();
    // Mirror the actual border box across the inner plot, excluding axes and dynamic tick labels.
    const inset = 8;
    const availableWidth = Math.max(0, plot.width - 2 * inset);
    const availableHeight = Math.max(0, plot.height - 2 * inset);
    const width = Math.min(popup.width, availableWidth);
    const height = Math.min(popup.height, availableHeight);
    const originX = container.left + parent.clientLeft - parent.scrollLeft;
    const originY = container.top + parent.clientTop - parent.scrollTop;
    this.popup.style.setProperty("--legend-left", `${plot.left - originX + inset}px`);
    this.popup.style.setProperty("--legend-right", `${parent.clientWidth - (plot.right - originX) + inset}px`);
    this.popup.style.setProperty("--legend-top", `${plot.top - originY + inset}px`);
    this.popup.style.setProperty("--legend-width", `${availableWidth}px`);
    this.popup.style.setProperty("--legend-height", `${availableHeight}px`);
    this.corners = {
      left: { x: inset, y: inset, width, height },
      right: { x: plot.width - inset - width, y: inset, width, height },
    };
    this.update(this.pointer);
  }

  destroy(): void {
    this.resize.disconnect();
    this.mutation.disconnect();
    cancelAnimationFrame(this.frame);
  }
}
