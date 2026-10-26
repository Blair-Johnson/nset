import type { Run } from "./api";
import {
  TIME_OPS,
  TIME_UNITS,
  timeConditionError,
  type TimeUnit,
} from "./run-time-filter";
import { element } from "./utils";
import { plotIcon } from "./plot-icons";
import { attachSuggestions } from "./suggest";
import { recordPath, validateRecordScalar } from "./records";
import { parseFilterValue } from "./run-filter";
import type { FieldPage } from "./run-filter-session";
import {
  activeConditions,
  describeCondition,
  filterFields,
  formatFilterValue,
  OPS,
  type FilterCondition,
  type FilterField,
  type FilterOp,
  type MissingPolicy,
  type RunFilter,
} from "./run-filter";

const MISSING: { value: MissingPolicy; label: string; hint: string }[] = [
  {
    value: "exclude",
    label: "Hide runs without it",
    hint: "Runs that do not have this path never match.",
  },
  {
    value: "include",
    label: "Keep runs without it",
    hint: "Runs that do not have this path always pass this condition.",
  },
  {
    value: "default",
    label: "Treat missing as…",
    hint: "Compare runs that lack this path as if it had the value given.",
  },
];

/** Example values are JSON text; show strings without their quotes. */
function displayValue(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
}

export interface FilterHintContext {
  filter: RunFilter;
  index: number;
}

/** Restrict the shared editor without attaching run-level matching/session state. */
export interface FilterMenuOptions {
  label?: string;
  scope?: FilterCondition["scope"];
  operators?: readonly FilterOp[];
  maxConditions?: number;
  livePaths?: boolean;
  topLayer?: boolean;
}

/**
 * Filter icon + popover for building AND/OR conditions on nested run config
 * and tags. Calls onChange with a fresh filter whenever a condition changes.
 */
export class RunFilterMenu {
  readonly root = element("details", "menu run-filter-menu");
  private readonly summary = element("summary", "run-filter-toggle");
  private readonly badge = element("span", "run-filter-badge");
  private readonly popover = element("div", "menu-popover run-filter-popover");
  private readonly list = element("div", "run-filter-conditions");
  private readonly failure = element("div", "run-filter-failure");
  private readonly error = element("p", "run-filter-error");
  private readonly combine = element("select", "run-filter-combine");
  private fields: FilterField[] = [];
  private runs: Run[] = [];
  private cleanups: (() => void)[] = [];
  private destroyed = false;
  private retryHints?: () => void;
  private readonly lifetime = new AbortController();

