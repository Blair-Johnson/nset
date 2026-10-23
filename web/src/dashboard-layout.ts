import { defaultSections } from "./workspace";
import type { Catalog, ChartSpec, Workspace } from "./workspace-types";

/** Restore missing automatic charts without reusing identities of edited cards. */
export function addMissingCharts(workspace: Workspace, catalog: Catalog): void {
  const signature = (card: ChartSpec) => card.source.mode === "selected"
    ? JSON.stringify([card.kind, [...card.source.keys].sort()]) : card.id;
  const cards = workspace.sections.flatMap(section => section.cards);
  const existing = new Set(cards.map(signature));
  const cardIds = new Set(cards.map(card => card.id));
  const sectionIds = new Set(workspace.sections.map(section => section.id));
  for (const section of defaultSections(catalog, workspace.selectedRunIds)) {
    const missing = section.cards.filter(card => !existing.has(signature(card)));
    if (!missing.length) continue;
    for (const card of missing) {
      if (cardIds.has(card.id)) card.id = crypto.randomUUID();
      cardIds.add(card.id);
      existing.add(signature(card));
    }
    const target = workspace.sections.find(value => value.id === section.id)
      ?? workspace.sections.find(value => value.title === section.title);
    if (target) target.cards.push(...missing);
    else {
      if (sectionIds.has(section.id)) section.id = crypto.randomUUID();
      sectionIds.add(section.id);
      workspace.sections.push({ ...section, cards: missing });
    }
  }
}
