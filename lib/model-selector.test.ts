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
describe("capability floors", () => {
  const benchCatalog = {
    bench: {
      models: {
        // Cheap and adequate - the twin released later exercises freshness.
        "adept-old": { cost: { input: 0.1, output: 0.1 }, tool_call: true, release_date: "2026-01-01" },
        "adept-new": { cost: { input: 0.1, output: 0.1 }, tool_call: true, release_date: "2026-06-01" },
        // Middling capability at a low price: the capability-per-dollar winner.
        value: { cost: { input: 0.3, output: 0.3 }, tool_call: true, release_date: "2026-03-01" },
        "strong-cheap": { cost: { input: 0.35, output: 0.35 }, tool_call: true, release_date: "2026-09-01" },
        // Two 92s, one older: the heavy tie-break.
        "strong-pricey": { cost: { input: 3, output: 3 }, tool_call: true, release_date: "2026-02-01" },
        "strong-newest": { cost: { input: 3, output: 3 }, tool_call: true, release_date: "2026-08-01" },
        // Priciest and newest, but weak: price rank would have promoted it.
        "weak-expensive": { cost: { input: 25, output: 25 }, tool_call: true, release_date: "2026-09-15" },
        "no-evidence": { cost: { input: 0.01, output: 0.01 }, tool_call: true, release_date: "2026-09-20" },
        "single-bench": { cost: { input: 0.01, output: 0.01 }, tool_call: true, release_date: "2026-09-19" },
        "non-core-bench": { cost: { input: 0.01, output: 0.01 }, tool_call: true, release_date: "2026-09-18" },
        "tb40-only": { cost: { input: 0.01, output: 0.01 }, tool_call: true, release_date: "2026-09-17" },
      },
    },
  };

  const table = {
    version: 1,
    minFamilies: 2,
    core: ["agentic"],
    families: {
      agentic: { weight: 40, members: ["tb21"] },
      swe: { weight: 25, members: ["deepswe11"] },
    },
    models: {
      "bench/adept-old": { source: "test", scores: { tb21: 80, deepswe11: 80 } },
      "bench/adept-new": { source: "test", scores: { tb21: 80, deepswe11: 80 } },
      "bench/value": { source: "test", scores: { tb21: 84, deepswe11: 84 } },
      "bench/strong-cheap": { source: "test", scores: { tb21: 88, deepswe11: 88 } },
      "bench/strong-pricey": { source: "test", scores: { tb21: 92, deepswe11: 92 } },
      "bench/strong-newest": { source: "test", scores: { tb21: 92, deepswe11: 92 } },
      "bench/weak-expensive": { source: "test", scores: { tb21: 60, deepswe11: 60 } },
      "bench/single-bench": { source: "test", scores: { tb21: 99 } },
      "bench/non-core-bench": { source: "test", scores: { deepswe11: 99 } },
      "bench/tb40-only": { source: "test", scores: { tb40: 99, deepswe11: 99 } },
    },
  };

  const benchEntries = flattenModels(benchCatalog);
  const select = () =>
    selectTierModels(benchEntries, {
      providers: ["bench"],
      liteDeny: [],
      benchmarks: table,
    });

  test("each tier applies its own objective", () => {
    const { lite, medium, heavy, strategy, warnings } = select();
    assert.equal(strategy, "capability");
    assert.deepEqual(warnings, []);
    // lite: cheapest adequate model, freshness breaking the twin tie.
    assert.equal(lite?.modelID, "adept-new");
    // medium: best capability per dollar (value 84/0.6 beats strong-cheap 88/0.7).
    assert.equal(medium?.modelID, "value");
    // heavy: maximum capability, freshness breaking the 92/92 tie.
    assert.equal(heavy?.modelID, "strong-newest");
  });

  test("the priciest model is never promoted for being priciest", () => {
    const { lite, medium, heavy } = select();
    const picked = [lite!.modelID, medium!.modelID, heavy!.modelID];
    assert.ok(!picked.includes("weak-expensive"));
  });

  test("tiers stay distinct and clear their floors", () => {
    const { lite, medium, heavy, floors } = select();
    assert.deepEqual(floors, { lite: 80, medium: 84, heavy: 92 });
    const ids = [lite!.modelID, medium!.modelID, heavy!.modelID];
    assert.equal(new Set(ids).size, 3);
    assert.ok((lite!.capability as number) >= floors!.lite);
    assert.ok((medium!.capability as number) >= floors!.medium);
    assert.ok((heavy!.capability as number) >= floors!.heavy);
  });

  test("evidence-poor models are never routed and are reported as gaps", () => {
    const { lite, medium, heavy, gaps } = select();
    const picked = [lite!.modelID, medium!.modelID, heavy!.modelID];
    const unscored = ["single-bench", "non-core-bench", "tb40-only", "no-evidence"];
    for (const id of unscored) {
      assert.ok(!picked.includes(id), `${id} must not be routed by capability`);
    }
    assert.deepEqual([...gaps].sort(), unscored.map((id) => `bench/${id}`).sort());
  });

  test("only the family's chosen benchmark version counts", () => {
    const picked = selectTierModels(benchEntries, {
      providers: ["bench"],
      liteDeny: [],
      benchmarks: table,
      floors: { lite: 99, medium: 99, heavy: 99 },
    });
    // tb40-only scores 99 on the excluded version; it must not become the fallback.
    assert.notEqual(picked.heavy?.modelID, "tb40-only");
    assert.equal(picked.heavy?.modelID, "strong-newest");
  });

  test("an unreachable floor falls back to the best available and warns", () => {
    const { heavy, warnings } = selectTierModels(benchEntries, {
      providers: ["bench"],
      liteDeny: [],
      benchmarks: table,
      floors: { heavy: 99 },
    });
    assert.equal(heavy?.modelID, "strong-newest");
    assert.ok(warnings.some((w) => w.includes("heavy") && w.includes("99")));
  });

  test("explicit floors gate eligibility without changing objectives", () => {
    const { lite, medium, heavy, floors, warnings } = selectTierModels(benchEntries, {
      providers: ["bench"],
      liteDeny: [],
      benchmarks: table,
      floors: { lite: 60, medium: 60, heavy: 60 },
    });
    assert.deepEqual(floors, { lite: 60, medium: 60, heavy: 60 });
    // Lowering the floors admits the weak models but does not make them winners:
    // medium still buys the best value left, and lite reuses it rather than
    // buying `weak-expensive` ($50/Mtok for score 60) just to stay distinct.
    assert.equal(medium?.modelID, "adept-new");
    assert.equal(lite?.modelID, "adept-new");
    assert.equal(heavy?.modelID, "strong-newest");
    assert.ok(warnings.some((w) => w.startsWith("lite: reuses")));
  });

  test("lite is never stronger than medium, medium never stronger than heavy", () => {
    const { lite, medium, heavy } = select();
    assert.ok((lite!.capability as number) <= (medium!.capability as number));
    assert.ok((medium!.capability as number) <= (heavy!.capability as number));
  });

  test("a strong cheap model cannot pull lite above medium", () => {
    // `cheap-strong` is both the cheapest and the second-strongest model, so a
    // price-first lite pick would outrank whatever medium buys on value.
    const catalog = {
      gap: {
        models: {
          "cheap-strong": { cost: { input: 0.04, output: 0.04 }, tool_call: true, release_date: "2026-05-01" },
          strongest: { cost: { input: 3, output: 3 }, tool_call: true, release_date: "2026-05-02" },
          midpriced: { cost: { input: 0.3, output: 0.3 }, tool_call: true, release_date: "2026-05-03" },
          "adequate-old": { cost: { input: 0.4, output: 0.4 }, tool_call: true, release_date: "2026-05-04" },
          weakest: { cost: { input: 0.5, output: 0.5 }, tool_call: true, release_date: "2026-05-05" },
        },
      },
    };
    const gaps = {
      version: 1,
      minFamilies: 2,
      core: ["agentic"],
      families: {
        agentic: { weight: 40, members: ["tb21"] },
        swe: { weight: 25, members: ["deepswe11"] },
      },
      models: {
        "gap/cheap-strong": { source: "test", scores: { tb21: 86, deepswe11: 86 } },
        "gap/strongest": { source: "test", scores: { tb21: 95, deepswe11: 95 } },
        "gap/midpriced": { source: "test", scores: { tb21: 76, deepswe11: 76 } },
        "gap/adequate-old": { source: "test", scores: { tb21: 74, deepswe11: 74 } },
        "gap/weakest": { source: "test", scores: { tb21: 72, deepswe11: 72 } },
      },
    };
    const { lite, medium, heavy, warnings } = selectTierModels(flattenModels(catalog), {
      providers: ["gap"],
      liteDeny: [],
      benchmarks: gaps,
    });
    assert.equal(heavy?.modelID, "strongest");
    assert.equal(medium?.modelID, "cheap-strong");
    // `midpriced` is both weaker and pricier than medium's pick, so lite reuses
    // it instead of paying more for less.
    assert.equal(lite?.modelID, "cheap-strong");
    assert.ok(warnings.some((w) => w.startsWith("lite: reuses")));
    assert.ok(![lite!.modelID, medium!.modelID, heavy!.modelID].includes("midpriced"));
    assert.ok((lite!.capability as number) <= (medium!.capability as number));
    assert.ok((medium!.capability as number) <= (heavy!.capability as number));
  });

  test("a stale model is never picked while a newer equal beats it on every axis", () => {
    // `muse-1.2` and `muse-1.3` are the same price; 1.3 is newer and stronger,
    // so 1.2 is dominated and must never be routed - the exact failure mode
    // where a tier silently downgrades for no saving.
    const catalog = {
      gap: {
        models: {
          "muse-1.2": { cost: { input: 0.1, output: 0.2 }, tool_call: true, release_date: "2026-08-05" },
          "muse-1.3": { cost: { input: 0.1, output: 0.2 }, tool_call: true, release_date: "2026-09-02" },
          "flagship": { cost: { input: 0.3, output: 0.45 }, tool_call: true, release_date: "2026-09-10" },
          "flagship-old": { cost: { input: 0.4, output: 0.5 }, tool_call: true, release_date: "2026-07-01" },
          "flagship-slow": { cost: { input: 0.5, output: 0.6 }, tool_call: true, release_date: "2026-08-20" },
        },
      },
    };
    const gaps = {
      version: 1,
      minFamilies: 2,
      core: ["agentic"],
      families: {
        agentic: { weight: 40, members: ["tb21"] },
        swe: { weight: 25, members: ["deepswe11"] },
      },
      models: {
        "gap/muse-1.2": { source: "test", scores: { tb21: 74.57, deepswe11: 74.57 } },
        "gap/muse-1.3": { source: "test", scores: { tb21: 83.65, deepswe11: 83.65 } },
        "gap/flagship": { source: "test", scores: { tb21: 84.29, deepswe11: 84.29 } },
        "gap/flagship-old": { source: "test", scores: { tb21: 84.29, deepswe11: 84.29 } },
        "gap/flagship-slow": { source: "test", scores: { tb21: 78, deepswe11: 78 } },
      },
    };
    const { lite, medium, heavy, dominated } = selectTierModels(flattenModels(catalog), {
      providers: ["gap"],
      liteDeny: [],
      benchmarks: gaps,
    });
    const picked = [lite!.modelID, medium!.modelID, heavy!.modelID];
    // Same capability and price as `flagship`, but older.
    assert.ok(dominated.includes("gap/flagship-old"));
    assert.ok(dominated.includes("gap/flagship-slow"));
    assert.ok(!picked.includes("muse-1.2"));
    assert.ok(!picked.includes("flagship-old"));
    assert.equal(heavy?.modelID, "flagship");
    assert.equal(medium?.modelID, "muse-1.3");
    assert.equal(lite?.modelID, "muse-1.3");
  });

  test("falls back to price ranking when no candidate has a score", () => {
    const { lite, heavy, strategy, gaps } = selectTierModels(entries, {
      providers: ["opencode-go"],
      liteDeny: [],
      benchmarks: table,
    });
    assert.equal(strategy, "price");
    assert.equal(lite?.modelID, "glm-5.3-flash");
    assert.equal(heavy?.modelID, "kimi-k3");
    assert.deepEqual(gaps, []);
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
