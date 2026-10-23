import { configPath, type ConfigPath } from "./run-config";

export type ScalarParameter = string | number | boolean | null;
export interface ParameterField {
  sourcePath: string;
  search: string;
  value: ScalarParameter;
}

/** Exact scalar leaves only; never interpret literal dots as object traversal. */
export function scalarParameters(
  params: Record<string, unknown>,
): ParameterField[] {
  const fields: ParameterField[] = [];
  const pending: { path: ConfigPath; value: unknown }[] = Object.entries(
    params,
  ).map(([key, value]) => ({ path: [key], value }));
  while (pending.length) {
    const { path, value } = pending.pop()!;
    if (
      value === null ||
      ["string", "number", "boolean"].includes(typeof value)
    ) {
      const sourcePath = configPath(path);
      fields.push({
        sourcePath,
        search: `${sourcePath}\n${path.join(".")}`.toLowerCase(),
        value: value as ScalarParameter,
      });
    } else if (typeof value === "object") {
      const entries = Array.isArray(value)
        ? value.map((value, index) => [index, value] as const)
        : Object.entries(value);
      for (const [key, child] of entries)
        pending.push({ path: [...path, key], value: child });
    }
  }
  return fields;
}

export function parameterLabel(value: ScalarParameter | undefined): string {
  return value === undefined ? "—" : JSON.stringify(value);
}

/** Null and missing sort after present values in either direction. */
export function compareParameters(
  a: ScalarParameter | undefined,
  b: ScalarParameter | undefined,
  descending: boolean,
): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  const result =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : typeof a === "boolean" && typeof b === "boolean"
        ? Number(a) - Number(b)
        : parameterLabel(a).localeCompare(parameterLabel(b));
  return (descending ? -1 : 1) * result;
}
