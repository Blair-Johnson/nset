import type { Run } from "./api";
import { element } from "./utils";
import { uuid } from "./uuid";
import { plotIcon } from "./plot-icons";
import "./run-status.css";

export type RunStatusChange = (run: Run, status: Run["status"]) => Promise<Run>;
export const runStatuses = [
  "running",
  "finished",
  "failed",
  "canceled",
] as const;
const label = (status: string) =>
  status.charAt(0).toUpperCase() + status.slice(1);

/** One control owns its menu and listeners; callers own persistence and catalog updates. */
export function runStatus(
  initial: Run,
  onStatus?: RunStatusChange,
  sourceLabel = false,
) {
  let run = initial;
  let saving = false;
  let destroyed = false;
  let opened = false;
  const root = element("span", "run-status-control");
  const pill = element("button", "run-status-pill");
  pill.type = "button";
  const text = element("span", "run-status-label status");
  const chevron = element("span", "run-status-chevron");
  chevron.setAttribute("aria-hidden", "true");
  chevron.append(plotIcon("chevron-down"));
  pill.append(text, chevron);
  const menu = element("div", "run-status-menu");
  menu.id = `run-status-${uuid()}`;
  menu.setAttribute("popover", "manual");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Change run status");
  const error = element("span", "run-status-error");
  error.id = `${menu.id}-error`;
  error.setAttribute("role", "alert");
  error.hidden = true;
  const items = runStatuses.map((status) => {
    const item = element(
      "button",
      `run-status-option status-${status}`,
      label(status),
    );
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-label", label(status));
    item.tabIndex = -1;
    item.onclick = () => void save(status);
    menu.append(item);
    return item;
  });
  root.append(pill, menu, error);
  // The status control is never a row-selection or navigation gesture.
  for (const type of ["click", "dblclick", "pointerdown", "mousedown"])
    root.addEventListener(type, (event) => event.stopPropagation());

  const outside = (event: PointerEvent) => {
    if (!root.contains(event.target as Node)) closeMenu();
  };
  const reposition = () => {
    if (!root.isConnected || !pill.getClientRects().length) {
      closeMenu();
      return;
    }
    const rect = pill.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, rect.bottom + height + 4 <= window.innerHeight ? rect.bottom + 4 : rect.top - height - 4)}px`;
  };
  function closeMenu(focus = false) {
    if (!opened) return;
    opened = false;
    if (menu.matches(":popover-open")) menu.hidePopover();
    pill.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);
    if (focus && pill.isConnected) pill.focus({ preventScroll: true });
  }
  function openMenu(last = false) {
    if (destroyed || saving || run.rx || !onStatus || !root.isConnected) return;
    if (opened) return;
    opened = true;
    menu.showPopover();
    pill.setAttribute("aria-expanded", "true");
    reposition();
    const selected = runStatuses.indexOf(run.status);
    items[last ? items.length - 1 : Math.max(0, selected)].focus({
      preventScroll: true,
    });
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
  }
  function paint() {
    const readonly = !!run.rx || !onStatus;
    root.dataset.runId = run.id;
    root.dataset.status = run.status;
    root.dataset.readonly = String(readonly);
    pill.className = `run-status-pill status-${run.status}`;
    text.textContent =
      sourceLabel && run.rx?.state ? run.rx.state : label(run.status);
    pill.disabled = readonly;
    pill.setAttribute(
      "aria-label",
      `${label(text.textContent)} status for ${run.name || run.id}${readonly ? " (read-only)" : ""}`,
    );
    pill.setAttribute("aria-busy", String(saving));
    pill.setAttribute("aria-disabled", String(readonly || saving));
    chevron.hidden = readonly;
    if (readonly) {
      closeMenu();
      pill.removeAttribute("aria-haspopup");
      pill.removeAttribute("aria-controls");
      pill.removeAttribute("aria-expanded");
    } else {
      pill.setAttribute("aria-haspopup", "menu");
      pill.setAttribute("aria-controls", menu.id);
      pill.setAttribute("aria-expanded", String(opened));
    }
    items.forEach((item, index) =>
      item.setAttribute(
        "aria-checked",
        String(runStatuses[index] === run.status),
      ),
    );
  }
  async function save(status: Run["status"]) {
    closeMenu(true);
    if (saving || destroyed || run.rx || !onStatus || status === run.status)
      return;
    error.hidden = true;
    error.textContent = "";
    pill.removeAttribute("aria-describedby");
    saving = true;
    paint();
    try {
      const saved = await onStatus(run, status);
      if (!destroyed) run = saved;
    } catch (cause) {
      if (!destroyed) {
        error.textContent = `Could not save status: ${cause instanceof Error ? cause.message : String(cause)}`;
        error.hidden = false;
        pill.setAttribute("aria-describedby", error.id);
      }
    } finally {
      saving = false;
      if (!destroyed) paint();
    }
  }
  pill.onclick = () => (opened ? closeMenu() : openMenu());
  root.onkeydown = (event) => {
    if (event.key !== "Tab" && (event.key !== "Escape" || opened))
      event.stopPropagation();
    if (event.key === "Escape" && opened) {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "Tab" && opened) {
      // Restore the anchor before native Tab traversal, including Shift+Tab.
      closeMenu(true);
    } else if (
      event.target === pill &&
      ["ArrowDown", "ArrowUp"].includes(event.key)
    ) {
      event.preventDefault();
      openMenu(event.key === "ArrowUp");
    } else if (
      opened &&
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length;
      items[next].focus();
    }
  };
  root.addEventListener("focusout", (event) => {
    if (
      opened &&
      event.relatedTarget &&
      !root.contains(event.relatedTarget as Node)
    )
      closeMenu();
  });
  paint();
  return Object.assign(root, {
    updateRun(next: Run) {
      if (destroyed || next.id !== run.id) return;
      run = next;
      paint();
    },
    closeMenu,
    destroy() {
      closeMenu();
      destroyed = true;
    },
  });
}
