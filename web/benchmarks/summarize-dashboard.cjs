const fs = require("node:fs");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const [input, expectedHash] = process.argv.slice(2);
const bytes = fs.readFileSync(input);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256, expectedHash);
const d = JSON.parse(bytes);
assert.equal(d.status, "complete");
assert.equal(
  d.samples.filter((s) => s.recorded && s.status === "complete").length,
  60,
);
const keys = [
  "startupReadyMs",
  "searchHandlerMedianMs",
  "searchUpdateThroughPaintMedianMs",
  "jsHeapAfterGCBytes",
  "domNodes",
  "cards",
  "viewers",
  "cdpEventListenersAfterGC",
  "idleTaskMsPerSecond",
  "idleRAFCallbacksPerSecond",
  "idleAPIRequests",
  "webGLWarnings",
];
const comparisons = [];
for (const rate of d.config.rates) {
  for (const scenario of [...new Set(d.aggregates.map((a) => a.scenario))]) {
    const before = d.aggregates.find(
      (a) =>
        a.variant === "baseline" &&
        a.cpuThrottleRate === rate &&
        a.scenario === scenario,
    );
    const after = d.aggregates.find(
      (a) =>
        a.variant === "current" &&
        a.cpuThrottleRate === rate &&
        a.scenario === scenario,
    );
    assert.equal(before.n, 5);
    assert.equal(after.n, 5);
    const metrics = {};
    for (const key of keys) {
      if (!before.metrics[key]) continue;
      const b = before.metrics[key],
        a = after.metrics[key];
      metrics[key] = {
        before: b,
        after: a,
        reductionPct: b.median ? 100 * (1 - a.median / b.median) : null,
      };
      console.log(
        JSON.stringify({
          rate,
          scenario,
          metric: key,
          before: b.median,
          after: a.median,
          beforeRange: [b.min, b.max],
          afterRange: [a.min, a.max],
        }),
      );
    }
    comparisons.push({ rate, scenario, metrics });
  }
}
const summary = {
  source: { input, sha256, run: "r772" },
  host: d.config.host,
  browser: d.config.browserVersion,
  graphics: d.config.graphics.gpu.devices,
  comparisons,
};
fs.writeFileSync("benchmark-summary.json", JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify({
    kind: "benchmark-summary-environment",
    host: summary.host,
    browser: summary.browser,
    graphics: summary.graphics,
  }),
);
