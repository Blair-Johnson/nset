import type { Api } from "./api";
import type { Catalog } from "./workspace-types";
import { attachSuggestions, type Suggestion } from "./suggest";
import { element } from "./utils";
import { RunFilterMenu, type FilterHintContext } from "./run-filter-menu";
import {
  menuToRecordFilters,
  recordFilterToMenu,
  RECORD_FILTER_OPERATORS,
} from "./record-filter";
import type { FieldPage } from "./run-filter-session";
import { formatFilterValue } from "./run-filter";
import {
  recordPath,
  recordRequest,
  recordRuns,
  recordNotes,
  recordValue,
  type RecordBinding,
  type RecordResult,
  type FieldHint,
} from "./records";

function recordCell(value: unknown): string {
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return `array (${value.length})`;
  if (value !== null && typeof value === "object") return "object";
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  )
    return "unsafe integer (see exact raw JSON)";
  const text = JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}
let nextId = 0;
export function mountRecordControls(
  data: HTMLElement,
  xPanel: HTMLElement,
  options: {
    binding: RecordBinding;
    catalog: Catalog;
    selected: string[];
    api?: Api;
    changed(): void;
    error(message: string): void;
  },
): { destroy(): void } {
  const { binding: b, api } = options;
  const lifetime = new AbortController();
  const cleanups: (() => void)[] = [];
  const invalidate: (() => void)[] = [];
  const errors = new Map<string, string>();
  const status = element("p", "ce-help");
  status.setAttribute("role", "status");
  const setError = (key: string, message: string) => {
    if (message) errors.set(key, message);
    else errors.delete(key);
    options.error([...errors.values()].join(" "));
  };
  const button = (text: string, action: () => void) => {
    const el = element("button", "", text);
    el.type = "button";
    el.onclick = action;
    return el;
  };
  const field = (host: HTMLElement, label: string, value = "") => {
    const row = element("div", "ce-field");
    const labelNode = element("label", "ce-label", label);
    const input = element("input");
    input.value = value;
    input.type = "text";
    input.id = `record-field-${++nextId}`;
    labelNode.htmlFor = input.id;
    row.append(labelNode, input);
    host.append(row);
    return input;
  };
  const request = () => recordRequest(b, options.catalog, options.selected);
  let inspectionAbort: AbortController | undefined;
  let inspectionVersion = 0;
  let nextCursor: unknown | null = null;
  const table = element("div", "record-inspection");
  const pageStatus = element("p", "ce-help");
  const next = button("Next records", () => void inspect(nextCursor));
  next.disabled = true;
  const resetInspection = () => {
    inspectionAbort?.abort();
    inspectionVersion++;
    nextCursor = null;
    next.disabled = true;
    table.replaceChildren();
    pageStatus.textContent =
      "Filters or fields changed. Load records to inspect the current selection.";
  };
  const changed = () => {
    resetInspection();
    invalidate.forEach((fn) => fn());
    options.changed();
  };

  function suggest(input: HTMLInputElement, commit: (value: string) => void) {
    let hints: FieldHint[] = [],
      suggestions: Suggestion[] = [];
    let readyVersion = -1,
      requestedVersion = -1;
    let inFlight: Promise<void> | undefined;
    let pending: AbortController | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      generation = 0;
    const picked = (value: string) => {
      const hint = hints.find((h) => h.path === value);
      if (hint?.types.includes("object")) {
        input.value = `${value}.`;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      if (hint?.types.includes("array") && hint.types.length === 1) {
        input.value = `${value}[`;
        status.textContent =
          "Arrays require an explicit index, for example [0].";
        return;
      }
      commit(value);
    };
    const adapter = attachSuggestions(
      input,
      () => suggestions,
      picked,
      // Offered paths are valid even when discovery is sampled/truncated.
      () => true,
      ensureHints,
    );
    function ensureHints(): Promise<void> | undefined {
      if (!api || lifetime.signal.aborted || readyVersion === generation)
        return;
      clearTimeout(timer);
      if (requestedVersion !== generation) {
        requestedVersion = generation;
        inFlight = refresh(generation);
      }
      return inFlight;
    }
    async function refresh(version: number) {
      if (
        !api ||
        !input.isConnected ||
        document.activeElement !== input ||
        lifetime.signal.aborted
      )
        return;
      pending?.abort();
      const controller = (pending = new AbortController());
      const prefix = input.value;
      const filters = structuredClone(b.filters);
      // Do not send incomplete other conditions as an accidental global query.
      try {
        const result = await api.post<RecordResult>(
          "/rx/fields",
          { ...request(), filters, prefix },
          controller.signal,
        );
        if (
          version !== generation ||
          lifetime.signal.aborted ||
          controller.signal.aborted ||
          input.value !== prefix
        )
          return;
        hints = result.fields;

        suggestions = hints.map((h) => ({
          value: h.path,
          detail: `${h.types.join("/")}${h.values.length ? ` · ${h.values.map(formatFilterValue).join(", ")}` : ""}`,
        }));
        status.textContent = "";
        adapter.refresh();
      } catch (error) {
        if (
          version !== generation ||
          lifetime.signal.aborted ||
          controller.signal.aborted
        )
          return;
        status.textContent = `Field hints unavailable: ${error instanceof Error ? error.message : String(error)}.`;
      } finally {
        if (version === generation) readyVersion = version;
      }
    }
    const schedule = () => {
      generation++;
      pending?.abort();
      clearTimeout(timer);
      suggestions = [];
      hints = [];
      readyVersion = -1;
      adapter.close();
      timer = setTimeout(() => void ensureHints(), 120);
    };
    invalidate.push(schedule);
    input.addEventListener("input", schedule, { signal: lifetime.signal });
    input.addEventListener("focus", schedule, { signal: lifetime.signal });
    input.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter") {
          if (!event.defaultPrevented) commit(input.value);
          event.preventDefault();
          event.stopPropagation();
        }
      },
      { signal: lifetime.signal },
    );
    cleanups.push(() => {
      pending?.abort();
      clearTimeout(timer);
      adapter.dispose();
    });
  }
  function pathInput(
    host: HTMLElement,
    label: string,
    value: string,
    commit: (value: string) => void,
    optional = false,
  ) {
    const input = field(host, label, value);
    input.placeholder = optional
      ? "None (optional field…)"
      : "Type an exact field path…";
    const message = element("span", "ce-error");
    message.setAttribute("role", "alert");
    input.after(message);
    const accept = (text: string) => {
      try {
        if (!(optional && !text)) recordPath(text);
        message.textContent = "";
        input.removeAttribute("aria-invalid");
        setError(input.id, "");
        commit(text);
        changed();
      } catch (error) {
        const text = (error as Error).message;
        message.textContent = text;
        input.setAttribute("aria-invalid", "true");
        setError(input.id, `${label}: ${text}`);
      }
    };
    input.addEventListener("blur", () => accept(input.value), {
      signal: lifetime.signal,
    });
    suggest(input, accept);
    return input;
  }
  data.append(
    element(
      "p",
      "ce-selection-summary",
      `Read-only rx records · ${recordRuns(b, options.catalog, options.selected).length} selected runs.`,
    ),
  );
  if (options.catalog.rx?.error)
    data.append(element("p", "ce-error", options.catalog.rx.error));
  if (options.catalog.rx?.nextAfter != null)
    data.append(
      element(
        "p",
        "ce-help",
        "More run metadata is available: use Load more rx runs in the run table.",
      ),
    );
  const chips = element("div", "ce-chips");
  chips.setAttribute("aria-label", "Chosen record Y fields");
  data.append(chips);
  const renderChips = () =>
    chips.replaceChildren(
      ...b.ys.map((y) => {
        const chip = button(`${y} ×`, () => {
          b.ys = b.ys.filter((v) => v !== y);
          renderChips();
          changed();
        });
        chip.className = "ce-chip";
        chip.setAttribute("aria-label", `Remove Y field ${y}`);
        return chip;
      }),
    );
  renderChips();
  const y = field(data, "Add Y field");
  y.placeholder = "metrics.loss or train_loss…";
  const addY = (value: string) => {
    if (!value) return;
    try {
      recordPath(value);
      if (!b.ys.includes(value)) {
        if (b.ys.length >= 16) throw new Error("At most 16 Y fields.");
        b.ys.push(value);
      }
      setError(y.id, "");
      y.value = "";
      renderChips();
      changed();
    } catch (error) {
      status.textContent = (error as Error).message;
      setError(y.id, (error as Error).message);
    }
  };
  suggest(y, addY);
  data.append(button("Add Y", () => addY(y.value)));
  pathInput(xPanel, "Record X field", b.x, (value) => {
    b.x = value;
  });
  pathInput(
    data,
    "Group by",
    b.group ?? "",
    (value) => {
      if (value) b.group = value;
      else delete b.group;
    },
    true,
  );
  let validationError = "",
    hintError = "";
  let conditionCount = b.filters.conditions.length;
  const showFilterError = () => menu.setError(validationError || hintError);
  const discover = async (
    prefix: string,
    signal: AbortSignal,
    context?: FilterHintContext,
  ): Promise<FieldPage> => {
    if (!api) return { fields: [], more: false, note: "" };
    const filters = context
      ? menuToRecordFilters(context.filter, context.index)
      : b.filters;
    const result = await api.post<RecordResult>(
      "/rx/fields",
      { ...request(), filters, prefix },
      signal,
    );
    return {
      fields: result.fields.map((h) => ({
        scope: "event",
        path: h.path,
        label: h.path,
        count: h.present,
        types: h.types,
        examples: h.values.map((value) => JSON.stringify(value)),
      })),
      more: false,
      note: "",
    };
  };
  const menu = new RunFilterMenu(
    recordFilterToMenu(b.filters),
    (filter) => {
      // A removed row must not leave an un-retryable hint error behind.
      if (filter.conditions.length !== conditionCount) hintError = "";
      conditionCount = filter.conditions.length;
      try {
        const filters = menuToRecordFilters(filter);
        validationError = "";
        setError("filters", "");
        if (JSON.stringify(filters) !== JSON.stringify(b.filters)) {
          b.filters = filters;
          changed();
        }
      } catch (error) {
        validationError =
          error instanceof Error ? error.message : String(error);
        setError("filters", validationError);
      }
      showFilterError();
    },
    () => 0, // No run proof/count semantics in a record predicate editor.
    {
      retry: () => menu.refreshHints(),
      discover: (prefix, signal, _more, context) =>
        discover(prefix, signal, context),
      values: discover,
      hintError: (message) => {
        hintError = message;
        showFilterError();
      },
    },
    {
      label: "Filter records",
      scope: "event",
      operators: RECORD_FILTER_OPERATORS,
      maxConditions: 16,
      livePaths: true,
      topLayer: true,
    },
  );
  const filterControl = element("div", "ce-record-filters");
  filterControl.append(
    element("span", "ce-label", "Filter records"),
    menu.root,
  );
  data.append(filterControl, status);
  cleanups.push(() => menu.destroy());

  const inspection = element("details", "ce-more");
  inspection.append(element("summary", "", "Inspect records"));
  async function inspect(cursor: unknown | null = null) {
    if (!api) {
      pageStatus.textContent = "Connect to inspect records.";
      return;
    }
    inspectionAbort?.abort();
    const controller = (inspectionAbort = new AbortController());
    const version = ++inspectionVersion;
    pageStatus.textContent = "Loading up to 25 records…";
    next.disabled = true;
    try {
      const result = await api.post<RecordResult>(
        "/rx/records",
        { ...request(), limit: 25, cursor },
        controller.signal,
      );
      if (
        lifetime.signal.aborted ||
        controller.signal.aborted ||
        version !== inspectionVersion
      )
        return;
      table.replaceChildren();
      for (const row of result.records) {
        const details = element("details");
        const run = options.catalog.runs.find((r) => r.rx?.uid === row.run_uid);
        const values = [b.x, ...b.ys].filter(Boolean).map((path) => {
          try {
            return `${path}=${recordCell(recordValue(row.data, path))}`;
          } catch {
            return `${path}=invalid path`;
          }
        });
        details.append(
          element(
            "summary",
            "",
            `${run?.name ?? row.run_uid} · seq ${row.seq} · ${row.received_at} · ${values.join(" · ")}`,
          ),
        );
        // Raw JSON is bounded server-side; never interpret source strings as HTML.
        const pre = element("pre");
        details.addEventListener("toggle", () => {
          if (details.open && !pre.textContent)
            pre.textContent = row.raw ?? JSON.stringify(row.data, null, 2);
        });
        details.append(
          pre,
          button(
            "Copy raw record",
            () =>
              void navigator.clipboard.writeText(
                row.raw ?? JSON.stringify(row.data, null, 2),
              ),
          ),
        );
        table.append(details);
      }
      nextCursor = result.next_cursor;
      next.disabled = nextCursor === null;
      pageStatus.textContent = recordNotes(result);
    } catch (error) {
      if (!controller.signal.aborted && version === inspectionVersion)
        pageStatus.textContent = `Inspection unavailable: ${(error as Error).message}`;
    }
  }
  inspection.append(
    button("Load records", () => void inspect()),
    next,
    pageStatus,
    table,
  );
  data.append(inspection);
  return {
    destroy() {
      lifetime.abort();
      inspectionAbort?.abort();
      cleanups.forEach((fn) => fn());
      options.error("");
    },
  };
}
