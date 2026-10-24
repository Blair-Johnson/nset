import type { Api, Run } from "./api";
import {
  recordPath,
  recordValue,
  type FieldHint,
  type RecordResult,
  type RecordRow,
} from "./records";
import {
  buildConfigTree,
  configPath,
  configNamespace,
  configType,
  renderRunConfig,
  type ConfigElement,
} from "./run-config";
import { element } from "./utils";

const MAX_ADDITIONS = 12;
const FIELD_PAGE = 25;
function button(label: string, click: () => void): HTMLButtonElement {
  const b = element("button", "", label);
  b.type = "button";
  b.onclick = click;
  return b;
}
function shortText(text: string, limit: number): string {
  let result = "";
  let count = 0;
  for (const char of text) {
    if (count++ === limit) return result + "...";
    result += char;
  }
  return result;
}
function provenance(row: RecordRow): string {
  const data = row.data as Record<string, unknown> | null;
  const kind =
    data && typeof data === "object" ? (data.kind ?? data.type) : undefined;
  return `Event #${row.seq}${typeof kind === "string" ? ` - ${shortText(kind, 120)}` : ""} - ${row.received_at}`;
}
function summary(value: unknown): string {
  if (value !== null && typeof value === "object")
    return Array.isArray(value)
      ? `array - ${value.length} items`
      : `object - ${Object.keys(value).length} keys`;
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    return "number - approximate / out of range; inspect raw event";
  return `${configType(value)} - ${shortText(JSON.stringify(value) ?? String(value), 160)}`;
}

/** Enter always addresses one exact, case-sensitive path, never a sampled guess. */
export function exactEventPath(query: string): string | null {
  const text = query.trim();
  if (!text) return null;
  let path;
  try {
    path = recordPath(text);
  } catch {
    // A plain unusual/Unicode root key is unambiguous. Punctuation that could
    // denote a path must instead be explicitly JSON-quoted by the user.
    if (/[.\[\]$]/.test(text)) return null;
    path = [text];
  }
  const display = configNamespace(path);
  return new TextEncoder().encode(display).length <= 1024 ? display : null;
}
export function rankedEventFields(
  hints: FieldHint[],
  query: string,
): FieldHint[] {
  const exact = exactEventPath(query);
  const prefix = (exact ?? query.trim()).toLowerCase();
  const ranked = hints.map((hint) => {
    const parts = recordPath(hint.path);
    const display = configNamespace(parts);
    const rootPrefix =
      parts.length === 1 &&
      typeof parts[0] === "string" &&
      parts[0].toLowerCase().startsWith(query.trim().toLowerCase());
    return {
      hint,
      display,
      rank:
        display === exact
          ? 0
          : display.toLowerCase().startsWith(prefix) || rootPrefix
            ? 1
            : 2,
    };
  });
  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.display < b.display
          ? -1
          : a.display > b.display
            ? 1
            : a.hint.path < b.hint.path
              ? -1
              : a.hint.path > b.hint.path
                ? 1
                : 0),
    )
    .map(({ hint }) => hint);
}

