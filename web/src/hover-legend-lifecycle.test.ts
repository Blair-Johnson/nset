import test from "node:test";
import assert from "node:assert/strict";
import { HoverLegendPosition } from "./hover-legend-position";

test("hover placement disconnects observers and cancels queued work until reactivated", () => {
  const observers: Observer[] = [];
  class Observer {
    targets = new Set<unknown>();
    constructor(readonly notify: () => void) {
      observers.push(this);
    }
    observe(target: unknown) {
      this.targets.add(target);
    }
    unobserve(target: unknown) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const globals = {
    ResizeObserver: Observer,
    MutationObserver: Observer,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
    },
  };
  const originals = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  try {
    const overlay = {};
    const parent = { children: [] as unknown[] };
    const popup = { parentElement: parent, childElementCount: 0, dataset: {} };
    const plot = { querySelector: () => overlay };
    parent.children = [popup, plot];
    const position = new HoverLegendPosition(
      popup as unknown as HTMLElement,
      plot as unknown as HTMLElement,
    );
    assert.equal(frames.size, 1);
    assert.equal(observers[0].targets.size, 3);
    assert.equal(observers[1].targets.size, 1);
    position.setActive(false);
    assert.equal(frames.size, 0);
    assert.ok(observers.every((observer) => observer.targets.size === 0));
    // A notification already delivered by the browser must not restart work.
    for (const observer of observers) observer.notify();
    position.update([1, 2]);
    assert.equal(frames.size, 0);
    for (let i = 0; i < 2; i++) {
      position.setActive(true);
      position.setActive(true);
      assert.equal(frames.size, 1);
      const [id, callback] = frames.entries().next().value!;
      frames.delete(id);
      callback(0);
      assert.ok(observers[0].targets.has(overlay));
      position.setActive(false);
      assert.equal(frames.size, 0);
    }
    position.destroy();
    position.setActive(true);
    assert.equal(frames.size, 0);
    assert.ok(observers.every((observer) => observer.targets.size === 0));
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
