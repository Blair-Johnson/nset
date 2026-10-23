import {
  applyDashboardControls,
  smoothingToStrength,
  type DashboardControls,
} from "./dashboard-controls";
import type { ViewConfig } from "./config";
import type { Workspace, Section } from "./workspace-types";
export function dashboardSettings(workspace: Workspace): {
  count: number;
  axis: ViewConfig["axis"] | null;
  smoothing: number | null;
} {
  const charts = workspace.sections
    .flatMap((section) => section.cards)
    .filter((card) => card.kind === "timeseries");
  if (!charts.length) return { count: 0, axis: null, smoothing: null };
  const first = charts[0].config;
  const weight = (config: ViewConfig) => (config.smoothing ? config.alpha : 1);
  return {
    count: charts.length,
    axis: charts.every((card) => card.config.axis === first.axis)
      ? first.axis
      : null,
    smoothing: charts.every((card) => weight(card.config) === weight(first))
      ? smoothingToStrength(first)
      : null,
  };
}
/** Complete staging before mutation: all scalar cards change or none do. */
export function withDashboardSettings(
  workspace: Workspace,
  controls: DashboardControls,
): Section[] {
  return workspace.sections.map((section) => ({
    ...section,
    cards: section.cards.map((card) => {
      if (card.kind !== "timeseries") return card;
      const config = applyDashboardControls(card.config, controls);
      return JSON.stringify(config) === JSON.stringify(card.config)
        ? card
        : { ...card, config };
    }),
  }));
}
