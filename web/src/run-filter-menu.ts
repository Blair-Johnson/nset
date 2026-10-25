import type { Run } from "./api";
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
  OPS,
  type FilterCondition,
  type FilterField,
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
  private readonly combine = element("select");
  private fields: FilterField[] = [];
  private runs: Run[] = [];
  private cleanups: (() => void)[] = [];
  private destroyed = false;

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
      ): Promise<FieldPage>;
    },
  ) {
    this.root.dataset.menu = "run-filter";
    this.summary.setAttribute(
      "aria-label",
      "Filter runs by config, tags or events",
    );
    this.summary.title = "Filter runs by config values, tags or events";
    this.summary.append(plotIcon("filter"), this.badge);
    const head = element("div", "run-filter-head");
    head.append(element("strong", "", "Filter runs"));
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
      this.filter = {
        ...this.filter,
        conditions: [
          ...this.filter.conditions,
          {
            scope: this.runs.some((run) => run.rx) ? "event" : "params",
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
    this.root.addEventListener("keydown", (e) => {
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
      runs.some((run) => run.rx)
        ? "Filter runs by config, tags or events"
        : "Filter runs by config or tags",
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

  refreshCounts() {
    if (!this.destroyed) this.updateCounts();
  }
  destroy() {
    this.destroyed = true;
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
      : "Filter runs by config values, tags or events";
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
      out.textContent = `${n} ${c.scope === "event" ? "verified" : "match"}${field && c.scope !== "event" ? ` · ${this.runs.length - field.count} lack path` : ""}`;
    });
  }

  private render() {
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    this.combine.value = this.filter.combine;
    this.combine.disabled = this.filter.conditions.length < 2;
    this.list.replaceChildren();
    if (!this.filter.conditions.length)
      this.list.append(
        element(
          "p",
          "muted run-filter-empty",
          "Add a condition on run config, tags, or logged Event fields.",
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
        ["event", "Event"],
      ]) {
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
      scope.onchange = () => {
        update(
          {
            scope: scope.value as FilterCondition["scope"],
            path: "",
            missing: "exclude",
          },
          true,
        );
        this.list
          .querySelectorAll<HTMLInputElement>(".run-filter-path")
          [index]?.focus();
      };
      const eventScope = condition.scope === "event";
      const path = element("input", "run-filter-path");
      path.type = "text";
      path.placeholder = eventScope
        ? "metrics.accuracy"
        : "config path or tag:key";
      path.setAttribute("aria-label", `Condition ${index + 1} path`);
      path.value = condition.path ? this.label(condition) : "";
      const commitPath = () => {
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
      path.oninput = () => path.setCustomValidity("");
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
          commitPath();
          requestAnimationFrame(() => {
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
          const page = await this.events.discover(text, abort.signal);
          if (abort.signal.aborted || requested !== version || this.destroyed)
            return;
          eventFields = page.fields;
          this.fields = [
            ...this.fields.filter((f) => f.scope !== "event"),
            ...eventFields,
          ];
          path.title = page.note;
          ready = version;
          adapter.refresh();
        } catch (error) {
          if (!abort.signal.aborted && requested === version)
            path.title = "Hints unavailable; enter an exact path";
        } finally {
          if (requested === version) {
            inFlight = undefined;
          }
        }
      };
      const schedule = () => {
        if (!eventScope) return;
        version++;
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
      value.oninput = () => {
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
      const line = element("div", "run-filter-line");
      line.append(scope, path, op, value);
      const values = attachSuggestions(
        value,
        () =>
          (this.fieldFor(this.filter.conditions[index])?.examples ?? []).map(
            (text) => ({
              value: eventScope ? text : displayValue(text),
            }),
          ),
        () => update({ value: value.value }),
      );
      this.cleanups.push(() => values.dispose());
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
      if (eventScope) {
        const hint = element(
          "span",
          "muted",
          condition.op === "missing"
            ? "No event has this path"
            : condition.op === "neq"
              ? "Any present, unequal Event value"
              : "Any logged Event",
        );
        missingLine.append(hint);
      }
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
      missingLine.append(element("span", "run-filter-count muted"));
      row.append(line, missingLine);
      if (index > 0) {
        const joiner = element(
          "div",
          "run-filter-joiner",
          this.filter.combine === "any" ? "or" : "and",
        );
        this.list.append(joiner);
      }
      this.list.append(row);
    });
    this.updateBadge();
    this.updateCounts();
  }
}
