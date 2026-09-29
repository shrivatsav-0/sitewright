/**
 * resolveVisionPlan tests.
 *
 * The analyse step attaches screenshots, so an image-bearing request must
 * never be sent to a model that cannot accept images: OpenRouter answers such
 * a call with a 404 "No endpoints found that support image input", and every
 * text-only candidate in the rotation fails the same way. The plan decides
 * up front whether to keep the images or drop them for the step.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolveVisionPlan } from "../src/lib/ai/models";
import type { DiscoveredModel } from "../src/lib/ai/provider";

function model(id: string, supportsImages: boolean): DiscoveredModel {
  return {
    id: `openai-compatible/${id}`,
    provider: "openai-compatible",
    model: id,
    name: id,
    costIn: 0,
    costOut: 0,
    isFree: true,
    supportsImages,
    supportsTools: true,
  };
}

describe("resolveVisionPlan", () => {
  test("text-only request keeps every candidate and never drops images", () => {
    const candidates = [model("a", false), model("b", false)];
    const plan = resolveVisionPlan(candidates, false);
    assert.equal(plan.dropImages, false);
    assert.deepEqual(plan.candidates.map((m) => m.model), ["a", "b"]);
  });

  test("image request is restricted to vision-capable candidates", () => {
    const candidates = [model("text", false), model("vision-1", true), model("vision-2", true)];
    const plan = resolveVisionPlan(candidates, true);
    assert.equal(plan.dropImages, false);
    assert.deepEqual(plan.candidates.map((m) => m.model), ["vision-1", "vision-2"]);
  });

  test("rotating through text-only candidates cannot heal an image call; they are filtered out", () => {
    const candidates = [model("text-1", false), model("text-2", false)];
    const plan = resolveVisionPlan(candidates, true);
    assert.equal(plan.dropImages, true);
    // The full list is handed back so the caller can retry the step on text.
    assert.deepEqual(plan.candidates.map((m) => m.model), ["text-1", "text-2"]);
  });

  test("a single vision-capable candidate keeps the images", () => {
    const candidates = [model("text", false), model("vision", true)];
    const plan = resolveVisionPlan(candidates, true);
    assert.equal(plan.dropImages, false);
    assert.deepEqual(plan.candidates.map((m) => m.model), ["vision"]);
  });
});