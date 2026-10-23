import { element } from "./utils";

export interface Suggestion {
  /** Text inserted into the input. */
  value: string;
  /** Optional muted hint shown after the value (e.g. example values). */
  detail?: string;
}

/** Rank: whole-value prefix, then a segment prefix (after . : / _ -), then substring. */
export function rankSuggestions(
  query: string,
  items: Suggestion[],
  limit = 8,
): Suggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const scored: [number, number, Suggestion][] = [];
  items.forEach((item, order) => {
    const text = item.value.toLowerCase();
    const at = text.indexOf(q);
    if (at < 0) return;
    const score =
      at === 0 ? 0 : /[.:/_\-\s[]/.test(text[at - 1]) ? 1 : 2;
    scored.push([score, order, item]);
  });
  return scored
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .slice(0, limit)
    .map((entry) => entry[2]);
}

/** Longest shared prefix (case-insensitive compare, original casing kept). */
export function commonPrefix(values: string[]): string {
  if (!values.length) return "";
  let end = values[0].length;
  for (const value of values.slice(1)) {
    let i = 0;
    while (
      i < end &&
      i < value.length &&
      value[i].toLowerCase() === values[0][i].toLowerCase()
    )
      i++;
    end = i;
  }
  return values[0].slice(0, end);
}

let nextId = 0;

/**
 * Typeahead for a text input: a listbox of ranked suggestions as you type.
 * ↑/↓ move, Enter picks, Tab completes (the highlighted item, the only match,
 * or the longest shared prefix), Escape closes the list only.
 * The list lives in the top layer so scrolling popovers cannot clip it.
 */
export function attachSuggestions(
  input: HTMLInputElement,
  source: () => Suggestion[],
  onPick: (value: string) => void,
): void {
  const id = `suggest-${++nextId}`;
  const list = element("div", "suggest-list");
  list.id = id;
  list.setAttribute("role", "listbox");
  list.setAttribute("popover", "manual");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", id);
  input.setAttribute("aria-expanded", "false");
  input.autocomplete = "off";
  let shown: Suggestion[] = [];
  let active = -1;

  const isOpen = () => input.getAttribute("aria-expanded") === "true";
  const close = () => {
    if (!isOpen()) return;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    if (list.matches(":popover-open")) list.hidePopover();
    active = -1;
  };
  const highlight = (index: number) => {
    active = index;
    [...list.children].forEach((option, i) =>
      option.setAttribute("aria-selected", String(i === index)),
    );
    if (index >= 0) {
      input.setAttribute("aria-activedescendant", `${id}-${index}`);
      list.children[index]?.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const pick = (value: string) => {
    input.value = value;
    close();
    onPick(value);
  };
  const open = () => {
    shown = rankSuggestions(input.value, source());
    // Nothing useful to offer when the only match is exactly what is typed.
    if (
      !shown.length ||
      (shown.length === 1 && shown[0].value === input.value.trim())
    ) {
      close();
      return;
    }
    list.replaceChildren(
      ...shown.map((item, i) => {
        const option = element("div", "suggest-option");
        option.id = `${id}-${i}`;
        option.setAttribute("role", "option");
        option.append(element("span", "suggest-value", item.value));
        if (item.detail)
          option.append(element("span", "suggest-detail", item.detail));
        // Keep focus in the input; pick on press.
        option.onpointerdown = (event) => {
          event.preventDefault();
          pick(item.value);
        };
        return option;
      }),
    );
    const rect = input.getBoundingClientRect();
    // Inserted on first use: callers may attach before the input is in the DOM.
    if (list.parentNode !== input.parentNode) input.after(list);
    list.style.left = `${rect.left}px`;
    list.style.top = `${rect.bottom + 2}px`;
    list.style.minWidth = `${rect.width}px`;
    if (!list.matches(":popover-open")) list.showPopover();
    input.setAttribute("aria-expanded", "true");
    highlight(-1);
  };

  input.addEventListener("focus", open);
  input.addEventListener("input", open);
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!isOpen()) open();
      if (!shown.length) return;
      event.preventDefault();
      // Cycle through the options and a "none highlighted" slot (-1).
      const slots = shown.length + 1;
      const step = event.key === "ArrowDown" ? 1 : -1;
      highlight(((active + 1 + step + slots) % slots) - 1);
    } else if (event.key === "Enter" && isOpen() && active >= 0) {
      event.preventDefault();
      pick(shown[active].value);
    } else if (event.key === "Tab" && !event.shiftKey && isOpen()) {
      const matches = shown.map((item) => item.value);
      const typed = input.value;
      if (active >= 0) {
        event.preventDefault();
        pick(matches[active]);
      } else if (matches.length === 1) {
        event.preventDefault();
        pick(matches[0]);
      } else {
        // Extend to the shared prefix when the matches all start with what was typed.
        const prefix = commonPrefix(matches);
        if (
          prefix.length > typed.length &&
          prefix.toLowerCase().startsWith(typed.toLowerCase())
        ) {
          event.preventDefault();
          input.value = prefix;
          open();
        }
      }
    } else if (event.key === "Escape" && isOpen()) {
      // First Escape closes suggestions; the next one closes the menu.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
}
