import { element } from "./utils";

export type ConfigPath = (string | number)[];
export interface ConfigValue {
  path: ConfigPath;
  sourcePath: string;
  value: unknown;
  type: string;
  preview: string;
}
export interface ConfigNode {
  id: number;
  path: string;
  parent: ConfigNode | null;
  children: Map<string, ConfigNode>;
  values: ConfigValue[];
  search: string;
}
export interface ConfigTree {
  root: ConfigNode;
  nodes: ConfigNode[];
  fields: number;
}

/** Exact source addressing: literal dots in keys never become nested lookups. */
export function configPath(path: ConfigPath): string {
  return "$" + path.map((part) => `[${JSON.stringify(part)}]`).join("");
}
export function configType(value: unknown): string {
  return value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value;
}
export function configJSON(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}
function preview(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).length} keys}`;
  return configJSON(value);
}

/** Params are JSON data already parsed by the API, not YAML source text. */
export function buildConfigTree(params: Record<string, unknown>): ConfigTree {
  let nextId = 0;
  const make = (path: string, parent: ConfigNode | null): ConfigNode => ({
    id: nextId++,
    path,
    parent,
    children: new Map(),
    values: [],
    search: "",
  });
  const root = make("", null);
  const nodes: ConfigNode[] = [];
  const pending = Object.entries(params)
    .reverse()
    .map(([key, value]) => ({
      parent: root,
      key: key as string | number,
      value,
      path: [key] as ConfigPath,
    }));
  let fields = 0;
  while (pending.length) {
    const item = pending.pop()!;
    let node = item.parent;
    const parts =
      typeof item.key === "number" ? [`[${item.key}]`] : item.key.split(".");
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        const separator = typeof item.key === "number" ? "" : ".";
        child = make(
          node === root ? part : `${node.path}${separator}${part}`,
          node,
        );
        node.children.set(part, child);
        nodes.push(child);
      }
      node = child;
    }
    const value: ConfigValue = {
      path: item.path,
      sourcePath: configPath(item.path),
      value: item.value,
      type: configType(item.value),
      preview: preview(item.value),
    };
    node.values.push(value);
    fields++;
    if (item.value !== null && typeof item.value === "object") {
      const entries = Array.isArray(item.value)
        ? item.value.map((value, key) => [key, value] as const)
        : Object.entries(item.value);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, value] = entries[i];
        pending.push({ parent: node, key, value, path: [...item.path, key] });
      }
    }
  }
  for (const node of nodes) {
    node.search = [
      node.path,
      ...node.values.flatMap((v) => [v.sourcePath, v.preview]),
    ]
      .join("\n")
      .toLocaleLowerCase();
  }
  return { root, nodes, fields };
}

/** Return matches plus their ancestors; never rewrite source objects. */
export function matchingConfigNodes(
  tree: ConfigTree,
  query: string,
): Set<number> | null {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return null;
  const matches = new Set<number>();
  for (const candidate of tree.nodes) {
    if (!candidate.search.includes(needle)) continue;
    let node: ConfigNode | null = candidate;
    while (node && !matches.has(node.id)) {
      matches.add(node.id);
      node = node.parent;
    }
  }
  return matches;
}

function action(
  label: string,
  run: () => void,
  title = label,
): HTMLButtonElement {
  const button = element("button", "", label);
  button.type = "button";
  button.title = title;
  button.onclick = run;
  return button;
}

export function renderRunConfig(
  params: Record<string, unknown>,
  runId: string,
): HTMLElement {
  const tree = buildConfigTree(params);
  const section = element("section", "run-config");
  section.setAttribute("aria-label", "Run configuration");
  const heading = element("div", "run-config-heading");
  heading.append(element("h2", "", "Configuration"));
  const status = element("span", "run-config-status");
  status.setAttribute("role", "status");
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "Copied";
    } catch {
      status.textContent = "Copy unavailable. Select text or export JSON.";
    }
  };
  const exportJSON = () => {
    const url = URL.createObjectURL(
      new Blob([configJSON(params) + "\n"], { type: "application/json" }),
    );
    const link = element("a");
    link.href = url;
    link.download = `run-${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}-config.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  heading.append(
    action("Copy JSON", () => {
      void copy(configJSON(params));
    }),
    action("Export JSON", exportJSON),
  );
  const tools = element("div", "run-config-tools");
  const search = element("input");
  search.type = "search";
  search.placeholder = "Search paths and values";
  search.setAttribute("aria-label", "Search configuration paths and values");
  const expanded = new Set(
    tree.nodes.filter((n) => n.children.size).map((n) => n.id),
  );
  const collapsedMatches = new Set<number>();
  let matches: Set<number> | null = null;
  const pageSize = 200;
  let limit = pageSize;
  const rows = element("div", "run-config-rows");
  const count = element("span", "run-config-count");
  const more = action("Show 200 more", () => {
    limit += pageSize;
    render();
  });
  more.className = "run-config-more";
  function render(focusId?: number) {
    const fragment = document.createDocumentFragment();
    const stack = [...tree.root.children.values()]
      .reverse()
      .map((node) => ({ node, depth: 0 }));
    let total = 0;
    let shown = 0;
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      if (matches && !matches.has(node.id)) continue;
      const open = matches
        ? !collapsedMatches.has(node.id)
        : expanded.has(node.id);
      if (open) {
        for (const child of [...node.children.values()].reverse())
          stack.push({ node: child, depth: depth + 1 });
      }
      for (const [index, value] of (node.values.length
        ? node.values
        : [null]
      ).entries()) {
        total++;
        if (shown >= limit) continue;
        shown++;
        const row = element("div", "run-config-row");
        row.dataset.sourcePath = value?.sourcePath ?? "";
        row.style.setProperty("--config-depth", String(Math.min(depth, 5)));
        const name = element("div", "run-config-key");
        if (index === 0 && node.children.size) {
          const toggle = action(open ? "▾" : "▸", () => {
            if (matches) {
              if (open) collapsedMatches.add(node.id);
              else collapsedMatches.delete(node.id);
            } else {
              if (open) expanded.delete(node.id);
              else expanded.add(node.id);
            }
            render(node.id);
          });
          toggle.className = "run-config-toggle";
          toggle.dataset.nodeId = String(node.id);
          toggle.setAttribute(
            "aria-label",
            `Toggle ${node.path || "(empty key)"}`,
          );
          toggle.setAttribute("aria-expanded", String(open));
          name.append(toggle);
        } else name.append(element("span", "run-config-toggle-space"));
        const path = element("code", "run-config-path", node.path || '""');
        path.title = value?.sourcePath ?? node.path;
        name.append(path);
        if (node.values.length > 1 && value)
          name.append(element("code", "run-config-source", value.sourcePath));
        const type = element(
          "span",
          "run-config-type",
          value?.type ?? "namespace",
        );
        const content = element(
          "pre",
          "run-config-value",
          value?.preview ?? `${node.children.size} groups / fields`,
        );
        content.dataset.type = value?.type ?? "namespace";
        const actions = element("div", "run-config-actions");
        if (value) {
          const pathCopy = action(
            "Path",
            () => {
              void copy(value.sourcePath);
            },
            `Copy path ${value.sourcePath}`,
          );
          pathCopy.setAttribute("aria-label", `Copy path ${value.sourcePath}`);
          const valueCopy = action(
            "Value",
            () => {
              void copy(configJSON(value.value));
            },
            `Copy JSON value ${value.sourcePath}`,
          );
          valueCopy.setAttribute(
            "aria-label",
            `Copy value ${value.sourcePath}`,
          );
          actions.append(pathCopy, valueCopy);
        }
        row.append(name, type, content, actions);
        fragment.append(row);
      }
    }
    if (!total)
      fragment.append(
        element(
          "p",
          "muted",
          matches
            ? "No matching configuration paths or values."
            : "No configuration parameters recorded.",
        ),
      );
    rows.replaceChildren(fragment);
    count.textContent = `${shown} of ${total} visible rows · ${tree.fields} values`;
    more.hidden = shown >= total;
    if (focusId !== undefined)
      rows
        .querySelector<HTMLButtonElement>(`[data-node-id="${focusId}"]`)
        ?.focus();
  }
  search.oninput = () => {
    matches = matchingConfigNodes(tree, search.value);
    collapsedMatches.clear();
    limit = pageSize;
    render();
  };
  tools.append(
    search,
    action("Expand all", () => {
      for (const node of tree.nodes) expanded.add(node.id);
      collapsedMatches.clear();
      render();
    }),
    action("Collapse all", () => {
      expanded.clear();
      if (matches) for (const node of tree.nodes) collapsedMatches.add(node.id);
      limit = pageSize;
      render();
    }),
    count,
  );
  const hint = element(
    "p",
    "run-config-hint",
    "Paths copy as exact JSONPath, preserving literal dots in keys. Values copy as JSON.",
  );
  hint.append(status);
  section.append(heading, tools, hint, rows, more);
  render();
  return section;
}
