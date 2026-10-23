import { assertSafe, validateConfig, type ViewConfig } from "./config";
export interface SavedView {
  format: "nset-view";
  version: 1;
  config: ViewConfig;
  experiment: string;
  runIds: string[];
  metric: string;
  pins: { a: number | null; b: number | null; threshold: number | null };
}
export function validateView(value: unknown): SavedView {
  assertSafe(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a saved view object.");
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v))
    if (
      ![
        "format",
        "version",
        "config",
        "experiment",
        "runIds",
        "metric",
        "pins",
      ].includes(key)
    )
      throw new Error(`Unknown saved view field: ${key}`);
  if (v.format !== "nset-view" || v.version !== 1)
    throw new Error("Unsupported saved view format/version.");
  if (
    typeof v.experiment !== "string" ||
    typeof v.metric !== "string" ||
    !Array.isArray(v.runIds) ||
    v.runIds.some((id) => typeof id !== "string")
  )
    throw new Error("Invalid saved view selection.");
  if (!v.pins || typeof v.pins !== "object" || Array.isArray(v.pins))
    throw new Error("Invalid saved view cursors.");
  const p = v.pins as Record<string, unknown>;
  for (const key of Object.keys(p))
    if (!["a", "b", "threshold"].includes(key))
      throw new Error(`Unknown cursor field: ${key}`);
  for (const key of ["a", "b", "threshold"])
    if (
      p[key] !== null &&
      (typeof p[key] !== "number" || !Number.isFinite(p[key]))
    )
      throw new Error(`Invalid ${key} cursor.`);
  return { ...v, config: validateConfig(v.config) } as unknown as SavedView;
}
export function readLibrary(
  storage: Pick<Storage, "getItem">,
): Record<string, SavedView> {
  const value = JSON.parse(storage.getItem("nset.views") ?? "{}");
  assertSafe(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid view library.");
  const out: Record<string, SavedView> = {};
  for (const [key, view] of Object.entries(value))
    out[key] = validateView(view);
  return out;
}
