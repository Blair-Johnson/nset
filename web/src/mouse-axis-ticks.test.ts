import assert from "node:assert/strict";
import test from "node:test";
import type uPlot from "uplot";
import { installMouseAxisTicks } from "./mouse-axis-ticks.ts";

class Node {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: Node[] = [];
  parent?: Node;
  className = "";
  textContent = "";
  hidden = false;
  offsetLeft = 60;
  offsetTop = 20;
  attributes: Record<string, string> = {};
  ownerDocument = { createElement: () => new Node() };
  appendChild(node: Node) {
    this.children.push(node);
    node.parent = this;
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (node) => node !== this,
      );
  }
}

// Minimal public-uPlot/DOM double: no browser globals or private _values/_pos.
// redraw is deliberately synchronous to detect accidental feedback loops.
function fixture(
  axes: uPlot.Axis[] = [{}, {}],
  format = { x: (v: number) => `${v}x`, y: (v: number) => `${v}y` },
  autoReady = true,
) {
  const options: uPlot.Options = {
    width: 400,
    height: 240,
    series: [{}],
    axes: axes.map((axis) => ({ font: "10px monospace", ...axis })),
  };
  const api = installMouseAxisTicks(options, format);
  const over = new Node();
  const transforms = {
    xTo: (v: number) => v * 3,
    yTo: (v: number) => 160 - v * 1.6,
    xFrom: (p: number) => p / 3,
    yFrom: (p: number) => 100 - p / 1.6,
  };
  const splits: number[][] = [
    [0, 25, 50, 75, 100],
    [0, 25, 50, 75, 100],
  ];
  const rendered: uPlot.Axis.StaticValues[] = [];
  let redraws = 0;
  const fonts: string[] = [];
  const ctx = {
    font: "10px monospace",
    save() {
      fonts.push(this.font);
    },
    restore() {
      this.font = fonts.pop()!;
    },
    measureText(text: string) {
      return { width: text.length * 6 };
    },
  };
  const normalized = options.axes!.map((axis, i) => ({
    show: true,
    scale: i ? "y" : "x",
    side: i ? 3 : 2,
    gap: 5,
    lineGap: 1.5,
    ticks: { show: true, size: 10 },
    stroke: "#abc",
    ...axis,
    values:
      typeof axis.values === "function"
        ? axis.values
        : Array.isArray(axis.values)
          ? () => axis.values
          : (_u: uPlot, values: number[]) => values.map(String),
    size: typeof axis.size === "function" ? axis.size : () => axis.size ?? 50,
    rotate:
      typeof axis.rotate === "function" ? axis.rotate : () => axis.rotate ?? 0,
  }));
  const u = {
    width: 400,
    height: 240,
    over,
    ctx,
    axes: normalized,
    scales: { x: { min: 0, max: 100 }, y: { min: 0, max: 100 } },
    valToPos: (value: number, key: string) =>
      key === "x" ? transforms.xTo(value) : transforms.yTo(value),
    posToVal: (position: number, key: string) =>
      key === "x" ? transforms.xFrom(position) : transforms.yFrom(position),
    redraw(rebuild: boolean, recalc: boolean) {
      assert.equal(rebuild, false);
      assert.equal(recalc, true);
      assert.ok(++redraws < 100, "redraw feedback loop");
      render();
    },
  } as unknown as uPlot;
  function fire(name: keyof uPlot.Hooks.Defs) {
    for (const hook of options.hooks?.[name] ?? []) {
      (hook as (...args: unknown[]) => void)(u, options, []);
    }
  }
  function render() {
    u.axes.forEach((axis, i) => {
      if (axis.show === false) return;
      const values = (axis.values as uPlot.Axis.DynamicValues)(
        u,
        splits[i],
        i,
        50,
        25,
      );
      rendered[i] = values;
      (axis.rotate as Exclude<uPlot.Axis.Rotate, number>)(
        u,
        values as string[],
        i,
        50,
      );
      (axis.size as Exclude<uPlot.Axis.Size, number>)(
        u,
        values as string[],
        i,
        1,
      );
    });
    fire("draw");
  }
  const label = (key: "x" | "y") =>
    over.children.find((node) => node.className === `mouse-axis-tick-${key}`)!;
  fire("init");
  render();
  if (autoReady) fire("ready");
  return {
    api,
    u,
    options,
    over,
    splits,
    transforms,
    rendered,
    fire,
    render,
    label,
    redraws: () => redraws,
  };
}

