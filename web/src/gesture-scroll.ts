/** The nearest scrollport, including one that can gain overflow during resize. */
export class GestureScroll {
  private panel?: HTMLElement;

  constructor(origin: HTMLElement) {
    for (
      let node: HTMLElement | null = origin;
      node;
      node = node.parentElement
    ) {
      if (node === document.body || node === document.documentElement) break;
      if (
        /(auto|scroll)/.test(getComputedStyle(node).overflowY) &&
        node.clientHeight
      ) {
        this.panel = node;
        break;
      }
    }
  }

  get x(): number {
    return this.panel ? this.panel.scrollLeft : window.scrollX;
  }

  get y(): number {
    return this.panel ? this.panel.scrollTop : window.scrollY;
  }

  to(x: number, y: number): void {
    if (this.panel) {
      this.panel.scrollLeft = x;
      this.panel.scrollTop = y;
    } else window.scrollTo(x, y);
  }

  by(y: number): void {
    this.to(this.x, this.y + y);
  }

  /** Client-area bounds clipped by the viewport and any enclosing scrollport. */
  bounds() {
    let left = 0,
      top = 0,
      right = innerWidth,
      bottom = innerHeight;
    for (let node = this.panel; node; node = node.parentElement ?? undefined) {
      const css = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (
        node === this.panel ||
        /(auto|scroll|hidden|clip)/.test(css.overflowX)
      ) {
        left = Math.max(left, rect.left + node.clientLeft);
        right = Math.min(right, rect.left + node.clientLeft + node.clientWidth);
      }
      if (
        node === this.panel ||
        /(auto|scroll|hidden|clip)/.test(css.overflowY)
      ) {
        top = Math.max(top, rect.top + node.clientTop);
        bottom = Math.min(
          bottom,
          rect.top + node.clientTop + node.clientHeight,
        );
      }
    }
    return { left, top, right, bottom };
  }

  contains(x: number, y: number): boolean {
    const b = this.bounds();
    return x >= b.left && x < b.right && y >= b.top && y < b.bottom;
  }

  edgeSpeed(x: number, y: number, max = 12): number {
    if (!this.contains(x, y)) return 0;
    const { top, bottom } = this.bounds();
    const edge = Math.min(48, (bottom - top) / 2);
    const distance = Math.min(y - top, bottom - y);
    if (distance >= edge) return 0;
    return (
      Math.ceil((1 - distance / edge) * max) * (y - top < bottom - y ? -1 : 1)
    );
  }
}
