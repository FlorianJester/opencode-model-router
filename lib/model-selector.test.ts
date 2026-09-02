import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  flattenModels,
  filterToolCalling,
  filterFree,
  matchesDeny,
  selectTierModels,
  type ModelEntry,
} from "./model-selector.ts";

const catalog = {
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    env: ["OPENCODE_API_KEY"],
    models: {
      "mimo-v2.5": {
        id: "opencode-go/mimo-v2.5",
        name: "MiMo V2.5",
        cost: { input: 0.14, output: 0.28 },
        tool_call: true,
        reasoning: true,
      },
      "glm-5.3-flash": {
        id: "opencode-go/glm-5.3-flash",
        name: "GLM 5.3 Flash",
        cost: { input: 0.075, output: 0.25 },
        tool_call: true,
        reasoning: true,
      },
      "glm-5.3": {
        id: "opencode-go/glm-5.3",
        name: "GLM 5.3",
        cost: { input: 1.4, output: 4.4 },
        tool_call: true,
        reasoning: true,
      },
      "kimi-k3": {
        id: "opencode-go/kimi-k3",
        name: "Kimi K3",
        cost: { input: 3.0, output: 15.0 },
        tool_call: true,
        reasoning: true,
      },
      "not-tool-call": {
        id: "opencode-go/not-tool-call",
        name: "No tool",
        cost: { input: 0.01, output: 0.02 },
        tool_call: false,
        reasoning: false,
      },
      "free-model": {
        id: "opencode-go/free-model",
        name: "Free",
        cost: { input: 0, output: 0 },
        tool_call: true,
        reasoning: true,
      },
    },
  },
  "other-provider": {
    id: "other-provider",
    name: "Other",
    env: ["OTHER_API_KEY"],
    models: {
      "cheap-thing": {
        id: "other-provider/cheap-thing",
        name: "Cheap",
        cost: { input: 0.01, output: 0.01 },
        tool_call: true,
        reasoning: true,
      },
    },
  },
};

const entries: ModelEntry[] = flattenModels(catalog);

describe("flattenModels", () => {
  test("produces one entry per model with provider + model id and price", () => {
    assert.equal(entries.length, 7);
    const mimo = entries.find((e) => e.modelID === "mimo-v2.5");
    assert.ok(mimo);
    assert.equal(mimo.providerID, "opencode-go");
    assert.ok(Math.abs(mimo.price - 0.42) < 1e-9);
  });
});

describe("filterToolCalling", () => {
  test("keeps only tool_call models", () => {
    const filtered = filterToolCalling(entries);
    assert.equal(filtered.length, 6);
    assert.ok(!filtered.some((e) => e.modelID === "not-tool-call"));
  });
});

describe("filterFree", () => {
  test("removes zero-cost models", () => {
    const filtered = filterFree(entries);
    assert.equal(filtered.length, 6);
    assert.ok(!filtered.some((e) => e.modelID === "free-model"));
  });
});

describe("selectTierModels", () => {
  test("cheapest model is selected as lite", () => {
    const { lite } = selectTierModels(entries, {
      providers: ["opencode-go"],
      liteDeny: [],
    });
    assert.equal(lite?.modelID, "glm-5.3-flash");
  });

  test("most expensive model is selected as heavy", () => {
    const { heavy } = selectTierModels(entries, {
      providers: ["opencode-go"],
      liteDeny: [],
    });
    assert.equal(heavy?.modelID, "kimi-k3");
  });

  test("medium is the median price of the remaining candidates", () => {
    const { lite, medium, heavy } = selectTierModels(entries, {
      providers: ["opencode-go"],
      liteDeny: [],
    });
    const prices = [lite!.price, medium!.price, heavy!.price].sort(
      (a, b) => a - b,
    );
    assert.equal(medium!.price, prices[1]);
    assert.notEqual(medium!.modelID, lite!.modelID);
    assert.notEqual(medium!.modelID, heavy!.modelID);
  });

  test("denied models are excluded from selection", () => {
    const { lite } = selectTierModels(entries, {
      providers: ["opencode-go"],
      liteDeny: ["opencode-go/glm-5.3-flash"],
    });
    assert.equal(lite?.modelID, "mimo-v2.5");
  });

  test("only considers models from the given providers", () => {
    const { lite } = selectTierModels(entries, {
      providers: ["other-provider"],
      liteDeny: [],
    });
    assert.equal(lite?.modelID, "cheap-thing");
    assert.equal(lite?.providerID, "other-provider");
  });
});
describe("matchesDeny", () => {
  const patterns = ["google/*gemini*", "google-vertex/*gemini*", "xai/*"];

  test("exact model id matches", () => {
    assert.ok(matchesDeny("opencode-go/glm-5.3-flash", ["opencode-go/glm-5.3-flash"]));
    assert.ok(!matchesDeny("opencode-go/glm-5.3", ["opencode-go/glm-5.3-flash"]));
  });

  test("bare provider id denies the whole provider", () => {
    assert.ok(matchesDeny("xai/grok-4.6", ["xai"]));
    assert.ok(matchesDeny("xai/grok-imagine-video", ["xai"]));
  });

  test("glob patterns match substrings across the full id", () => {
    assert.ok(matchesDeny("google/gemini-3-pro-image", patterns));
    assert.ok(!matchesDeny("google/gemma-4-26b-a4b-it", patterns));
    assert.ok(matchesDeny("google-vertex/gemini-flash-lite-latest", patterns));
    assert.ok(!matchesDeny("google-vertex/claude-sonnet-4-5", patterns));
    assert.ok(matchesDeny("xai/grok-4.6", patterns));
    assert.ok(!matchesDeny("openai/gpt-5.2", patterns));
  });

  test("global deny applies to every tier, including medium", () => {
    const catalog2 = {
      ...catalog,
      xai: {
        id: "xai",
        name: "xAI",
        models: {
          "grok-cheap": { id: "xai/grok-cheap", cost: { input: 0.01, output: 0.02 }, tool_call: true },
          "grok-mid": { id: "xai/grok-mid", cost: { input: 0.1, output: 0.2 }, tool_call: true },
          "grok-pricey": { id: "xai/grok-pricey", cost: { input: 5, output: 15 }, tool_call: true },
        },
      },
    };
    const { lite, medium, heavy } = selectTierModels(flattenModels(catalog2), {
      providers: ["opencode-go", "xai"],
      deny: ["xai/*"],
      liteDeny: [],
    });
    assert.equal(lite?.providerID, "opencode-go");
    assert.equal(medium?.providerID, "opencode-go");
    assert.equal(heavy?.providerID, "opencode-go");
  });
});