test("both actual mouse coordinates get opaque pointer-transparent ticks on bottom/left axes", () => {
  const f = fixture(undefined, { x: (v) => `${v}s`, y: (v) => `${v}B` });
  f.api.update([150, 80]);
  assert.equal(f.label("x").textContent, "50s");
  assert.equal(f.label("y").textContent, "50B");
  assert.ok(parseFloat(f.label("x").style.top) > 160);
  assert.ok(parseFloat(f.label("y").style.left) < 0);
  for (const key of ["x", "y"] as const) {
    const node = f.label(key);
    assert.equal(node.hidden, false);
    assert.equal(node.style.pointerEvents, "none");
    assert.equal(node.style.padding, "2px 4px");
    assert.match(node.style.background, /var\(--surface/);
    assert.equal(node.dataset.role, `mouse-axis-tick-${key}`);
    assert.equal(node.dataset.suppressedCount, "1");
    assert.equal(node.attributes["aria-hidden"], "true");
  }
});

test("overlap removes whole multiline native values without mutating them; move/leave restores them", () => {
  const originals = Object.freeze([
    "zero\nUTC",
    "25\nUTC",
    "50\nUTC",
    "75\nUTC",
    "100\nUTC",
  ]);
  const f = fixture([{ values: () => originals as unknown as string[] }, {}]);
  f.api.update([150, 80]);
  assert.equal(f.rendered[0][2], "");
  assert.equal(originals[2], "50\nUTC");
  f.api.update([30, 30]);
  assert.equal(f.rendered[0][2], "50\nUTC");
  assert.equal(f.rendered[1][2], "50");
  f.api.update(null);
  assert.deepEqual(f.rendered[0], originals);
  assert.deepEqual(f.rendered[1], ["0", "25", "50", "75", "100"]);
  assert.equal(f.label("x").hidden, true);
  assert.equal(f.label("y").hidden, true);
  assert.equal(f.label("x").dataset.suppressedCount, "0");
});

test("an unchanged pointer and draw feedback never request another redraw; caller arrays are copied", () => {
  const f = fixture();
  const pointer: [number, number] = [150, 80];
  f.api.update(pointer);
  assert.equal(f.redraws(), 1);
  pointer[0] = 75;
  f.fire("draw");
  assert.equal(f.label("x").textContent, "50x");
  f.api.update([150, 80]);
  assert.equal(f.redraws(), 1);
  f.options.hooks!.draw!.push(() => f.api.update([75, 80]));
  f.api.update(pointer);
  assert.equal(f.redraws(), 2);
  f.fire("draw");
  assert.equal(f.redraws(), 2);
});

test("stationary pointers follow current reversed/log transforms, zoom and resize", () => {
  const f = fixture(undefined, { x: (v) => v.toFixed(3), y: (v) => `${v}` });
  f.api.update([75, 80]);
  f.u.scales.x.min = 1;
  f.u.scales.x.max = 1000;
  f.u.scales.y.max = 200;
  f.splits[0] = [1, 10, 100, 1000];
  f.transforms.xTo = (v) => 300 * (1 - Math.log10(v) / 3);
  f.transforms.xFrom = (p) => 10 ** (3 * (1 - p / 300));
  f.transforms.yTo = (v) => v * 0.8;
  f.transforms.yFrom = (p) => p / 0.8;
  f.render();
  assert.equal(f.label("x").textContent, (10 ** 2.25).toFixed(3));
  assert.equal(f.label("y").textContent, "100");
  Object.assign(f.u, { width: 700, height: 400 });
  Object.assign(f.u, { width: 700, height: 400 });
  f.transforms.xTo = (v) => 600 * (1 - Math.log10(v) / 3);
  f.transforms.xFrom = (p) => 10 ** (3 * (1 - p / 600));
  f.transforms.yTo = (v) => v * 1.6;
  f.transforms.yFrom = (p) => p / 1.6;
  f.render();
  assert.equal(f.label("x").textContent, (10 ** 2.625).toFixed(3));
  assert.equal(f.label("y").textContent, "50");
  assert.ok(parseFloat(f.label("x").style.top) > 320);
  assert.equal(f.redraws(), 1, "draw refresh never schedules an extra draw");
});

test("top/right axes are honored and labels stay within the axis span near edges", () => {
  const f = fixture([{ side: 0 }, { side: 1 }]);
  f.api.update([0, 0]);
  assert.ok(parseFloat(f.label("x").style.top) < 0);
  assert.ok(parseFloat(f.label("y").style.left) > 300);
  assert.equal(parseFloat(f.label("x").style.left), 0);
  assert.equal(parseFloat(f.label("y").style.top), 0);
  f.api.update([300, 160]);
  assert.ok(
    parseFloat(f.label("x").style.left) +
      parseFloat(f.label("x").style.width) <=
      300,
  );
  assert.ok(
    parseFloat(f.label("y").style.top) +
      parseFloat(f.label("y").style.height) <=
      160,
  );
});

test("auto-size and rotation callbacks receive complete native labels, not suppressed ones", () => {
  const sizeValues: string[][] = [];
  const rotateValues: (string | number)[][] = [];
  const f = fixture([
    {
      size: (_u, values) => {
        sizeValues.push([...values]);
        return 50;
      },
      rotate: (_u, values) => {
        rotateValues.push([...values]);
        return 45;
      },
    },
    {},
  ]);
  f.api.update([150, 80]);
  assert.equal(f.rendered[0][2], "");
  assert.ok(sizeValues.every((values) => values.includes("50")));
  assert.ok(rotateValues.every((values) => values.includes("50")));
});

test("rotated long values are suppressed even when their tick lies outside the dynamic label", () => {
  const f = fixture([
    {
      values: (_u, splits) =>
        splits.map((v) => (v === 75 ? "a very long rotated tick" : String(v))),
      rotate: 45,
    },
    {},
  ]);
  f.api.update([150, 80]);
  assert.equal(f.rendered[0][3], "");
  f.api.update([0, 80]);
  assert.equal(f.rendered[0][3], "a very long rotated tick");
});

test("off-plot and nonfinite pointers restore ordinary ticks, as does a missing domain", () => {
  const f = fixture();
  for (const pointer of [
    [-1, 80],
    [301, 80],
    [100, 161],
    [NaN, 50],
    [50, Infinity],
  ] as [number, number][]) {
    f.api.update([150, 80]);
    f.api.update(pointer);
    assert.equal(f.label("x").hidden, true);
    assert.equal(f.label("y").hidden, true);
    assert.equal(f.rendered[0][2], "50");
    assert.equal(f.rendered[1][2], "50");
  }
  f.api.update([150, 80]);
  f.u.scales.x.min = undefined;
  f.render();
  assert.equal(f.label("x").hidden, true);
  assert.equal(f.label("y").hidden, true);
});

test("ready owns its instance, preserves an early pointer, and destroy removes nodes", () => {
  const f = fixture(undefined, undefined, false);
  f.api.update([150, 80]);
  assert.equal(f.redraws(), 0);
  assert.equal(f.over.children.length, 0);
  f.fire("ready");
  assert.equal(f.redraws(), 1);
  assert.equal(f.label("x").textContent, "50x");
  f.fire("destroy");
  assert.equal(f.over.children.length, 0);
  f.api.update([75, 40]);
  assert.equal(f.redraws(), 1);
});

test("hidden axes stay hidden and normalized static labels are restored verbatim", () => {
  const f = fixture([{ show: false }, { values: ["a", "b", "c", "d", "e"] }]);
  f.api.update([150, 80]);
  assert.equal(f.over.children.length, 1);
  assert.equal(f.label("y").textContent, "50y");
  assert.equal(f.rendered[1][2], "");
  f.api.update(null);
  assert.deepEqual(f.rendered[1], ["a", "b", "c", "d", "e"]);
});

test("long coordinate units remain visible inside a narrow Y gutter", () => {
  const f = fixture(undefined, {
    x: String,
    y: (v) => `${v} very long coordinate units`,
  });
  f.api.update([150, 80]);
  const label = f.label("y");
  assert.equal(parseFloat(label.style.left), -f.over.offsetLeft);
  assert.ok(parseFloat(label.style.width) > f.over.offsetLeft);
  assert.equal(f.rendered[1][2], "");
});

test("install appends hooks without replacing the caller's hooks", () => {
  const init = () => {};
  const draw = () => {};
  const ready = () => {};
  const destroy = () => {};
  const options: uPlot.Options = {
    width: 400,
    height: 240,
    series: [{}],
    hooks: { init: [init], draw: [draw], ready: [ready], destroy: [destroy] },
  };
  installMouseAxisTicks(options, { x: String, y: String });
  for (const [key, hook] of Object.entries({ init, draw, ready, destroy })) {
    const list = options.hooks![key as keyof uPlot.Hooks.Defs]!;
    assert.equal(list[0], hook);
    assert.equal(list.length, 2);
  }
});
