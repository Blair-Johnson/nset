import { element } from "./utils";
import "./workspace-controls.css";

export type DashboardAxis = "step" | "timestamp" | "relative";
export interface DashboardControlsOptions {
  axis: DashboardAxis | null;
  smoothing: number | null;
  onAxis: (axis: DashboardAxis) => boolean | void;
  onSmoothing: (strength: number) => boolean | void;
}

/** Display-only until a native change event commits a deliberate user edit. */
export function createDashboardControls(
  options: DashboardControlsOptions,
): HTMLElement {
  const root = element("div", "dashboard-controls");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Dashboard controls");
  let savedAxis = options.axis;
  let savedSmoothing =
    options.smoothing === null
      ? null
      : Math.max(0, Math.min(100, Math.round(options.smoothing)));

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

  const smoothingLabel = element("label", "dashboard-control-smoothing");
  smoothingLabel.append(element("span", "", "Smoothing"));
  const slider = element("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.step = "1";
  slider.setAttribute("aria-label", "Dashboard smoothing");
  slider.title = "Smoothing strength: None to More";
  const output = element("span", "dashboard-smoothing-value");
  // The range's aria-valuetext supplies its value to assistive technology.
  output.setAttribute("aria-hidden", "true");
  function showSmoothing(value: number | null) {
    const text =
      value === null
        ? "Mixed"
        : value === 0
          ? "None"
          : value === 100
            ? "More"
            : `${value}%`;
    output.textContent = text;
    slider.setAttribute("aria-valuetext", text);
    slider.dataset.mixed = String(value === null);
  }
  function restoreSmoothing() {
    // A mixed thumb is a neutral starting point, not an applied setting.
    slider.value = String(savedSmoothing ?? 50);
    showSmoothing(savedSmoothing);
  }
  restoreSmoothing();
  smoothingLabel.append(slider, output);

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
  slider.oninput = () => showSmoothing(slider.valueAsNumber);
  slider.onchange = () => {
    const next = slider.valueAsNumber;
    if (next === savedSmoothing) {
      showSmoothing(savedSmoothing);
      return;
    }
    try {
      if (options.onSmoothing(next) === false) throw new Error("not saved");
      savedSmoothing = next;
      showSmoothing(savedSmoothing);
      succeeded();
    } catch {
      restoreSmoothing();
      failed("smoothing");
    }
  };
  root.append(axisLabel, smoothingLabel, status);
  return root;
}
