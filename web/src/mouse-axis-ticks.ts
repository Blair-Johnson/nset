import type uPlot from "uplot";

type Coordinate = "x" | "y";
type Pointer = [number, number];
type Interval = [number, number];

const padX = 4;
const padY = 2;
const clamp = (value: number, size: number, span: number) =>
  Math.max(0, Math.min(value, Math.max(0, span - size)));

interface AxisTick {
  key: Coordinate;
  index: number;
  font: string;
  fontSize: number;
  originals?: uPlot.Axis.StaticValues;
  rotation: number;
  suppressed: number;
  node?: HTMLDivElement;
}

/** Install before constructing uPlot. Coordinates are CSS pixels relative to
 * u.over, not snapped samples or u.cursor (which may expose only one direction).
 * Pass the same unit/notation formatters as the axes. No cursor mode is changed.
 */
export function installMouseAxisTicks(
  options: uPlot.Options,
  format: Record<Coordinate, (value: number) => string>,
): { update(pointer: Pointer | null): void } {
  let chart: uPlot | undefined;
  let pointer: Pointer | null = null;
  let destroyed = false;
  const ticks: AxisTick[] = [];
  const sizes: number[] = [];
  const hooks = (options.hooks ??= {});

  // Query the live transforms rather than caching a domain, a DPR, or the DOM
  // rectangle (which uPlot updates only AFTER its axis-layout convergence).
  function span(u: uPlot, key: Coordinate): number {
    const scale = u.scales[key];
    if (scale?.min == null || scale.max == null) return 0;
    return Math.abs(u.valToPos(scale.max, key) - u.valToPos(scale.min, key));
  }

  function active(u: uPlot): boolean {
    return (
      !!pointer &&
      pointer[0] >= 0 &&
      pointer[1] >= 0 &&
      pointer[0] <= span(u, "x") &&
      pointer[1] <= span(u, "y") &&
      span(u, "x") > 0 &&
      span(u, "y") > 0
    );
  }

  function measure(u: uPlot, tick: AxisTick, text: string): number {
    u.ctx.save();
    u.ctx.font = tick.font;
    const width = Math.max(
      0,
      ...text.split("\n").map((line) => u.ctx.measureText(line).width),
    );
    u.ctx.restore();
    return width;
  }

  function layout(u: uPlot, tick: AxisTick) {
    const axis = u.axes[tick.index];
    if (!active(u) || !pointer || axis.show === false) return null;
    const side = axis.side ?? (tick.key === "x" ? 2 : 3);
    const vertical = side % 2 === 1;
    const position = pointer[vertical ? 1 : 0];
    const value = u.posToVal(position, axis.scale ?? tick.key);
    if (!Number.isFinite(value)) return null;
    const text = format[tick.key](value);
    const lineHeight = tick.fontSize * (axis.lineGap ?? 1.5);
    const width = measure(u, tick, text) + 2 * padX;
    const height = text.split("\n").length * lineHeight + 2 * padY;
    const offset = vertical
      ? lineHeight / 2 + padY
      : axis.align === 1
        ? padX
        : axis.align === 2
          ? width - padX
          : width / 2;
    const start = clamp(
      position - offset,
      vertical ? height : width,
      span(u, tick.key),
    );
    return { text, width, height, lineHeight, start, side, vertical };
  }

  // Project the entire ordinary value onto its axis. Multiline values are one
  // indivisible label; rotated X labels include both their width and height.
  function ordinaryInterval(
    u: uPlot,
    tick: AxisTick,
    text: string,
    position: number,
  ): Interval {
    const axis = u.axes[tick.index];
    const vertical = (axis.side ?? (tick.key === "x" ? 2 : 3)) % 2 === 1;
    const lines = text.split("\n");
    if (vertical)
      return [
        position - tick.fontSize / 2,
        position +
          tick.fontSize / 2 +
          (lines.length - 1) * tick.fontSize * (axis.lineGap ?? 1.5),
      ];
    const angle = (-tick.rotation * Math.PI) / 180;
    const align = axis.align ?? (angle > 0 ? 1 : angle < 0 ? 2 : 0);
    const width = measure(u, tick, text);
    const left = align === 1 ? 0 : align === 2 ? -width : -width / 2;
    const corners = [left, left + width].flatMap((x) =>
      [-tick.fontSize / 2, tick.fontSize / 2].map(
        (y) => x * Math.cos(angle) - y * Math.sin(angle),
      ),
    );
    return [position + Math.min(...corners), position + Math.max(...corners)];
  }

  (hooks.init ??= []).push((u) => {
    // At init uPlot has normalized static arrays, date templates and default
    // formatters into functions. Wrapping here preserves ALL original formats.
    for (const key of ["x", "y"] as const) {
      const index = u.axes.findIndex(
        (axis) => axis.show !== false && axis.scale === key,
      );
      if (index < 0) continue;
      const font = options.axes?.[index]?.font ?? "12px system-ui";
      const tick: AxisTick = {
        key,
        index,
        font,
        fontSize: Number(/([\d.]+)px/.exec(font)?.[1] ?? 12),
        rotation: 0,
        suppressed: 0,
      };
      ticks.push(tick);
      const axis = u.axes[index];
      const values = axis.values as uPlot.Axis.DynamicValues;
      const rotate = axis.rotate;
      axis.values = (self, splits, axisIndex, space, increment) => {
        const originals = values(self, splits, axisIndex, space, increment);
        tick.originals = originals;
        tick.rotation =
          axis.side === 2
            ? typeof rotate === "function"
              ? rotate(self, originals as (string | number)[], axisIndex, space)
              : (rotate ?? 0)
            : 0;
        tick.suppressed = 0;
        const label = layout(self, tick);
        if (!label) return originals;
        const end = label.start + (label.vertical ? label.height : label.width);
        return originals.map((value, i) => {
          if (value == null || value === "" || splits[i] == null) return value;
          const position = self.valToPos(splits[i], axis.scale ?? key);
          const [lo, hi] = ordinaryInterval(
            self,
            tick,
            String(value),
            position,
          );
          // One CSS pixel also covers uPlot's canvas-pixel rounding/antialiasing.
          if (lo <= end + 1 && hi >= label.start - 1) {
            tick.suppressed++;
            return "";
          }
          return value;
        });
      };
      if (typeof rotate === "function") {
        axis.rotate = (self, values, index, space) =>
          rotate(
            self,
            (tick.originals ?? values) as (string | number)[],
            index,
            space,
          );
      }
    }
    u.axes.forEach((axis, index) => {
      const size = axis.size;
      const initialSize = options.axes?.[index]?.size;
      sizes[index] = typeof initialSize === "number" ? initialSize : 50;
      // Native autosizing must see the originals, not the temporarily hidden
      // labels, or the gutters and pointer coordinates can oscillate.
      axis.size = (self, values, axisIndex, cycle) => {
        const originals = ticks.find((tick) => tick.index === index)?.originals;
        const result =
          typeof size === "function"
            ? size(self, (originals ?? values) as string[], axisIndex, cycle)
            : (size ?? 50);
        sizes[index] = Math.ceil(result);
        return result;
      };
    });
  });

  function refresh(u: uPlot) {
    for (const tick of ticks) {
      const node = tick.node;
      if (!node) continue;
      const label = layout(u, tick);
      node.hidden = !label;
      node.dataset.suppressedCount = String(label ? tick.suppressed : 0);
      if (!label) continue;
      const axis = u.axes[tick.index];
      const { vertical, side, width, height, lineHeight } = label;
      const sign = side === 0 || side === 3 ? -1 : 1;
      // Account for any earlier axes on the same side, without _pos/_size.
      let base = side === 2 ? span(u, "y") : side === 1 ? span(u, "x") : 0;
      for (let i = 0; i < tick.index; i++) {
        const prior = u.axes[i];
        if (
          prior.side === side &&
          prior.show !== false &&
          u.scales[prior.scale!]?.min != null
        ) {
          base +=
            sign *
            (sizes[i] + (prior.label != null ? (prior.labelSize ?? 30) : 0));
        }
      }
      const distance =
        axis.alignTo === 2
          ? sizes[tick.index] - (axis.gap ?? 5)
          : (axis.ticks?.show === false ? 0 : (axis.ticks?.size ?? 10)) +
            (axis.gap ?? 5);
      const anchor = base + sign * distance;
      let left = vertical
        ? anchor - (side === 3 ? width - padX : padX)
        : label.start;
      let top = vertical
        ? label.start
        : side === 2
          ? anchor - padY - (lineHeight - tick.fontSize) / 2
          : anchor - height + padY + (lineHeight - tick.fontSize) / 2;
      // A long unit/date must not disappear outside a narrow gutter. Only the
      // perpendicular position changes, so the suppression interval is stable.
      if (vertical) {
        left =
          clamp(left + u.over.offsetLeft, width, u.width) - u.over.offsetLeft;
      } else {
        top =
          clamp(top + u.over.offsetTop, height, u.height) - u.over.offsetTop;
      }
      node.textContent = label.text;
      Object.assign(node.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        font: tick.font,
        lineHeight: `${lineHeight}px`,
      });
      const stroke =
        typeof axis.stroke === "function"
          ? axis.stroke(u, tick.index)
          : axis.stroke;
      if (typeof stroke === "string") node.style.color = stroke;
    }
  }

  (hooks.ready ??= []).push((u) => {
    chart = u;
    for (const tick of ticks) {
      const node = u.over.ownerDocument.createElement("div");
      node.className = `mouse-axis-tick-${tick.key}`;
      node.dataset.role = `mouse-axis-tick-${tick.key}`;
      node.setAttribute("aria-hidden", "true");
      Object.assign(node.style, {
        position: "absolute",
        pointerEvents: "none",
        zIndex: "20",
        boxSizing: "border-box",
        whiteSpace: "pre",
        margin: "0",
        padding: `${padY}px ${padX}px`,
        borderRadius: "2px",
        background: "var(--surface, #1e2022)",
      });
      // u.over is deliberately not clipped by uPlot; negative positions land in
      // the left/top axis gutters, and labels remain aligned when the plot moves.
      u.over.appendChild(node);
      tick.node = node;
    }
    refresh(u);
    if (pointer) u.redraw(false, true);
  });
  (hooks.draw ??= []).push(refresh);
  (hooks.destroy ??= []).push(() => {
    destroyed = true;
    chart = undefined;
    pointer = null;
    for (const tick of ticks) tick.node?.remove();
  });

  return {
    update(next) {
      if (destroyed) return;
      if (next && !next.every(Number.isFinite)) next = null;
      if (
        (pointer === null && next === null) ||
        (pointer && next && pointer[0] === next[0] && pointer[1] === next[1])
      )
        return;
      pointer = next ? [next[0], next[1]] : null;
      if (chart) {
        refresh(chart);
        // Never redraw from the draw hook. In particular, a caller may feed the
        // same pointer back during draw without starting a redraw feedback loop.
        chart.redraw(false, true);
      }
    },
  };
}
