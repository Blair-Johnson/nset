import {
  applyDashboardControls,
  smoothingValue,
  type DashboardControls,
} from "./dashboard-controls";
import { smoothingCoordinate } from "./smoothing-coordinate";
import type { ViewConfig } from "./config";
import type { Workspace, Section } from "./workspace-types";
/** XY charts plot a metric on X; the dashboard X control (step / time) does
 * not describe them, so they neither count toward it nor follow it. Their
 * join parameter is edited per chart. Smoothing applies to every scalar chart. */
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
  const coordinate = smoothingCoordinate(first, !!charts[0].x);
  const compatible = charts.every(
    (card) =>
      smoothingCoordinate(card.config, !!card.x).signature ===
      coordinate.signature,
  );

  return {
    count: charts.length,
    axis:
      timed.length &&
      timed.every((card) => card.config.axis === timed[0].config.axis)
        ? timed[0].config.axis
        : null,
    smoothing:
      compatible &&
      charts.every(
        (card) => smoothingValue(card.config) === smoothingValue(first),
      )
        ? smoothingValue(first)
        : null,
    smoothingUnit: compatible ? coordinate.unit : null,
    smoothingSignature: compatible ? coordinate.signature : null,
  };
}
/** Complete staging before mutation: all scalar cards change or none do. */
export function withDashboardSettings(
  workspace: Workspace,
  controls: DashboardControls,
): Section[] {
  // Guard the pure update too: callers cannot accidentally apply a number to
  // incomparable coordinates, even when the toolbar is stale or bypassed.
  if (controls.smoothingSigma !== undefined && controls.smoothingSigma > 0) {
    const signatures = new Set(
      workspace.sections
        .flatMap((section) => section.cards)
        .filter((card) => card.kind === "timeseries" && !card.records)
        .map(
          (card) =>
            smoothingCoordinate(
              applyDashboardControls(
                card.config,
                card.x ? {} : { axis: controls.axis },
              ),
              !!card.x,
            ).signature,
        ),
    );
    if (signatures.size > 1) throw new Error("Mixed units — edit charts");
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
