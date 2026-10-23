import type { Run } from "./api";
import { element } from "./utils";
import { plotIcon } from "./plot-icons";
import { attachSuggestions } from "./suggest";
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
  private readonly combine = element("select");
  private fields: FilterField[] = [];
  private runs: Run[] = [];

  constructor(
    private filter: RunFilter,
    private readonly onChange: (filter: RunFilter) => void,
    private readonly count: (filter: RunFilter) => number,
  ) {
    this.root.dataset.menu = "run-filter";
    this.summary.setAttribute("aria-label", "Filter runs by config or tags");
    this.summary.title = "Filter runs by config values or tags";
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
            scope: "params",
            path: "",
            op: "eq",
            value: "",
            missing: "exclude",
          },
        ],
      };
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
    this.popover.append(head, this.list, foot);
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
    this.fields = filterFields(runs);
    this.render();
  }

  private fieldFor(c: FilterCondition) {
    return this.fields.find((f) => f.scope === c.scope && f.path === c.path);
  }
  private fieldByLabel(label: string) {
    return this.fields.find((f) => f.label === label.trim());
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
      : "Filter runs by config values or tags";
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

  private render() {
    this.combine.value = this.filter.combine;
    this.combine.disabled = this.filter.conditions.length < 2;
    this.list.replaceChildren();
    if (!this.filter.conditions.length)
      this.list.append(
        element(
          "p",
          "muted run-filter-empty",
          "No conditions. Add one to filter on any config path (e.g. train.optim.lr) or tag.",
        ),
      );
    this.filter.conditions.forEach((condition, index) => {
      const row = element("div", "run-filter-row");
      const update = (patch: Partial<FilterCondition>, rerender = false) => {
        const conditions = [...this.filter.conditions];
        conditions[index] = { ...conditions[index], ...patch };
        this.filter = { ...this.filter, conditions };
        this.emit();
        if (rerender) this.render();
      };
      const path = element("input", "run-filter-path");
      path.type = "text";
      path.placeholder = "config path or tag:key";
      path.setAttribute("aria-label", `Condition ${index + 1} path`);
      path.value = condition.path ? this.label(condition) : "";
      const commitPath = () => {
        const field = this.fieldByLabel(path.value);
        if (field) update({ scope: field.scope, path: field.path }, true);
        else if (path.value.trim().startsWith("$"))
          update({ scope: "params", path: path.value.trim() }, true);
        else if (!path.value.trim()) update({ path: "" }, true);
        else {
          path.setCustomValidity("Unknown path. Pick one from the suggestions.");
          path.reportValidity();
        }
      };
      path.onchange = commitPath;
      path.oninput = () => path.setCustomValidity("");
      // Suggest config paths and tags; the hint shows a few values seen.
      attachSuggestions(
        path,
        () =>
          this.fields.map((f) => ({
            value: f.label,
            detail: f.examples
              .slice(0, 3)
              .map(displayValue)
              .join(", "),
          })),
        () => {
          commitPath();
          // Picking a path moves on to the value, like completing a word.
          requestAnimationFrame(() =>
            this.list
              .querySelectorAll<HTMLInputElement>(".run-filter-value")
              [index]?.focus(),
          );
        },
      );
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
      value.hidden = condition.op === "exists";
      const examples = this.fieldFor(condition)?.examples ?? [];
      value.oninput = () => update({ value: value.value });
      const line = element("div", "run-filter-line");
      line.append(path, op, value);
      if (examples.length)
        attachSuggestions(
          value,
          () => examples.map((text) => ({ value: displayValue(text) })),
          () => update({ value: value.value }),
        );
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
      missingLine.append(missingLabel);
      if (condition.missing === "default") {
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
