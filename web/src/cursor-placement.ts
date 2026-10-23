import type { PlotInteraction } from "./workspace-types";

// Keep the state helpers usable by Node unit tests, just like navigation.ts.
if (typeof document !== "undefined") void import("./cursor-placement.css");

type PlacementState = Pick<PlotInteraction, "mode" | "cursorAxis">;
export type CursorPlacement = "vertical" | "horizontal" | "off";

/** A remembered axis is not armed after A→B completion or explicit OFF. */
export function cursorPlacement(state: PlacementState): CursorPlacement {
  return state.mode !== "inspect"
    ? "off"
    : state.cursorAxis === "y"
      ? "horizontal"
      : "vertical";
}

/** Pure patch: callers retain all pins/readouts and synchronize their own UI. */
export function nextCursorPlacement(state: PlacementState): {
  mode: "inspect" | "zoom";
  cursorAxis: "x" | "y";
  activePin: "a";
} {
  switch (cursorPlacement(state)) {
    case "vertical":
      return { mode: "inspect", cursorAxis: "y", activePin: "a" };
    case "horizontal":
      return { mode: "zoom", cursorAxis: "y", activePin: "a" };
    case "off":
      return { mode: "inspect", cursorAxis: "x", activePin: "a" };
  }
}
