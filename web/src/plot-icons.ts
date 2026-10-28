export const NAVIGATE_LABEL = "Touch navigation: drag to inspect, two fingers to pan and pinch to zoom";
const paths = {
  navigate: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0M14.5 14.5 21 21",
  "zoom-in": "M5 12h14M12 5v14",
  "zoom-out": "M5 12h14",
  fit: "M3 10.5 12 3l9 7.5M5 9v12h14V9M9 21v-7h6v7",
  back: "m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12",
  maximize: "M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5",
  restore: "M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5",
  // Cursor icons: a solid hairline flanked by small end ticks, like a scope cursor.
  "vertical-cursor": "M12 4v16M9 4h6M9 20h6",
  "horizontal-cursor": "M4 12h16M4 9v6M20 9v6",
  // Image viewer controls.
  "fit-image": "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M9 9h6v6H9z",
  "actual-size": "M7 9l2-1.5V16M15 9l2-1.5V16M12 10.5v.01M12 14.5v.01",
  previous: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  "chevron-down": "M6 9l6 6 6-6",
  play: "M8 5.5v13l10.5-6.5z",
  pause: "M8 5v14M16 5v14",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  // Experiment view switcher (runs table | charts), mlflow-style.
  "view-runs": "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  "view-charts": "M4 4v16h16M7.5 15l4-5 3 3L19 7",
  filter: "M4 5h16l-6 7.5V19l-4-2v-4.5z",
  copy: "M9 9h10v10H9zM5 15V5h10",
  tag: "M3.5 12.5V4h8.5L20 12l-8 8zM8 8h.01",
} as const;

export type PlotIconName = keyof typeof paths;

export function plotIcon(name: PlotIconName): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  icon.setAttribute("class", "card-icon");
  icon.dataset.icon = name;
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", paths[name]);
  path.setAttribute("fill", name === "play" ? "currentColor" : "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute(
    "stroke-width",
    name === "more"
      ? "3"
      : name === "pause"
        ? "2.6"
        : name === "view-runs"
          ? "2"
          : "1.8",
  );
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  icon.append(path);
  return icon;
}
