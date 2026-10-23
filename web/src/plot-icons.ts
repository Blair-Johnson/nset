const paths = {
  "zoom-in": "M5 12h14M12 5v14",
  "zoom-out": "M5 12h14",
  fit: "M3 10.5 12 3l9 7.5M5 9v12h14V9M9 21v-7h6v7",
  back: "m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12",
  maximize: "M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5",
  restore: "M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5",
  "vertical-cursor": "M12 3v18",
  "horizontal-cursor": "M3 12h18",
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
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  if (name.endsWith("-cursor")) path.setAttribute("stroke-dasharray", "3 3");
  icon.append(path);
  return icon;
}
