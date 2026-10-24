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
  truncated: boolean;
}

/** Exact source addressing: literal dots in keys never become nested lookups. */
export function configPath(path: ConfigPath): string {
  return "$" + path.map((part) => `[${JSON.stringify(part)}]`).join("");
}
function appendConfigNamespace(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(key))
    return parent ? `${parent}.${key}` : key;
  return `${parent}[${JSON.stringify(key)}]`;
}
/** Human-readable labels shared by native namespaces and exact event trees. */
export function configNamespace(path: ConfigPath): string {
  return path.reduce<string>(appendConfigNamespace, "");
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
export interface ConfigTreeOptions {
  maxFields?: number;
  maxDepth?: number;
  /** Bound exact serialized UTF-8 path bytes before building descendant strings. */
  maxPathBytes?: number;
  /** Event subtrees retain exact keys rather than grouping literal dots. */
  exact?: boolean;
  sourcePath?: ConfigPath;
}
function* configEntries(value: object): Generator<[string | number, unknown]> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield [i, value[i]];
  } else {
    for (const key in value)
      if (Object.hasOwn(value, key))
        yield [key, (value as Record<string, unknown>)[key]];
  }
}
// Reject large components before JSON serialization/UTF-8 allocation. Never
// shorten an address: an omitted subtree remains available in the raw event.
function pathWithinBytes(path: ConfigPath, limit: number): boolean {
  if (limit === Infinity) return true;
  let bytes = 1; // $
  const encoder = new TextEncoder();
  for (const part of path) {
    if (typeof part === "string" && part.length > limit - bytes) return false;
    bytes += encoder.encode(JSON.stringify(part)).length + 2; // brackets
    if (bytes > limit) return false;
  }
  return bytes <= limit;
}
export function buildConfigTree(
  params: Record<string, unknown>,
  options: ConfigTreeOptions = {},
): ConfigTree {
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
  const pending = [
    {
      parent: root,
      entries: configEntries(params),
      path: [] as ConfigPath,
      depth: 0,
    },
  ];
  let fields = 0;
  let truncated = false;
  const maxFields = options.maxFields ?? Infinity;
  const maxDepth = options.maxDepth ?? Infinity;
  const maxPathBytes = options.maxPathBytes ?? Infinity;
  while (pending.length) {
    const frame = pending[pending.length - 1];
    const next = frame.entries.next();
    if (next.done) {
      pending.pop();
      continue;
    }
    if (fields >= maxFields) {
      truncated = true;
      break;
    }
    const [key, entryValue] = next.value;
    const item = {
      parent: frame.parent,
      key,
      value: entryValue,
      path:
        frame.depth === 0 && options.sourcePath
          ? options.sourcePath
          : [...frame.path, key],
    };
    if (
      (typeof key === "string" && key.length > maxPathBytes) ||
      !pathWithinBytes(item.path, maxPathBytes)
    ) {
      truncated = true;
      continue;
    }
    let node = item.parent;
    const parts =
      typeof item.key === "number"
        ? [`[${item.key}]`]
        : options.exact
          ? [item.key]
          : item.key.split(".");
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        child = make(
          options.exact
            ? configNamespace(item.path)
            : appendConfigNamespace(
                node.path,
                typeof item.key === "number" ? item.key : part,
              ),
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
      if (frame.depth >= maxDepth) truncated = true;
      else
        pending.push({
          parent: node,
          entries: configEntries(item.value),
          path: item.path,
          depth: frame.depth + 1,
        });
    }
  }
  for (const node of nodes) {
    node.search = [
      node.path,
      ...node.values.flatMap((v) => [
        v.sourcePath,
        v.preview,
        ...(options.exact ? v.path.map(String) : []),
      ]),
    ]
      .join("\n")
      .toLocaleLowerCase();
  }
  return { root, nodes, fields, truncated };
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

export interface ConfigElement extends HTMLElement {
  setQuery(query: string): void;
  setExpanded(open: boolean): void;
}
export function renderRunConfig(
  params: Record<string, unknown>,
  runId: string,
  options: { tree?: ConfigTree; eventPreview?: boolean } = {},
): ConfigElement {
  const tree = options.tree ?? buildConfigTree(params);
  const section = element("section", "run-config") as ConfigElement;
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
      status.textContent = options.eventPreview
        ? "Copy unavailable. Select the path text."
        : "Copy unavailable. Select text or export JSON.";
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
          value &&
            options.eventPreview &&
            typeof value.value === "number" &&
            (!Number.isFinite(value.value) ||
              (Number.isInteger(value.value) &&
                !Number.isSafeInteger(value.value)))
            ? `${String(value.value)} (approximate / out of range; see raw event)`
            : (value?.preview ?? `${node.children.size} groups / fields`),
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
          actions.append(pathCopy);
          if (!options.eventPreview) actions.append(valueCopy);
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
  section.setQuery = (query: string) => {
    matches = matchingConfigNodes(tree, query);
    collapsedMatches.clear();
    limit = pageSize;
    render();
  };
  search.oninput = () => section.setQuery(search.value);
  section.setExpanded = (open: boolean) => {
    if (open) {
      for (const node of tree.nodes) expanded.add(node.id);
      collapsedMatches.clear();
    } else {
      expanded.clear();
      if (matches) for (const node of tree.nodes) collapsedMatches.add(node.id);
      limit = pageSize;
    }
    render();
  };
  const expand = action("Expand all", () => section.setExpanded(true));
  expand.dataset.configExpand = "true";
  const collapse = action("Collapse all", () => section.setExpanded(false));
  collapse.dataset.configExpand = "false";
  tools.append(search, expand, collapse, count);
  const hint = element(
    "p",
    "run-config-hint",
    "Paths copy as exact JSONPath, preserving literal dots in keys. Values copy as JSON.",
  );
  hint.append(status);
  if (options.eventPreview) {
    section.setAttribute("aria-label", "Event field values");
    section.append(rows, count, status, more);
    if (tree.truncated)
      section.append(
        element(
          "p",
          "muted",
          "Tree preview limited to 1,000 values / 16 levels / 4,096 path bytes. Copy or inspect raw event for all values.",
        ),
      );
  } else section.append(heading, tools, hint, rows, more);
  render();
  return section;
}
