import test from "node:test";
import assert from "node:assert/strict";
import { newChart } from "./workspace";
import { plotType, setPlotType } from "./plot-types";
for (const type of ["line", "scatter", "area", "step", "image"] as const) {
  test(`${type} plot preset preserves data and numerical settings`, () => {
    const card = newChart("timeseries", ["train/loss"]);
    card.config.interpolation = "pchip";
    card.config.smoothing = true;
    const source = structuredClone(card.source);
    setPlotType(card, type);
    assert.equal(plotType(card), type);
    assert.deepEqual(card.source, source);
    assert.equal(card.config.interpolation, "pchip");
    assert.equal(card.config.smoothing, true);
  });
}
test("scatter enables observation markers, line restores stroke, individual colors survive", () => {
  const card = newChart("timeseries", ["train/loss"]);
  card.config.runs.r = {
    color: "red",
    visible: false,
    path: "spline",
    width: 5,
    markers: { show: false, size: 9 },
    pathOptions: { align: -1 },
  };
  setPlotType(card, "scatter");
  assert.equal(card.config.style.width, 0);
  assert.equal(card.config.style.points, true);
  assert.equal(card.config.style.markers?.show, true);
  assert.deepEqual(card.config.runs.r, {
    color: "red",
    visible: false,
    markers: { size: 9 },
    pathOptions: {},
  });
  setPlotType(card, "line");
  assert.equal(card.config.style.width, 2);
  assert.equal(card.config.style.fill, 0);
  assert.equal(card.config.style.path, "matched");
  // Leaving scatter must actually remove its markers.
  assert.equal(card.config.style.points, false);
  assert.equal(card.config.style.markers?.show, false);
});
test("points are an overlay: line, area and step keep the chosen markers", () => {
  const card = newChart("timeseries", ["train/loss"]);
  card.config.style.points = true;
  card.config.style.markers = { show: "auto" };
  card.config.runs.r = { markers: { show: true } };
  for (const type of ["area", "step", "line"] as const) {
    setPlotType(card, type);
    assert.equal(plotType(card), type);
    assert.equal(card.config.style.markers?.show, "auto");
    assert.equal(card.config.style.points, true);
    assert.deepEqual(card.config.runs.r, { markers: { show: true } });
  }
});

test("plot presets preserve authored details; image conversion drops scalar measurements only", () => {
  const card = newChart("timeseries", ["train/loss"]);
  card.details = {
    markdown: "Inspect this trajectory.",
    configFields: [{ path: ["optimizer", "lr"], label: "Learning rate" }],
    measurements: { interval: { axis: "x", a: 10, b: 20 } },
  };
  const details = structuredClone(card.details);
  setPlotType(card, "scatter");
  assert.deepEqual(card.details, details);
  setPlotType(card, "image");
  assert.deepEqual(card.details, {
    markdown: details.markdown,
    configFields: details.configFields,
  });
});
