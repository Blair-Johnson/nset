export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
export function numberText(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "\u2014"
    : Number(value.toPrecision(8)).toString();
}
export function finiteInput(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function extent(values: Iterable<number>): [number, number] | null {
  let min = Infinity,
    max = -Infinity;
  for (const n of values)
    if (Number.isFinite(n)) {
      if (n < min) min = n;
      if (n > max) max = n;
    }
  return min === Infinity ? null : [min, max];
}
export function unionSorted(arrays: Iterable<Iterable<number>>): number[] {
  const set = new Set<number>();
  for (const arr of arrays) for (const x of arr) set.add(x);
  return [...set].sort((a, b) => a - b);
}
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export class Latest {
  private value = 0;
  next(): number {
    return ++this.value;
  }
  current(id: number): boolean {
    return id === this.value;
  }
}
export function download(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  const a = element("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function boundedIndex(index: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), index));
}
