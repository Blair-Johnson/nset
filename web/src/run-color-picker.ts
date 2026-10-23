import { palette } from "./config";
import { runColor, setRunColor } from "./series-colors";
import type { Catalog } from "./workspace-types";
import "./run-color-picker.css";
let active: HTMLDialogElement | undefined;
/** A compact accessible swatch; the palette exists only while it is being edited. */
export function runColorButton(catalog: Catalog, runId: string): HTMLElement {
  const name = catalog.runs.find((run) => run.id === runId)?.name ?? runId;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "run-color-button";
  trigger.dataset.runColorId = runId;
  trigger.setAttribute("aria-label", `Change color for ${name}`);
  trigger.title = `Change color for ${name}`;
  trigger.style.setProperty("--run-color", runColor(catalog, runId));
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    active?.close();
    const dialog = document.createElement("dialog");
    active = dialog;
    dialog.className = "run-color-dialog";
    dialog.setAttribute("aria-label", `Color for ${name}`);
    const heading = document.createElement("strong");
    heading.textContent = "Run color";
    const presets = document.createElement("div");
    presets.className = "run-color-presets";
    const error = document.createElement("p");
    error.className = "run-color-error";
    error.setAttribute("role", "alert");
    const apply = (color: string | null) => {
      if (!setRunColor(runId, color)) {
        error.textContent =
          "Could not save this color. Browser storage may be unavailable.";
        return;
      }
      trigger.style.setProperty("--run-color", runColor(catalog, runId));
      dialog.close();
    };
    for (const color of palette) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "run-color-button";
      choice.style.setProperty("--run-color", color);
      choice.setAttribute("aria-label", `Use ${color}`);
      choice.setAttribute(
        "aria-pressed",
        String(color === runColor(catalog, runId)),
      );
      choice.onclick = () => apply(color);
      presets.append(choice);
    }
    const customLabel = document.createElement("label");
    customLabel.textContent = "Custom color";
    const custom = document.createElement("input");
    custom.type = "color";
    custom.value = runColor(catalog, runId);
    customLabel.append(custom);
    const actions = document.createElement("div");
    actions.className = "run-color-actions";
    for (const [label, action] of [
      ["Reset", () => apply(null)],
      ["Cancel", () => dialog.close()],
      ["Apply", () => apply(custom.value)],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.onclick = action;
      actions.append(button);
    }
    dialog.append(heading, presets, customLabel, error, actions);
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        if (active === dialog) active = undefined;
        requestAnimationFrame(() => {
          const replacement = Array.from(
            document.querySelectorAll<HTMLButtonElement>("[data-run-color-id]"),
          ).find(
            (button) =>
              button.dataset.runColorId === runId &&
              button.getClientRects().length > 0,
          );
          (trigger.isConnected ? trigger : replacement)?.focus({
            preventScroll: true,
          });
        });
      },
      { once: true },
    );
    document.body.append(dialog);
    dialog.showModal();
  });
  return trigger;
}
