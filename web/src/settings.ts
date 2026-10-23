import {
  CONFIG_HELP,
  defaults,
  parseAdvanced,
  styleFor,
  validateConfig,
  type ViewConfig,
  type RunStyle,
} from "./config";
import { element, message } from "./utils";
import type { Run } from "./api";
export class SettingsPanel {
  constructor(
    private host: HTMLElement,
    private apply: (config: ViewConfig) => void,
  ) {}
  render(config: ViewConfig, runs: Run[]) {
    this.host.replaceChildren();
    const form = element("form", "settings-form");
    const error = element("div", "error");
    error.setAttribute("role", "alert");
    const top = element("div", "section-head");
    top.append(
      element("h2", "", "Plot configuration"),
      element(
        "span",
        "muted",
        "Applied atomically · saved locally · no executable JSON",
      ),
    );
    form.append(top);
    const readers: Array<(draft: ViewConfig) => void> = [];
    const section = (title: string) => {
      const box = element("fieldset", "settings-grid");
      const legend = element("legend", "", title);
      box.append(legend);
      form.append(box);
      return box;
    };
    const field = (
      box: HTMLElement,
      label: string,
      value: string | number | boolean | null,
      options?: string[],
      kind?: "number" | "color" | "text",
      callback?: (value: unknown, draft: ViewConfig) => void,
    ) => {
      const wrapper = element("label", "field");
      wrapper.append(element("span", "", label));
      let control: HTMLInputElement | HTMLSelectElement;
      if (options) {
        control = element("select");
        for (const option of options) {
          const o = element("option", "", option);
          o.value = option;
          control.append(o);
        }
        control.value = String(value);
      } else {
        control = element("input");
        control.type =
          typeof value === "boolean" ? "checkbox" : (kind ?? "number");
        if (control.type === "checkbox") control.checked = Boolean(value);
        else control.value = value === null ? "" : String(value);
        if (control.type === "number") control.step = "any";
        if (value === null) control.placeholder = "Auto";
      }
      control.setAttribute("aria-label", label);
      wrapper.append(control);
      box.append(wrapper);
      readers.push((draft) => {
        let v: unknown = control.value;
        if (control instanceof HTMLInputElement) {
          if (control.type === "checkbox") v = control.checked;
          else if (control.type === "number")
            v = control.value.trim() === "" ? null : Number(control.value);
        }
        callback?.(v, draft);
      });
      return control;
    };
    const add = (
      box: HTMLElement,
      key: keyof ViewConfig,
      label: string,
      options?: string[],
      kind?: "number" | "color" | "text",
    ) =>
      field(
        box,
        label,
        config[key] as string | number | boolean | null,
        options,
        kind,
        (value, draft) => {
          (draft as unknown as Record<string, unknown>)[key] = value;
        },
      );
    const transforms = section(
      "01 / Analysis — full series, independent of viewport",
    );
    add(transforms, "axis", "X source", ["step", "timestamp"]);
    add(transforms, "interpolation", "Numerical interpolation", [
      "linear",
      "pchip",
    ]);
    add(transforms, "smoothing", "Enable EMA");
    add(transforms, "alpha", "EMA alpha (per observation)");
    transforms.append(
      element(
        "p",
        "field-wide hint",
        "Duplicate x uses the largest sequence number. EMA is applied after canonicalization. No extrapolation. Raw markers remain unsmoothed; all numeric queries use the transformed full series.",
      ),
    );
    const axes = section("02 / Axes & viewport");
    add(axes, "xScale", "X scale", ["linear", "log", "asinh"]);
    add(axes, "yScale", "Y scale", ["linear", "log", "asinh"]);
    add(axes, "xMin", "X minimum");
    add(axes, "xMax", "X maximum");
    add(axes, "yMin", "Y minimum");
    add(axes, "yMax", "Y maximum");
    add(axes, "xLabel", "X label", undefined, "text");
    add(axes, "yLabel", "Y label", undefined, "text");
    add(axes, "xFormat", "X formatter", [
      "number",
      "fixed-2",
      "scientific",
      "iso-time",
    ]);
    add(axes, "yFormat", "Y formatter", [
      "number",
      "fixed-2",
      "scientific",
      "iso-time",
    ]);
    add(axes, "height", "Plot height (px)");
    add(axes, "width", "Plot width (blank = responsive)");
    const presentation = section("03 / Grid, legend & interaction");
    for (const [key, label] of [
      ["grid", "Grid lines"],
      ["ticks", "Axis ticks"],
      ["legend", "Legend"],
      ["cursor", "Hover crosshair"],
      ["zoom", "Drag-to-zoom X"],
    ] as const)
      add(presentation, key, label);
    const styleFields = (
      box: HTMLElement,
      s: RunStyle,
      set: (key: keyof RunStyle, value: unknown, draft: ViewConfig) => void,
      prefix = "",
    ) => {
      field(box, `${prefix}Color`, s.color, undefined, "color", (v, d) =>
        set("color", v, d),
      );
      field(box, `${prefix}Line width`, s.width, undefined, "number", (v, d) =>
        set("width", v, d),
      );
      field(
        box,
        `${prefix}Raw point markers`,
        s.points,
        undefined,
        undefined,
        (v, d) => set("points", v, d),
      );
      field(
        box,
        `${prefix}Point size`,
        s.pointSize,
        undefined,
        "number",
        (v, d) => set("pointSize", v, d),
      );
      field(box, `${prefix}Area opacity`, s.fill, undefined, "number", (v, d) =>
        set("fill", v, d),
      );
      field(box, `${prefix}Visible`, s.visible, undefined, undefined, (v, d) =>
        set("visible", v, d),
      );
      field(
        box,
        `${prefix}Display path`,
        s.path,
        ["matched", "linear", "stepped-before", "stepped-after", "spline"],
        undefined,
        (v, d) => set("path", v, d),
      );
      field(
        box,
        `${prefix}Dash array (JSON)`,
        JSON.stringify(s.dash),
        undefined,
        "text",
        (v, d) => set("dash", JSON.parse(String(v)), d),
      );
    };
    const style = section("04 / Default series style");
    add(style, "palette", "Use comparison palette");
    styleFields(style, config.style, (k, v, d) => {
      (d.style as unknown as Record<string, unknown>)[k] = v;
    });
    style.append(
      element(
        "p",
        "hint field-wide",
        "The comparison palette overrides the default color when enabled. Per-run overrides take precedence. “Matched” is the honest numerical curve. Stepped and spline alternatives change appearance only; readouts do not follow cosmetic paths.",
      ),
    );
    const perRun = section("05 / Per-run overrides");
    if (!runs.length)
      perRun.append(
        element(
          "p",
          "muted",
          "Select runs in the browser to edit their styles.",
        ),
      );
    runs.forEach((run, index) => {
      const details = element("details", "run-style field-wide");
      const summary = element("summary", "", run.name);
      details.append(summary);
      const box = element("div", "settings-grid");
      details.append(box);
      perRun.append(details);
      const s = styleFor(config, run.id, index);
      const enabled = field(
        box,
        "Override defaults",
        Boolean(config.runs[run.id]),
        undefined,
        undefined,
        (value, d) => {
          if (value) d.runs[run.id] = { ...s };
          else delete d.runs[run.id];
        },
      );
      styleFields(box, s, (k, v, d) => {
        if ((enabled as HTMLInputElement).checked)
          (d.runs[run.id] as Record<string, unknown>)[k] = v;
      });
    });
    const advanced = section("06 / Advanced safe uPlot JSON");
    const help = element("p", "hint field-wide", CONFIG_HELP);
    advanced.append(help);
    const editor = element("textarea", "json-editor field-wide");
    editor.rows = 17;
    editor.spellcheck = false;
    editor.value = JSON.stringify(config.advanced, null, 2);
    editor.setAttribute("aria-label", "Advanced uPlot JSON");
    advanced.append(editor);
    const sample = element("button", "", "Insert example");
    sample.type = "button";
    sample.onclick = () => {
      editor.value = JSON.stringify(
        {
          padding: [24, 28, 8, 8],
          axes: [
            { grid: { dash: [3, 4] }, values: "scientific" },
            { label: "Objective", ticks: { size: 6 } },
          ],
          cursor: { drag: { x: true, y: true, dist: 12 } },
          legend: { live: false },
        },
        null,
        2,
      );
    };
    advanced.append(sample);
    const actions = element("div", "settings-actions");
    const submit = element("button", "primary", "Apply configuration");
    submit.type = "submit";
    const reset = element("button", "", "Reset defaults");
    reset.type = "button";
    reset.onclick = () => this.apply(defaults());
    actions.append(submit, reset, error);
    form.append(actions);
    this.host.append(form);
    form.onsubmit = (e) => {
      e.preventDefault();
      try {
        const draft = structuredClone(config);
        for (const read of readers) read(draft);
        draft.advanced = parseAdvanced(editor.value);
        this.apply(validateConfig(draft));
      } catch (err) {
        error.textContent = message(err);
        error.scrollIntoView({ block: "nearest" });
      }
    };
  }
}