  constructor(
    private filter: RunFilter,
    private readonly onChange: (filter: RunFilter) => void,
    private readonly count: (filter: RunFilter) => number,
    private readonly events?: {
      retry(): void;
      discover(
        prefix: string,
        signal: AbortSignal,
        more?: boolean,
        context?: FilterHintContext,
      ): Promise<FieldPage>;
      values?(
        path: string,
        signal: AbortSignal,
        context: FilterHintContext,
      ): Promise<FieldPage>;
      hintError?(message: string): void;
    },
    private readonly options: FilterMenuOptions = {},
  ) {
    this.root.dataset.menu = "run-filter";
    this.summary.setAttribute(
      "aria-label",
      this.options.label ?? "Filter runs by config, tags, time or events",
    );
    this.summary.title =
      this.options.label ??
      "Filter runs by config values, tags, time or events";
    this.summary.append(plotIcon("filter"), this.badge);
    const head = element("div", "run-filter-head");
    head.append(element("strong", "", this.options.label ?? "Filter runs"));
    this.combine.setAttribute("aria-label", "Combine conditions");
    for (const [value, label] of [
      ["all", "Match all (AND)"],
      ["any", "Match any (OR)"],
    ]) {
      const o = element("option", "", label);
      o.value = value;
      this.combine.append(o);
    }
    this.combine.onchange = () => {
      this.filter = {
        ...this.filter,
        combine: this.combine.value as "all" | "any",
      };
      this.emit();
      this.render();
    };
    head.append(this.combine);
    const add = element("button", "run-filter-add", "+ Add condition");
    add.type = "button";
    add.onclick = () => {
      if (
        this.filter.conditions.length >=
        (this.options.maxConditions ?? Infinity)
      )
        return;
      this.filter = {
        ...this.filter,
        conditions: [
          ...this.filter.conditions,
          {
            scope:
              this.options.scope ??
              (this.runs.some((run) => run.rx) ? "event" : "params"),
            path: "",
            op: "eq",
            value: "",
            missing: "exclude",
          },
        ],
      };
      this.emit();
      this.render();
      this.list
        .querySelector<HTMLInputElement>(
          ".run-filter-row:last-child .run-filter-path",
        )
        ?.focus();
    };
    const clear = element("button", "text-link", "Clear all");
    clear.type = "button";
    clear.onclick = () => {
      this.filter = { ...this.filter, conditions: [] };
      this.emit();
      this.render();
    };
    const foot = element("div", "run-filter-foot");
    foot.append(add, clear);
    const retry = element("button", "text-link run-filter-retry", "Retry");
    retry.type = "button";
    retry.setAttribute("aria-label", "Retry filter search");
    retry.onclick = () => this.events?.retry();
    this.error.setAttribute("role", "status");
    this.failure.hidden = true;
    this.failure.append(this.error, retry);
    this.popover.append(head, this.failure, this.list, foot);
    this.root.append(this.summary, this.popover);
    if (this.options.topLayer) {
      this.popover.setAttribute("popover", "manual");
      this.popover.classList.add("run-filter-floating");
      const position = () => {
        if (!this.root.open) return;
        const anchor = this.summary.getBoundingClientRect();
        const box = this.popover.getBoundingClientRect();
        this.popover.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - box.width - 12))}px`;
        this.popover.style.top = `${Math.max(12, Math.min(anchor.bottom + 4, innerHeight - box.height - 12))}px`;
      };
      this.root.addEventListener(
        "toggle",
        () => {
          if (this.root.open && this.root.isConnected) {
            this.popover.showPopover();
            position();
          } else if (this.popover.matches(":popover-open"))
            this.popover.hidePopover();
        },
        { signal: this.lifetime.signal },
      );
      const resize = new ResizeObserver(position);
      resize.observe(this.popover);
      this.lifetime.signal.addEventListener(
        "abort",
        () => resize.disconnect(),
        { once: true },
      );
      window.addEventListener("resize", position, {
        signal: this.lifetime.signal,
      });
      document.addEventListener("scroll", position, {
        capture: true,
        signal: this.lifetime.signal,
      });
      document.addEventListener(
        "pointerdown",
        (e) => {
          if (e.target instanceof Node && !this.root.contains(e.target))
            this.root.open = false;
        },
        { signal: this.lifetime.signal },
      );
    }
    this.root.addEventListener("keydown", (e) => {
      // A condition editor embedded in a form must never submit its host.
      if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (e.key === "Escape" && this.root.open) {
        e.preventDefault();
        e.stopPropagation();
        this.root.open = false;
        this.summary.focus();
      }
    });
    this.render();
  }

  setRuns(runs: Run[]) {
    this.runs = runs;
    this.summary.setAttribute(
      "aria-label",
      this.options.label ??
        (runs.some((run) => run.rx)
          ? "Filter runs by config, tags, time or events"
          : "Filter runs by config or tags"),
    );
    this.fields = filterFields(runs);
    this.render();
  }

  setFilter(filter: RunFilter) {
    if (
      this.destroyed ||
      JSON.stringify(this.filter) === JSON.stringify(filter)
    )
      return;
    this.filter = structuredClone(filter);
    this.render();
  }
  setError(error: string) {
    this.error.textContent = error ? `Filter failed: ${error}` : "";
    this.failure.hidden = !error;
  }

  refreshHints() {
    this.retryHints?.();
  }

  refreshCounts() {
    if (!this.destroyed) this.updateCounts();
  }
  destroy() {
    this.destroyed = true;
    this.lifetime.abort();
    if (this.popover.matches(":popover-open")) this.popover.hidePopover();
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
  }

  private fieldFor(c: FilterCondition) {
    return this.fields.find((f) => f.scope === c.scope && f.path === c.path);
  }
  private fieldByLabel(label: string, event: boolean) {
    return this.fields.find(
      (f) => f.label === label.trim() && (f.scope === "event") === event,
    );
  }
  label(c: FilterCondition) {
    return this.fieldFor(c)?.label ?? c.path;
  }

  private emit() {
    this.onChange(structuredClone(this.filter));
    this.updateBadge();
    this.updateCounts();
  }
  private updateBadge() {
    const n = activeConditions(this.filter).length;
    this.badge.textContent = n ? String(n) : "";
    this.badge.hidden = !n;
    this.root.classList.toggle("active", n > 0);
    this.summary.title = n
      ? `${n} filter condition${n === 1 ? "" : "s"}: ${activeConditions(
          this.filter,
        )
          .map((c) => describeCondition(c, this.label(c)))
          .join(this.filter.combine === "any" ? " OR " : " AND ")}`
      : (this.options.label ??
        "Filter runs by config values, tags, time or events");
  }
  private updateCounts() {
    const rows = this.list.querySelectorAll<HTMLElement>(".run-filter-row");
    this.filter.conditions.forEach((c, i) => {
      const out = rows[i]?.querySelector(".run-filter-count");
      if (!out) return;
      if (!c.path) {
        out.textContent = "";
        return;
      }
      const n = this.count({ combine: "all", conditions: [c] });
      const field = this.fieldFor(c);
      out.textContent = `${n} match${field ? ` · ${this.runs.length - field.count} lack path` : ""}`;
    });
  }

  private renderTimeRow(
    row: HTMLElement,
    scope: HTMLSelectElement,
    condition: FilterCondition,
    index: number,
    update: (patch: Partial<FilterCondition>, rerender?: boolean) => void,
  ) {
    const line = element("div", "run-filter-line run-filter-time-line");
    const field = element("select", "run-filter-path");
    field.setAttribute("aria-label", `Condition ${index + 1} time field`);
    for (const [value, label] of [
      ["created_at", "Created"],
      ["updated_at", "Updated"],
    ]) {
      const option = element("option", "", label);
      option.value = value;
      field.append(option);
    }
    field.value = condition.path;
    if (this.runs.some((run) => run.rx))
      field.title =
        "For rx runs, Updated uses finish time, then start time, then creation time.";
    field.onchange = () => update({ path: field.value });
    const op = element("select", "run-filter-op");
    op.setAttribute("aria-label", `Condition ${index + 1} operator`);
    for (const item of TIME_OPS) {
      const option = element("option", "", item.label);
      option.value = item.op;
      op.append(option);
    }
    op.value = condition.op;
    op.onchange = () => {
      const current = this.filter.conditions[index];
      const relative = op.value === "last" || op.value === "older";
      const wasRelative = current.op === "last" || current.op === "older";
      const precision = op.value === "on" ? undefined : current.precision;
      let value =
        relative === wasRelative ? current.value : relative ? "7" : "";
      if (op.value === "on") value = value.slice(0, 10);
      update(
        {
          op: op.value as FilterOp,
          value,
          precision,
          unit: current.unit ?? "days",
        },
        true,
      );
    };
    line.append(scope, field, op);
    const relative = condition.op === "last" || condition.op === "older";
    const precise = condition.precision === "datetime";
    const error = element("span", "run-filter-time-error");
    error.setAttribute("role", "status");
    const inputs: HTMLInputElement[] = [];
    const validate = () => {
      const message = timeConditionError(this.filter.conditions[index]);
      error.textContent = message;
      for (const input of inputs) {
        input.setCustomValidity(message);
        input.setAttribute("aria-invalid", String(!!message));
      }
    };
    if (condition.op !== "today" && condition.op !== "yesterday") {
      const value = element("input", "run-filter-value");
      value.type = relative ? "number" : precise ? "datetime-local" : "date";
      value.setAttribute(
        "aria-label",
        `Condition ${index + 1} ${relative ? "duration" : "date"}`,
      );
      if (relative) {
        value.min = "0";
        value.step = "any";
      } else if (precise) value.step = "1";
      value.value = condition.value;
      value.oninput = () => {
        update({ value: value.value });
        validate();
      };
      inputs.push(value);
      line.append(value);
      if (relative) {
        const unit = element("select", "run-filter-time-unit");
        unit.setAttribute("aria-label", `Condition ${index + 1} unit`);
        for (const key of Object.keys(TIME_UNITS)) {
          const option = element("option", "", key);
          option.value = key;
          unit.append(option);
        }
        unit.value = condition.unit ?? "days";
        unit.onchange = () => {
          update({ unit: unit.value as TimeUnit });
          validate();
        };
        line.append(unit);
      } else if (condition.op === "between") {
        const end = element("input", "run-filter-value");
        end.type = precise ? "datetime-local" : "date";
        if (precise) end.step = "1";
        end.setAttribute("aria-label", `Condition ${index + 1} end date`);
        end.value = condition.valueTo ?? "";
        end.oninput = () => {
          update({ valueTo: end.value });
          validate();
        };
        inputs.push(end);
        line.append(element("span", "", "to"), end);
      }
    }
    const remove = element("button", "run-filter-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove condition ${index + 1}`);
    remove.onclick = () => {
      this.filter = {
        ...this.filter,
        conditions: this.filter.conditions.filter((_, i) => i !== index),
      };
      this.emit();
      this.render();
    };
    line.append(remove);
    row.append(line);
    if (!relative) {
      const help = element("div", "run-filter-time-help muted");
      if (["before", "after", "between"].includes(condition.op)) {
        const label = element("label", "run-filter-time-precision");
        const toggle = element("input");
        toggle.type = "checkbox";
        toggle.checked = precise;
        toggle.setAttribute(
          "aria-label",
          `Condition ${index + 1} include time`,
        );
        toggle.onchange = () => {
          const withTime = toggle.checked;
          const convert = (text: string) =>
            !text
              ? ""
              : withTime
                ? `${text.slice(0, 10)}T00:00`
                : text.slice(0, 10);
          const current = this.filter.conditions[index];
          update(
            {
              precision: withTime ? "datetime" : "date",
              value: convert(current.value),
              valueTo: convert(current.valueTo ?? ""),
            },
            true,
          );
        };
        label.append(toggle, element("span", "", "Include time"));
        help.append(label);
      }
      help.append(
        element(
          "span",
          "",
          `Local time (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
        ),
      );
      row.append(help);
    }
    row.append(error, element("span", "run-filter-count muted"));
    validate();
  }
  private render() {
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    this.retryHints = undefined;
    const add = this.root.querySelector<HTMLButtonElement>(".run-filter-add");
    if (add)
      add.disabled =
        this.filter.conditions.length >=
        (this.options.maxConditions ?? Infinity);
    this.combine.value = this.filter.combine;
    this.combine.disabled = this.filter.conditions.length < 2;
    this.list.replaceChildren();
    if (!this.filter.conditions.length)
      this.list.append(
        element(
          "p",
          "muted run-filter-empty",
          this.options.scope
            ? "Add a condition."
            : "Add a condition on run config, tags, time, or logged Event fields.",
        ),
      );
    this.filter.conditions.forEach((condition, index) => {
      const row = element("div", "run-filter-row");
      const update = (patch: Partial<FilterCondition>, rerender = false) => {
        const conditions = [...this.filter.conditions];
        conditions[index] = { ...conditions[index], ...patch };
        this.filter = { ...this.filter, conditions };
        this.emit();
        if (rerender) {
          const label = document.activeElement?.getAttribute("aria-label");
          this.render();
          if (label)
            [...this.list.querySelectorAll<HTMLElement>("[aria-label]")]
              .find((node) => node.getAttribute("aria-label") === label)
              ?.focus();
        }
      };
      const scope = element("select", "run-filter-scope");
      scope.setAttribute("aria-label", `Condition ${index + 1} scope`);
      for (const [key, label] of [
        ["params", "Config"],
        ["tags", "Tag"],
        ["time", "Time"],
        ["event", "Event"],
      ]) {
        if (this.options.scope && key !== this.options.scope) continue;
        if (
          key === "event" &&
          !this.runs.some((run) => run.rx) &&
          condition.scope !== "event"
        )
          continue;
        const option = element("option", "", label);
        option.value = key;
        scope.append(option);
      }
      scope.value = condition.scope;
      scope.disabled = !!this.options.scope;
      scope.onchange = () => {
        update(
          {
            scope: scope.value as FilterCondition["scope"],
            path: scope.value === "time" ? "created_at" : "",
            op: scope.value === "time" ? "last" : "eq",
            value: scope.value === "time" ? "7" : "",
            unit: scope.value === "time" ? "days" : undefined,
            valueTo: undefined,
            precision: undefined,
            missing: "exclude",
          },
          true,
        );
        this.list
          .querySelectorAll<HTMLInputElement>(".run-filter-path")
          [index]?.focus();
      };
      if (index > 0)
        this.list.append(
          element(
            "div",
            "run-filter-joiner",
            this.filter.combine === "any" ? "or" : "and",
          ),
        );
      if (condition.scope === "time") {
        this.renderTimeRow(row, scope, condition, index, update);
        this.list.append(row);
        return;
      }
      const eventScope = condition.scope === "event";
      const path = element("input", "run-filter-path");
      path.type = "text";
      path.placeholder = eventScope
        ? "metrics.accuracy"
        : "config path or tag:key";
      path.setAttribute("aria-label", `Condition ${index + 1} path`);
      path.value = condition.path ? this.label(condition) : "";
      const commitPath = () => {
        path.setCustomValidity("");
        const text = path.value.trim();
        const field = this.fieldByLabel(text, eventScope);
        if (field) {
          scope.value = field.scope;
          update({ scope: field.scope, path: field.path });
        } else if (eventScope && text) {
          try {
            recordPath(text);
            update({ path: text });
          } catch (error) {
            path.setCustomValidity(
              error instanceof Error ? error.message : String(error),
            );
            path.reportValidity();
          }
        } else if (text.startsWith("$")) update({ path: text });
        else if (!text) update({ path: "" });
        else {
          path.setCustomValidity(
            "Unknown path. Pick one from the suggestions.",
          );
          path.reportValidity();
        }
      };
      path.onchange = commitPath;
      path.oninput = () => {
        path.setCustomValidity("");
        if (this.options.livePaths) update({ path: path.value.trim() });
      };
      let pending: AbortController | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let version = 0,
        ready = -1;
      let inFlight: Promise<void> | undefined;
      let eventFields: FilterField[] = [];
      const suggestions = () => {
        const query = path.value.trim().toLowerCase();
        const fields = eventScope
          ? eventFields
          : this.fields.filter((f) => f.scope !== "event");
        const rank = (f: FilterField) =>
          f.label === path.value.trim()
            ? 0
            : f.label.toLowerCase() === query
              ? 1
              : f.label.toLowerCase().startsWith(query)
                ? 2
                : 3;
        return [...fields]
          .sort((a, b) => rank(a) - rank(b))
          .map((f) => ({
            value: f.label,
            detail: `${f.scope === "event" ? `Event · ${f.types?.join("/") ?? ""} · ` : ""}${f.examples.slice(0, 3).map(displayValue).join(", ")}`,
          }));
      };
      const adapter = attachSuggestions(
        path,
        suggestions,
        () => {
          const completedVersion = version;
          commitPath();
          requestAnimationFrame(() => {
            if (
              this.destroyed ||
              document.activeElement !== path ||
              version !== completedVersion
            )
              return;
            const row =
              this.list.querySelectorAll<HTMLElement>(".run-filter-row")[index];
            const value =
              row?.querySelector<HTMLInputElement>(".run-filter-value");
            (value && !value.hidden
              ? value
              : row?.querySelector<HTMLSelectElement>(".run-filter-op")
            )?.focus();
          });
        },
        () => true,
        () => {
          if (eventScope && ready !== version) {
            clearTimeout(timer);
            return inFlight ?? (inFlight = discover());
          }
        },
      );
      const discover = async () => {
        if (!this.events || !eventScope) return;
        pending?.abort();
        const abort = (pending = new AbortController());
        const requested = version,
          text = path.value.trim();
        try {
          const context = { filter: structuredClone(this.filter), index };
          const page = await this.events.discover(
            text,
            abort.signal,
            false,
            context,
          );
          if (abort.signal.aborted || requested !== version || this.destroyed)
            return;
          this.events.hintError?.("");
          eventFields = page.fields;
          if (!this.events.values)
            this.fields = [
              ...this.fields.filter((f) => f.scope !== "event"),
              ...eventFields,
            ];
          path.title = page.note;
          ready = version;
          adapter.refresh();
        } catch (error) {
          if (
            !abort.signal.aborted &&
            requested === version &&
            !this.destroyed
          ) {
            path.title = "Hints unavailable; enter an exact path";
            this.events?.hintError?.(
              error instanceof Error ? error.message : String(error),
            );
          }
        } finally {
          if (requested === version) {
            inFlight = undefined;
          }
        }
      };
      const schedule = () => {
        if (!eventScope) return;
        version++;
        this.retryHints = () => {
          version++;
          inFlight = discover();
        };
        pending?.abort();
        clearTimeout(timer);
        inFlight = undefined;
        eventFields = [];
        adapter.close();
        timer = setTimeout(() => {
          inFlight = discover();
        }, 180);
      };
      path.addEventListener("input", schedule);
      path.addEventListener("focus", schedule);
      path.addEventListener("blur", () => {
        pending?.abort();
        clearTimeout(timer);
        version++;
        inFlight = undefined;
      });
      path.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.defaultPrevented) {
          e.preventDefault();
          commitPath();
        }
      });
      this.cleanups.push(() => {
        pending?.abort();
        clearTimeout(timer);
        adapter.dispose();
      });
      const op = element("select", "run-filter-op");
      op.setAttribute("aria-label", `Condition ${index + 1} operator`);
      for (const o of OPS) {
        if (this.options.operators && !this.options.operators.includes(o.op))
          continue;
        const option = element("option", "", o.label);
        option.value = o.op;
        op.append(option);
      }
      op.value = condition.op;
      op.onchange = () =>
        update({ op: op.value as FilterCondition["op"] }, true);
      const value = element("input", "run-filter-value");
      value.type = "text";
      value.placeholder = "value";
      value.setAttribute("aria-label", `Condition ${index + 1} value`);
      value.value = condition.value;
      value.hidden = condition.op === "exists" || condition.op === "missing";
      if (eventScope)
        value.title = 'Typed JSON scalar; quote numeric strings ("0.001")';
      const commitValue = () => {
        value.setCustomValidity("");
        if (eventScope) {
          try {
            validateRecordScalar(parseFilterValue(value.value));
          } catch (error) {
            value.setCustomValidity(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        update({ value: value.value });
      };
      value.oninput = commitValue;
      const line = element("div", "run-filter-line");
      line.append(scope, path, op, value);
      const values = attachSuggestions(
        value,
        () =>
          (
            (this.events?.values
              ? valueFields.find(
                  (f) => f.path === this.filter.conditions[index].path,
                )
              : this.fieldFor(this.filter.conditions[index])
            )?.examples ?? []
          ).map((text) => ({
            value: eventScope
              ? formatFilterValue(JSON.parse(text))
              : displayValue(text),
            detail: eventScope
              ? JSON.parse(text) === null
                ? "null"
                : typeof JSON.parse(text)
              : undefined,
          })),
        commitValue,
        // Samples are not exhaustive. Never rewrite a complete typed scalar
        // (e.g. 1 to the sampled 10); explicit highlighted picks still work.
        () =>
          !this.events?.values ||
          (!!value.value.trim() &&
            typeof parseFilterValue(value.value) === "string" &&
            !value.value.trim().startsWith('"')),
        () => (valueReady ? undefined : (valueFlight ??= discoverValues())),
      );
      let valueFields: FilterField[] = [];
      let valuePending: AbortController | undefined;
      let valueFlight: Promise<void> | undefined;
      let valueReady = !this.events?.values;
      const discoverValues = async () => {
        if (!this.events?.values) return;
        valuePending?.abort();
        const abort = (valuePending = new AbortController());
        const current = this.filter.conditions[index];
        try {
          const page = await this.events.values(current.path, abort.signal, {
            filter: structuredClone(this.filter),
            index,
          });
          if (abort.signal.aborted || this.destroyed) return;
          this.events.hintError?.("");
          valueFields = page.fields;
          valueReady = true;
          values.refresh();
        } catch (error) {
          if (!abort.signal.aborted && !this.destroyed) {
            valueReady = true;
            this.events.hintError?.(
              error instanceof Error ? error.message : String(error),
            );
          }
        } finally {
          if (!abort.signal.aborted) valueFlight = undefined;
        }
      };
      value.addEventListener("focus", () => {
        if (!this.events?.values) return;
        valueReady = false;
        // Never complete from another row's or a previous query's examples.
        valueFields = [];
        values.close();
        this.retryHints = () => {
          valueReady = false;
          valueFlight = discoverValues();
        };
        valueFlight = discoverValues();
      });
      value.addEventListener("blur", () => {
        valuePending?.abort();
        valueFlight = undefined;
        valueReady = !this.events?.values;
      });
      this.cleanups.push(() => {
        valuePending?.abort();
        values.dispose();
      });
      const remove = element("button", "run-filter-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove condition ${index + 1}`);
      remove.title = "Remove condition";
      remove.onclick = () => {
        const conditions = this.filter.conditions.filter((_, i) => i !== index);
        this.filter = { ...this.filter, conditions };
        this.emit();
        this.render();
      };
      line.append(remove);
      const missingLine = element("div", "run-filter-line run-filter-missing");
      const missingLabel = element("label");
      missingLabel.append("If a run lacks this path: ");
      const missing = element("select");
      missing.setAttribute(
        "aria-label",
        `Condition ${index + 1} missing-path handling`,
      );
      for (const m of MISSING) {
        const option = element("option", "", m.label);
        option.value = m.value;
        option.title = m.hint;
        missing.append(option);
      }
      missing.value = condition.missing;
      missing.title = MISSING.find((m) => m.value === condition.missing)!.hint;
      missing.onchange = () =>
        update({ missing: missing.value as MissingPolicy }, true);
      missingLabel.append(missing);
      if (!eventScope && condition.op !== "missing")
        missingLine.append(missingLabel);
      if (!eventScope && condition.missing === "default") {
        const fallback = element("input", "run-filter-fallback");
        fallback.type = "text";
        fallback.placeholder = "value";
        fallback.setAttribute(
          "aria-label",
          `Condition ${index + 1} value when missing`,
        );
        fallback.value = condition.fallback ?? "";
        fallback.oninput = () => update({ fallback: fallback.value });
        missingLine.append(fallback);
      }
      row.append(line);
      if (!eventScope) {
        missingLine.append(element("span", "run-filter-count muted"));
        row.append(missingLine);
      }
      this.list.append(row);
    });
    this.updateBadge();
    this.updateCounts();
  }
}
