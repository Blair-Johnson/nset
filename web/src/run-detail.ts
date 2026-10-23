import type { Run } from "./api";
import type { Catalog } from "./workspace-types";
import { runColorButton } from "./run-color-picker";
import { element } from "./utils";
import { configJSON, configType, renderRunConfig } from "./run-config";
import "./run-detail.css";

export interface RunDetailOptions {
  onBack: () => void;
  onCharts: () => void;
  catalog?: Catalog;
}

export function renderRunDetail(
  run: Run,
  options: RunDetailOptions,
): HTMLElement {
  const page = element("article", "run-detail");
  page.setAttribute("aria-label", "Run details");
  const header = element("header", "run-detail-header");
  const back = element("button", "", "← Runs");
  back.type = "button";
  back.onclick = options.onBack;
  const name = element("h1", "", run.name || run.id);
  name.title = run.name || run.id;
  const status = element("span", `run-detail-status ${run.status}`, run.status);
  const charts = element("button", "", "Charts");
  charts.type = "button";
  charts.onclick = options.onCharts;
  header.append(back);
  if (options.catalog) header.append(runColorButton(options.catalog, run.id));
  header.append(name, status, charts);
  const metadata = element("dl", "run-detail-metadata");
  const add = (label: string, value: HTMLElement) => {
    const pair = element("div");
    pair.append(element("dt", "", label), value);
    metadata.append(pair);
  };
  add("ID", element("dd", "run-detail-id", run.id));
  for (const [label, timestamp] of [
    ["Created", run.created_at],
    ["Updated", run.updated_at],
  ] as const) {
    const value = element("dd");
    const date = new Date(timestamp);
    const time = element("time");
    if (Number.isFinite(date.getTime())) {
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleString();
      time.title = date.toISOString();
    } else time.textContent = "Unknown";
    value.append(time);
    add(label, value);
  }
  const tags = element("section", "run-detail-tags");
  tags.setAttribute("aria-label", "Run tags");
  tags.append(element("h2", "", "Tags"));
  const entries = Object.entries(run.tags);
  if (!entries.length) tags.append(element("span", "muted", "No tags"));
  for (const [key, value] of entries) {
    const tag = element("span", "run-detail-tag");
    tag.append(
      element("strong", "", key),
      element("code", "", configJSON(value)),
    );
    tag.title = `${key} (${configType(value)})`;
    tags.append(tag);
  }
  page.append(header, metadata, tags, renderRunConfig(run.params, run.id));
  return page;
}
