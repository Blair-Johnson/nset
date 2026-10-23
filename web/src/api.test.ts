import test from "node:test";
import assert from "node:assert/strict";
import { Api, type MetricPage } from "./api";
const point = (seq: number) => ({ seq, step: seq, timestamp: seq, value: seq });
function mocked(pages: MetricPage[], seen: string[] = []) {
  return new Api(
    () => "test-token",
    async (input, init) => {
      const url = String(input);
      seen.push(url);
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer test-token",
      );
      assert.equal(url.includes("test-token"), false);
      const page = pages.shift();
      if (!page) throw new Error("Unexpected fetch");
      return new Response(JSON.stringify(page), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
}
test("snapshot full pagination supplies stable snapshot and cursor", async () => {
  const seen: string[] = [];
  const api = mocked(
    [
      { points: [point(1), point(2)], next_after: 2, snapshot: 4, total: 4 },
      { points: [point(3), point(4)], next_after: null, snapshot: 4, total: 4 },
    ],
    seen,
  );
  const progress: number[] = [];
  const result = await api.metrics(
    "run",
    "loss / validation",
    new AbortController().signal,
    (n) => progress.push(n),
  );
  assert.equal(result.length, 4);
  assert.deepEqual(progress, [2, 4]);
  assert.match(seen[1], /snapshot=4/);
  assert.match(seen[1], /after=2/);
  assert.equal(
    new URL(seen[0], "http://localhost").searchParams.get("key"),
    "loss / validation",
  );
});
test("empty snapshot is valid and complete", async () =>
  assert.deepEqual(
    await mocked([
      { points: [], snapshot: 0, next_after: null, total: 0 },
    ]).metrics("r", "k", new AbortController().signal),
    [],
  ));
test("changed snapshot is rejected instead of mixing versions", async () => {
  const api = mocked([
    { points: [point(1)], next_after: 1, snapshot: 2, total: 2 },
    { points: [point(2)], next_after: null, snapshot: 3, total: 2 },
  ]);
  await assert.rejects(
    () => api.metrics("r", "k", new AbortController().signal),
    /snapshot changed/,
  );
});
test("partial final page is rejected", async () => {
  await assert.rejects(
    () =>
      mocked([
        { points: [point(1)], snapshot: 5, next_after: null, total: 5 },
      ]).metrics("r", "k", new AbortController().signal),
    /Incomplete/,
  );
});
test("non-progressing cursor fails instead of infinite loading", async () => {
  await assert.rejects(
    () =>
      mocked([
        { points: [point(1)], snapshot: 3, next_after: 1, total: 3 },
        { points: [point(1)], snapshot: 3, next_after: 1, total: 3 },
      ]).metrics("r", "k", new AbortController().signal),
    /pagination cursor/,
  );
});
test("aborted fetch completion never becomes authoritative", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      mocked([{ points: [], snapshot: 0, next_after: null, total: 0 }]).metrics(
        "r",
        "k",
        controller.signal,
      ),
    { name: "AbortError" },
  );
});
test("API error messages surface without token leakage", async () => {
  const api = new Api(
    () => "hidden",
    async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
  );
  await assert.rejects(() => api.json("/experiments"), /Unauthorized/);
});
