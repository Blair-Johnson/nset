import { element } from "./utils";
import "./workspace-controls.css";

export type DashboardAxis = "step" | "timestamp" | "relative";
export interface DashboardControlsOptions {
  axis: DashboardAxis | null;
  smoothing: number | null;
  /** Keep the slider range stable when the toolbar is rebuilt. */
  smoothingMax?: number;
  onAxis: (axis: DashboardAxis) => boolean | void;
  onSmoothing: (sigma: number) => boolean | void;
  /** null means incomparable units: numeric edits are disabled, Off is allowed. */
  smoothingUnit?: string | null;
  smoothingSignature?: string | null;
}

/** Display-only until a native change event commits a deliberate user edit. */
export function createDashboardControls(
  options: DashboardControlsOptions,
): HTMLElement {
  const root = element("div", "dashboard-controls");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Dashboard controls");
  let savedAxis = options.axis;
  let savedSmoothing = options.smoothing;
  const mixedUnits =
    options.smoothingUnit === null || options.smoothingSignature === null;

  const axisLabel = element("label", "dashboard-control-axis");
  axisLabel.append(element("span", "", "X axis"));
  const axis = element("select");
  axis.setAttribute("aria-label", "Dashboard X axis");
  axis.title = "Relative time is elapsed time from each run's start.";
  if (savedAxis === null) {
    const mixed = element("option", "", "Mixed");
    mixed.value = "";
    mixed.disabled = true;
    axis.append(mixed);
  }
  for (const [value, text] of [
    ["step", "Step"],
    ["timestamp", "Wall time"],
    ["relative", "Relative time"],
  ] as const) {
    const option = element("option", "", text);
    option.value = value;
    if (value === "relative")
      option.title = "Elapsed time from each run's start";
    axis.append(option);
  }
  axis.value = savedAxis ?? "";
  axisLabel.append(axis);

  const smoothingLabel = element("div", "dashboard-control-smoothing");
  smoothingLabel.append(element("span", "", "Smoothing"));
  const slider = element("input");
  slider.type = "range";
  slider.min = "0";
  function setRange(max: number) {
    slider.max = String(max);
    slider.step = String(max / 1000);
  }
  setRange(
    mixedUnits
      ? 1
      : Math.max(
          savedSmoothing ?? 0,
          options.smoothingMax ??
            (savedSmoothing && savedSmoothing > 0 ? savedSmoothing : 100),
        ),
  );
  slider.setAttribute("aria-label", "Dashboard smoothing");
  const output = element("button", "dashboard-smoothing-value");
  output.type = "button";
  output.setAttribute("aria-label", "Edit smoothing bandwidth");
  output.disabled = mixedUnits;
  const sigma = element("input", "dashboard-smoothing-editor");
  sigma.type = "text";
  sigma.inputMode = "decimal";
  sigma.setAttribute("aria-label", "Dashboard smoothing sigma");
  sigma.hidden = true;
  const unit = options.smoothingUnit ?? "steps";
  if (mixedUnits)
    slider.title =
      "Mixed units: slide to zero to turn smoothing off. Edit bandwidths per chart.";
  function showSmoothing(value: number | null) {
    const text =
      value === 0
        ? "Off"
        : mixedUnits
          ? "Mixed units"
          : value === null
            ? "Mixed"
            : `${Number(value.toPrecision(4))} ${unit}`;
    output.textContent = text;
    slider.setAttribute("aria-valuetext", text);
    slider.dataset.mixed = String(value === null);
  }
  function restoreSmoothing() {
    slider.value = mixedUnits
      ? String(savedSmoothing === 0 ? 0 : 1)
      : String(savedSmoothing ?? Number(slider.max) / 2);
    sigma.value = savedSmoothing === null ? "" : String(savedSmoothing);
    sigma.placeholder = savedSmoothing === null ? "Mixed" : "";
    showSmoothing(savedSmoothing);
  }
  function closeEditor() {
    sigma.hidden = true;
    output.hidden = false;
  }
  output.onclick = () => {
    restoreSmoothing();
    output.hidden = true;
    sigma.hidden = false;
    sigma.focus();
    sigma.select();
  };
  restoreSmoothing();
  smoothingLabel.append(slider, output, sigma);

  const status = element("span", "dashboard-controls-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  function failed(control: string) {
    const message = `Could not save dashboard ${control}. Previous setting restored.`;
    const icon = element("span", "", "!");
    icon.setAttribute("aria-hidden", "true");
    status.replaceChildren(
      icon,
      element("span", "dashboard-controls-sr-only", message),
    );
    status.title = message;
  }
  function succeeded() {
    status.replaceChildren();
    status.removeAttribute("title");
  }
  axis.onchange = () => {
    const next = axis.value as DashboardAxis;
    if (next === savedAxis) return;
    try {
      if (options.onAxis(next) === false) throw new Error("not saved");
      savedAxis = next;
      succeeded();
    } catch {
      axis.value = savedAxis ?? "";
      failed("X axis");
    }
  };
  function commitSmoothing(next: number, setUpperBound = false) {
    if (!Number.isFinite(next) || next < 0 || (mixedUnits && next !== 0)) {
      restoreSmoothing();
      return;
    }
    const previousMax = Number(slider.max);
    // The callback can synchronously rebuild the toolbar and read this range.
    if (setUpperBound && next > 0) setRange(next);
    if (next === savedSmoothing) {
      restoreSmoothing();
      return;
    }
    try {
      if (options.onSmoothing(next) === false) throw new Error("not saved");
      savedSmoothing = next;
      restoreSmoothing();
      succeeded();
    } catch {
      setRange(previousMax);
      restoreSmoothing();
      failed("smoothing");
    }
  }
  const sliderValue = () => {
    const max = Number(slider.max);
    const index = Math.round((Number(slider.value) / max) * 1000);
    return index === 1000
      ? max
      : Number(((index * max) / 1000).toPrecision(15));
  };
  slider.oninput = () => {
    showSmoothing(
      mixedUnits && slider.value !== "0" ? savedSmoothing : sliderValue(),
    );
  };
  slider.onchange = () => commitSmoothing(sliderValue());
  sigma.onchange = () =>
    commitSmoothing(
      sigma.value.trim() === "" ? NaN : Number(sigma.value),
      true,
    );
  sigma.onblur = closeEditor;
  sigma.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      restoreSmoothing();
      closeEditor();
      output.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      sigma.blur();
      output.focus();
    }
  };
  root.append(axisLabel, smoothingLabel, status);
  return root;
}