/** Display-only, run-scoped inspection. No metadata writes or persistent state. */
export function attachEventConfig(
  config: ConfigElement,
  api: Api,
  source: NonNullable<Run["rx"]>,
  signal?: AbortSignal,
): void {
  const search = config.querySelector<HTMLInputElement>(
    'input[type="search"]',
  )!;
  search.placeholder = "Search configuration or add logged event fields";
  search.maxLength = 1024;
  const discovery = element("div", "run-event-discovery");
  discovery.setAttribute("aria-label", "Add logged event fields");
  const status = element("p", "muted");
  status.setAttribute("role", "status");
  const fields = element("div", "run-event-fields");
  const occurrences = element("div", "run-event-occurrences");
  const additions = element("div", "run-event-additions");
  discovery.append(status, fields, occurrences);
  config.querySelector(".run-config-tools")!.after(discovery);
  config.append(additions);
  const selected = new Map<
    string,
    {
      section: HTMLElement;
      tree: ConfigElement;
      seq: string;
      paths: Set<string>;
    }
  >();
  for (const control of config.querySelectorAll<HTMLButtonElement>(
    "[data-config-expand]",
  )) {
    control.addEventListener("click", () => {
      for (const addition of selected.values())
        addition.tree.setExpanded(control.dataset.configExpand === "true");
    });
  }
  let fieldController: AbortController | undefined;
  let recordController: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  let disposed = false;
  let enterToken: object | undefined;
  let fieldHints: FieldHint[] = [];
  let fieldLimit = FIELD_PAGE;
  let fieldCursor: unknown | null = null;
  let fieldNotice = "";
  let activePath = "";
  let rows: RecordRow[] = [];
  let recordCursor: unknown | null = null;
  let occurrenceNotice = "";
  const body = { source_id: source.sourceId, runs: [source.uid] };
  const live = (version: number) =>
    !disposed && !signal?.aborted && config.isConnected && revision === version;
  const cancel = () => {
    enterToken = undefined;
    clearTimeout(timer);
    fieldController?.abort();
    recordController?.abort();
  };
  signal?.addEventListener(
    "abort",
    () => {
      disposed = true;
      revision++;
      cancel();
    },
    { once: true },
  );
  const keyFor = (path: string, row: RecordRow) =>
    JSON.stringify([configPath(recordPath(path)), row.seq]);
  const isAdded = (path: string, row: RecordRow) => {
    const exact = configPath(recordPath(path));
    return [...selected.values()].some(
      (item) => item.seq === row.seq && item.paths.has(exact),
    );
  };
  function note(result: RecordResult): string {
    return result.diagnostics.partial
      ? `Limited scan: ${result.diagnostics.reasons.join("; ")}.`
      : "";
  }
  function renderOccurrences() {
    occurrences.replaceChildren();
    if (!activePath) return;
    occurrences.append(element("p", "", `Occurrences: ${activePath}`));
    for (const row of rows) {
      const choice = element("div", "run-event-choice");
      const value = recordValue(row.data, activePath);
      choice.append(
        element("span", "", `${provenance(row)} - ${summary(value)}`),
      );
      const add = button(isAdded(activePath, row) ? "Added" : "Add", () =>
        addValue(activePath, row),
      );
      add.setAttribute(
        "aria-label",
        `${isAdded(activePath, row) ? "Added" : "Add"} ${activePath} from event ${row.seq}`,
      );
      add.disabled = isAdded(activePath, row) || selected.size >= MAX_ADDITIONS;
      choice.append(add);
      occurrences.append(choice);
    }
    if (occurrenceNotice)
      occurrences.append(element("p", "muted", occurrenceNotice));
    if (recordCursor)
      occurrences.append(
        button("Next occurrences", () => {
          void loadRecords(activePath, recordCursor);
        }),
      );
    if (selected.size >= MAX_ADDITIONS)
      occurrences.append(
        element(
          "p",
          "muted",
          "12 event fields displayed. Remove one to add another.",
        ),
      );
  }
  function addValue(path: string, row: RecordRow, focusRemove = true) {
    const key = keyFor(path, row);
    if (isAdded(path, row) || selected.size >= MAX_ADDITIONS) return;
    const value = recordValue(row.data, path);
    if (value === undefined) return;
    const section = element("section", "run-event-config");
    section.setAttribute("aria-label", `${path} from event ${row.seq}`);
    const heading = element("div", "run-config-heading");
    heading.append(
      element("h3", "", path),
      element("span", "", provenance(row)),
    );
    const feedback = element("span", "muted");
    feedback.setAttribute("role", "status");
    if (typeof row.raw === "string") {
      heading.append(
        button("Copy raw event", async () => {
          try {
            await navigator.clipboard.writeText(row.raw!);
            feedback.textContent = "Raw event copied";
          } catch {
            feedback.textContent =
              "Copy unavailable; select the stored event text below.";
          }
        }),
      );
    }
    const remove = button("Remove", () => {
      section.remove();
      selected.delete(key);
      renderOccurrences();
      search.focus();
    });
    heading.append(remove);
    const indexed = buildConfigTree(
      { [path]: value },
      {
        exact: true,
        sourcePath: recordPath(path),
        maxFields: 1000,
        maxDepth: 16,
        maxPathBytes: 4096,
      },
    );
    const tree = renderRunConfig({}, "event", {
      eventPreview: true,
      tree: indexed,
    });
    tree.setQuery(search.value);
    section.append(heading, feedback, tree);
    if (typeof row.raw === "string") {
      const raw = element("details", "run-event-raw");
      raw.append(element("summary", "", "Stored event JSON"));
      raw.addEventListener("toggle", () => {
        if (raw.open && !raw.querySelector("pre"))
          raw.append(element("pre", "", row.raw));
      });
      section.append(raw);
    } else section.append(element("p", "muted", "Stored JSON unavailable."));
    selected.set(key, {
      section,
      tree,
      seq: row.seq,
      paths: new Set(
        indexed.nodes.flatMap((node) =>
          node.values.map((value) => value.sourcePath),
        ),
      ),
    });
    additions.append(section);
    renderOccurrences();
    if (focusRemove) remove.focus();
  }
  async function loadRecords(
    path: string,
    cursor: unknown = null,
    addSingle = false,
  ) {
    if (!live(revision)) return;
    recordController?.abort();
    const controller = (recordController = new AbortController());
    const version = revision;
    activePath = path;
    rows = [];
    recordCursor = null;
    occurrenceNotice = "Loading event occurrences\u2026";
    renderOccurrences();
    try {
      const result = await api.post<RecordResult>(
        "/rx/records",
        {
          ...body,
          filters: { conditions: [{ path, op: "exists" }] },
          limit: 5,
          cursor,
        },
        controller.signal,
      );
      if (!live(version) || controller.signal.aborted) return;
      rows = result.records.filter(
        (row) =>
          row.run_uid === source.uid &&
          recordValue(row.data, path) !== undefined,
      );
      recordCursor = result.next_cursor;
      occurrenceNotice = [
        rows.length ? "" : "No occurrences in this page.",
        note(result),
      ]
        .filter(Boolean)
        .join(" ");
      renderOccurrences();
      if (
        addSingle &&
        !cursor &&
        rows.length === 1 &&
        !recordCursor &&
        !result.diagnostics.partial
      ) {
        addValue(path, rows[0], false);
        if (isAdded(path, rows[0])) occurrences.replaceChildren();
      }
    } catch (error) {
      if (!live(version) || controller.signal.aborted) return;
      occurrenceNotice = `Could not load occurrences: ${String(error)}`;
      renderOccurrences();
      occurrences.append(
        button("Retry occurrences", () => {
          void loadRecords(path, cursor, addSingle);
        }),
      );
    }
  }
  function renderFields() {
    fields.replaceChildren();
    for (const hint of rankedEventFields(fieldHints, search.value).slice(
      0,
      fieldLimit,
    )) {
      const choose = button(`${hint.path} - ${hint.types.join(" / ")}`, () => {
        void loadRecords(hint.path);
      });
      choose.setAttribute("aria-label", `Inspect event field ${hint.path}`);
      fields.append(choose);
    }
    if (fieldHints.length > fieldLimit)
      fields.append(
        button("Show more matching fields", () => {
          fieldLimit += FIELD_PAGE;
          renderFields();
        }),
      );
    if (fieldCursor)
      fields.append(
        button("Scan more events", () => {
          void discover(fieldCursor);
        }),
      );
  }
  async function discover(cursor: unknown = null) {
    if (!live(revision)) return;
    fieldController?.abort();
    const controller = (fieldController = new AbortController());
    const version = revision;
    status.textContent = "Searching this run\u2019s logged fields\u2026";
    fields.replaceChildren();
    try {
      const result = await api.post<RecordResult>(
        "/rx/fields",
        { ...body, search: search.value.trim(), limit: 100, cursor },
        controller.signal,
      );
      if (!live(version) || controller.signal.aborted) return;
      // Each bounded scan replaces the prior hint page; never accumulate all events.
      fieldHints = result.fields;
      fieldLimit = FIELD_PAGE;
      fieldCursor = result.next_cursor;
      fieldNotice = note(result);
      status.textContent = [
        fieldHints.length ? "" : "No matching logged fields in this scan.",
        fieldNotice,
      ]
        .filter(Boolean)
        .join(" ");
      renderFields();
    } catch (error) {
      if (!live(version) || controller.signal.aborted) return;
      status.textContent = `Could not search logged fields: ${String(error)}`;
      fields.append(
        button("Retry event search", () => {
          void discover(cursor);
        }),
      );
    }
  }
  search.addEventListener("keydown", (event) => {
    if (
      event.isComposing ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    )
      return;
    if (event.key === "Escape") {
      revision++;
      cancel();
      activePath = "";
      occurrences.replaceChildren();
      status.textContent = "";
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat || enterToken || !live(revision)) return;
    const path = exactEventPath(search.value);
    if (!path) return;
    clearTimeout(timer);
    fieldController?.abort();
    status.textContent = fieldNotice;
    const token = (enterToken = {});
    void loadRecords(path, null, true).finally(() => {
      if (enterToken === token) enterToken = undefined;
    });
  });
  search.addEventListener("input", () => {
    revision++;
    cancel();
    activePath = "";
    fieldHints = [];
    fieldNotice = "";
    rows = [];
    fields.replaceChildren();
    occurrences.replaceChildren();
    for (const addition of selected.values())
      addition.tree.setQuery(search.value);
    const query = search.value.trim();
    status.textContent = query
      ? "Searching this run\u2019s logged fields\u2026"
      : "";
    if (query)
      timer = setTimeout(() => {
        void discover();
      }, 180);
  });
  status.textContent = "";
}
