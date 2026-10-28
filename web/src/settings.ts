import {
  CONFIG_HELP,
  defaults,
  parseAdvanced,
  parseSafeJson,
  styleFor,
  validateConfig,
  type ViewConfig,
  type RunStyle,
} from "./config";
import { smoothingUnit } from "./smoothing-coordinate";
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
    add(transforms, "smoothing", "Enable Gaussian smoothing");
    add(
      transforms,
      "smoothingSigma",
      `Smoothing sigma (${smoothingUnit(config, false)})`,
    );
    transforms.append(
      element(
        "p",
        "field-wide hint",
        "Duplicate x uses the largest sequence number. Gaussian smoothing uses the full independent coordinate, not observation order: sigma defaults to 1 step/second, decade/doubling, or asinh unit. Linear time uses seconds; ordinary asinh keeps the raw display-unit threshold. No extrapolation. Raw markers remain unsmoothed; all numeric queries use the transformed full series.",
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
    axes.append(
      element(
        "p",
        "hint field-wide",
        "Advanced scales.x/y can set direction, log base, asinh threshold and range policies. An advanced range replaces built-in minimum/maximum as a whole, even when one advanced bound is null. auto:false needs two fixed bounds.",
      ),
    );
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
      field(
        box,
        `${prefix}Color (CSS literal)`,
        s.color,
        undefined,
        "text",
        (v, d) => set("color", v, d),
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
        (v, d) => set("dash", parseSafeJson(String(v)), d),
      );
      field(
        box,
        `${prefix}Line cap`,
        s.cap ?? "butt",
        ["butt", "round", "square"],
        undefined,
        (v, d) => set("cap", v, d),
      );
      field(
        box,
        `${prefix}Series opacity`,
        s.alpha ?? 1,
        undefined,
        "number",
        (v, d) => set("alpha", v, d),
      );
      field(
        box,
        `${prefix}Pixel alignment (blank = inherit; boolean or number JSON)`,
        s.pxAlign === undefined ? "" : JSON.stringify(s.pxAlign),
        undefined,
        "text",
        (v, d) =>
          set(
            "pxAlign",
            String(v).trim() ? parseSafeJson(String(v)) : undefined,
            d,
          ),
      );
      field(
        box,
        `${prefix}Fill color (blank = series color)`,
        s.fillColor ?? "",
        undefined,
        "text",
        (v, d) => set("fillColor", String(v).trim() || undefined, d),
      );
      field(
        box,
        `${prefix}Fill baseline (blank = automatic)`,
        s.fillTo ?? null,
        undefined,
        "number",
        (v, d) => set("fillTo", v === null ? undefined : v, d),
      );
      field(
        box,
        `${prefix}Contribute to automatic range`,
        s.auto ?? true,
        undefined,
        undefined,
        (v, d) => set("auto", v, d),
      );
      field(
        box,
        `${prefix}Marker overrides (JSON)`,
        JSON.stringify(s.markers ?? {}),
        undefined,
        "text",
        (v, d) => set("markers", parseSafeJson(String(v)), d),
      );
      field(
        box,
        `${prefix}Cosmetic path options (JSON)`,
        JSON.stringify(s.pathOptions ?? {}),
        undefined,
        "text",
        (v, d) => set("pathOptions", parseSafeJson(String(v)), d),
      );
    };
    const style = section("04 / Default series style");
    add(style, "palette", "Use comparison palette");
    styleFields(style, config.style, (k, v, d) => {
      if (v === undefined) delete d.style[k];
      else (d.style as unknown as Record<string, unknown>)[k] = v;
    });
    style.append(
      element(
        "p",
        "hint field-wide",
        "The comparison palette overrides the default color when enabled. Per-run overrides take precedence. “Matched” draws the numerical curve using adaptive screen-space tessellation (0.35 CSS-pixel target tolerance, bounded work). Other paths and path options are cosmetic; readouts never follow cosmetic paths. Marker overrides take precedence over legacy point controls. Marker show:auto uses density-based visibility; {} keeps legacy behavior. Fill color and baseline are optional. Automatic range participation never changes analysis.",
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
        if ((enabled as HTMLInputElement).checked) {
          if (v === undefined) delete d.runs[run.id][k];
          else (d.runs[run.id] as Record<string, unknown>)[k] = v;
        }
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
          padding: [24, null, 8, null],
          pxAlign: true,
          drawOrder: ["axes", "series"],
          scales: {
            x: { dir: 1 },
            y: { range: { min: { pad: 0.1 }, max: { pad: 0.15 } } },
          },
          axes: [
            {
              side: 2,
              space: 60,
              grid: { dash: [3, 4], cap: "round" },
              values: "scientific",
            },
            { side: 3, label: "Objective", lineGap: 1.5, ticks: { size: 6 } },
          ],
          cursor: {
            lock: false,
            points: { show: true, size: 8 },
            focus: { prox: 24 },
            drag: { x: true, y: true, dist: 12, setScale: true, uni: 20 },
          },
          legend: { live: false, isolate: true, markers: { dash: "solid" } },
          focus: { alpha: 0.3 },
          select: { show: true, over: true },
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
