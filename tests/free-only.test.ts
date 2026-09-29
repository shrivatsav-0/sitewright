/**
 * Free-only gate tests.
 *
 * `AI_FREE_ONLY=1` is a hard guarantee, not a ranking preference: a model
 * whose published input or output cost is not both zero is removed from the
 * candidate set entirely, so a pay-per-token call can never happen. These
 * tests pin that behaviour and the rejection reasons surfaced to the panel.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { applyFreeOnlyGate } from "../src/lib/ai/models";
import type { DiscoveredModel } from "../src/lib/ai/provider";

function model(id: string, isFree: boolean): DiscoveredModel & { pricingVerified?: boolean } {
  return {
    id: `openai-compatible/${id}`,
    provider: "openai-compatible",
    model: id,
    name: id,
    costIn: isFree ? 0 : 5,
    costOut: isFree ? 0 : 5,
    isFree,
    supportsImages: false,
    supportsTools: true,
  };
}

describe("applyFreeOnlyGate", () => {
  test("keeps only models whose input and output cost are both zero", () => {
    const usable = [model("a:free", true), model("b:paid", false), model("c:free", true)];
    const rejected: { id: string; reason: string }[] = [];
    const kept = applyFreeOnlyGate(usable, rejected);
    assert.deepEqual(kept.map((m) => m.model), ["a:free", "c:free"]);
  });

  test("records a rejection for every paid model", () => {
    const usable = [model("x:paid", false)];
    const rejected: { id: string; reason: string }[] = [];
    applyFreeOnlyGate(usable, rejected);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.id, "openai-compatible/x:paid");
    assert.match(rejected[0]?.reason ?? "", /AI_FREE_ONLY=1/);
  });

  test("does not mutate the input list", () => {
    const usable = [model("keep:free", true), model("drop:paid", false)];
    const before = usable.map((m) => m.model);
    applyFreeOnlyGate(usable, []);
    assert.deepEqual(usable.map((m) => m.model), before);
  });

  test("returns an empty set when nothing is free; the pipeline then fails hard", () => {
    const usable = [model("only:paid", false)];
    const kept = applyFreeOnlyGate(usable, []);
    assert.equal(kept.length, 0);
  });
});