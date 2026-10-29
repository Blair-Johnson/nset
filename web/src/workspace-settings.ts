import {
  applyDashboardControls,
  smoothingValue,
  type DashboardControls,
} from "./dashboard-controls";

import type { ViewConfig } from "./config";
import type { Workspace, Section } from "./workspace-types";

// Sigma stays in equivalent steps/seconds across display transforms. Analysis
// maps that bandwidth into the transformed full-data span, not the viewport.
const bandwidthUnit = (config: ViewConfig) =>
  config.axis === "step" ? "steps" : "seconds";

/** XY charts retain their own join axis. Smoothing applies to every scalar
 * chart, including folded charts; paired records have no smoothing coordinate. */
export function dashboardSettings(workspace: Workspace): {
  count: number;
  axis: ViewConfig["axis"] | null;
  smoothing: number | null;
  smoothingUnit: string | null;
  smoothingSignature: string | null;
} {
  const charts = workspace.sections
    .flatMap((section) => section.cards)
    .filter((card) => card.kind === "timeseries" && !card.records);
  if (!charts.length)
    return {
      count: 0,
      axis: null,
      smoothing: null,
      smoothingUnit: null,
      smoothingSignature: null,
    };
  const first = charts[0].config;
  const timed = charts.filter((card) => !card.x);
  const unit = bandwidthUnit(first);
  const compatible = charts.every(
    (card) => bandwidthUnit(card.config) === unit,
  );
  const value = smoothingValue(first);
  const sameValue = charts.every(
    (card) => smoothingValue(card.config) === value,
  );
  return {
    count: charts.length,
    axis:
      timed.length &&
      timed.every((card) => card.config.axis === timed[0].config.axis)
        ? timed[0].config.axis
        : null,
    smoothing: sameValue && (compatible || value === 0) ? value : null,
    smoothingUnit: compatible ? unit : null,
    smoothingSignature: compatible ? unit : null,
  };
}
/** Complete staging before mutation: all scalar cards change or none do. */
export function withDashboardSettings(
  workspace: Workspace,
  controls: DashboardControls,
): Section[] {
  // A display transform never changes the input bandwidth's units. Genuine
  // step/time mixtures still require choosing a common axis or per-chart edits.
  if (controls.smoothingSigma !== undefined && controls.smoothingSigma > 0) {
    const units = new Set(
      workspace.sections
        .flatMap((section) => section.cards)
        .filter((card) => card.kind === "timeseries" && !card.records)
        .map((card) =>
          bandwidthUnit(
            applyDashboardControls(
              card.config,
              card.x ? {} : { axis: controls.axis },
            ),
          ),
        ),
    );
    if (units.size > 1) throw new Error("Mixed units — edit charts");
  }
  return workspace.sections.map((section) => ({
    ...section,
    cards: section.cards.map((card) => {
      if (card.kind !== "timeseries" || card.records) return card;
      const config = applyDashboardControls(
        card.config,
        card.x ? { ...controls, axis: undefined } : controls,
      );
      return JSON.stringify(config) === JSON.stringify(card.config)
        ? card
        : { ...card, config };
    }),
  }));
}
