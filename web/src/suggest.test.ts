import test from "node:test";
import assert from "node:assert/strict";
import { commonPrefix, rankSuggestions } from "./suggest";

const items = [
  "train.optim.lr",
  "train.optim.momentum",
  "train.batch_size",
  "model.layers",
  "tag:owner",
  "tag:lr_schedule",
].map((value) => ({ value }));

test("prefix beats segment start beats substring; order is otherwise stable", () => {
  // Both start a segment ("optim.lr", "tag:lr…"): a tie keeps source order.
  assert.deepEqual(
    rankSuggestions("lr", items).map((s) => s.value),
    ["train.optim.lr", "tag:lr_schedule"],
  );
  assert.deepEqual(
    rankSuggestions("model", items).map((s) => s.value),
    ["model.layers"],
  );
  assert.deepEqual(
    rankSuggestions("a", [{ value: "xa" }, { value: "x.a" }, { value: "ab" }]).map(
      (s) => s.value,
    ),
    ["ab", "x.a", "xa"],
  );
  assert.deepEqual(
    rankSuggestions("train.o", items).map((s) => s.value),
    ["train.optim.lr", "train.optim.momentum"],
  );
  assert.deepEqual(
    rankSuggestions("ptim", items).map((s) => s.value),
    ["train.optim.lr", "train.optim.momentum"],
  );
  assert.deepEqual(rankSuggestions("TAG:", items).length, 2);
  assert.equal(rankSuggestions("", items, 3).length, 3);
  assert.deepEqual(rankSuggestions("nothing", items), []);
});

test("Tab extends to the longest shared prefix", () => {
  assert.equal(
    commonPrefix(["train.optim.lr", "train.optim.momentum"]),
    "train.optim.",
  );
  assert.equal(commonPrefix(["Tag:A", "tag:b"]), "Tag:");
  assert.equal(commonPrefix(["only"]), "only");
  assert.equal(commonPrefix([]), "");
});
