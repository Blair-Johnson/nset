import type { Run } from "./api";
import type { Catalog } from "./workspace-types";
import { runSwatch } from "./run-drawer";
import { element } from "./utils";
import { configJSON, configType, renderRunConfig } from "./run-config";
import { plotIcon } from "./plot-icons";
import "./run-detail.css";

export interface RunDetailOptions {
  onBack: () => void;
  catalog?: Catalog;
  /** Open the charts view showing only this run. */
  onCharts?: () => void;
  /** Persist a tag patch (null removes a tag); resolves with the updated run. */
  onTags?: (patch: Record<string, unknown>) => Promise<Run>;
}

/** Tag values are JSON; bare text that isn't valid JSON is kept as a string. */
export function parseTagValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

function iconButton(icon: Parameters<typeof plotIcon>[0], label: string) {
  const b = element("button", "run-detail-icon");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.append(plotIcon(icon));
  return b;
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
  header.append(back);
  if (options.catalog) header.append(runSwatch(options.catalog, run.id));
  header.append(name, status);
  if (options.onCharts) {
    const charts = element("button", "run-detail-charts");
    charts.type = "button";
    charts.title = "Open the charts view with only this run selected";
    charts.append(plotIcon("view-charts"), "Charts for this run");
    charts.onclick = options.onCharts;
    header.append(charts);
  }
  const metadata = element("dl", "run-detail-metadata");
  const add = (label: string, value: HTMLElement) => {
    const pair = element("div");
    pair.append(element("dt", "", label), value);
    metadata.append(pair);
  };
  const id = element("dd", "run-detail-id");
  const copy = iconButton("copy", "Copy run ID");
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(run.id);
      copy.dataset.copied = "true";
      copy.title = "Copied";
    } catch {
      copy.dataset.copied = "false";
      copy.title = "Copy failed — select the ID instead";
    }
    setTimeout(() => {
      delete copy.dataset.copied;
      copy.title = "Copy run ID";
    }, 1400);
  };
  id.append(element("span", "", run.id), copy);
  add("ID", id);
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
  let current = run;
  const renderTags = (error = "") => {
    tags.replaceChildren(element("h2", "", "Tags"));
    const entries = Object.entries(current.tags);
    if (!entries.length && !options.onTags)
      tags.append(element("span", "muted", "No tags"));
    for (const [key, value] of entries) {
      const tag = element("span", "run-detail-tag");
      tag.append(
        element("strong", "", key),
        element("code", "", configJSON(value)),
      );
      tag.title = `${key} (${configType(value)})`;
      if (options.onTags) {
        const edit = iconButton("tag", `Edit tag ${key}`);
        edit.classList.add("run-detail-tag-action");
        edit.onclick = () => openEditor(key, value);
        const remove = element("button", "run-detail-tag-remove", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove tag ${key}`);
        remove.title = `Remove tag ${key}`;
        remove.onclick = () => void save({ [key]: null });
        tag.append(edit, remove);
      }
      tags.append(tag);
    }
    if (options.onTags) {
      const addTag = element("button", "run-detail-tag-add", "+ Add tag");
      addTag.type = "button";
      addTag.onclick = () => openEditor("", "");
      tags.append(addTag);
    }
    if (error) {
      const message = element("span", "run-detail-tag-error", error);
      message.setAttribute("role", "alert");
      tags.append(message);
    }
  };
  const save = async (patch: Record<string, unknown>) => {
    try {
      current = await options.onTags!(patch);
      renderTags();
      return true;
    } catch (error) {
      renderTags(
        `Could not save tags: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };
  const openEditor = (key: string, value: unknown) => {
    const form = element("form", "run-detail-tag-form");
    form.setAttribute("aria-label", key ? `Edit tag ${key}` : "Add tag");
    const keyInput = element("input");
    keyInput.placeholder = "key";
    keyInput.value = key;
    keyInput.setAttribute("aria-label", "Tag key");
    keyInput.required = true;
    const valueInput = element("input");
    valueInput.placeholder = "value (text or JSON)";
    valueInput.value =
      key === "" ? "" : typeof value === "string" ? value : configJSON(value);
    valueInput.setAttribute("aria-label", "Tag value");
    const ok = element("button", "primary", "Save");
    ok.type = "submit";
    const cancel = element("button", "", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => renderTags();
    form.append(keyInput, valueInput, ok, cancel);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const nextKey = keyInput.value.trim();
      if (!nextKey) return;
      const patch: Record<string, unknown> = {
        [nextKey]: parseTagValue(valueInput.value),
      };
      if (key && key !== nextKey) patch[key] = null;
      ok.disabled = true;
      await save(patch);
    };
    form.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        renderTags();
      }
    };
    tags.querySelector(".run-detail-tag-add")?.remove();
    tags.append(form);
    (key ? valueInput : keyInput).focus();
  };
  renderTags();
  page.append(header, metadata, tags, renderRunConfig(run.params, run.id));
  return page;
}
