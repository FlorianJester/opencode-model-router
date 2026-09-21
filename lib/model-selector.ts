export type ModelEntry = {
  modelID: string;
  providerID: string;
  price: number;
  toolCall: boolean;
  /** Catalog release date as epoch ms; undefined when the catalog omits it. */
  released?: number;
};

type ModelsDevModel = {
  cost?: { input?: number; output?: number };
  tool_call?: boolean;
  release_date?: string;
};
type ModelsDevProvider = {
  models?: Record<string, ModelsDevModel>;
};
export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export function flattenModels(
  catalog: ModelsDevCatalog,
): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const [providerID, provider] of Object.entries(catalog)) {
    const models = provider?.models ?? {};
    for (const [modelID, model] of Object.entries(models)) {
      const cost = model?.cost ?? {};
      const input = Number(cost.input ?? 0);
      const output = Number(cost.output ?? 0);
      const released = model?.release_date ? Date.parse(model.release_date) : NaN;
      entries.push({
        modelID,
        providerID,
        price: input + output,
        toolCall: model?.tool_call === true,
        released: Number.isFinite(released) ? released : undefined,
      });
    }
  }
  return entries;
}

export function filterToolCalling(
  entries: ModelEntry[],
): ModelEntry[] {
  return entries.filter((e) => e.toolCall);
}

export function filterFree(
  entries: ModelEntry[],
): ModelEntry[] {
  return entries.filter((e) => e.price > 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a model entry against deny patterns. A pattern can be:
 *  - an exact model ID:            "opencode-go/glm-5.3-flash"
 *  - a bare provider ID (whole provider): "xai"
 *  - a glob with "*" wildcards:    "google-vertex/*gemini*"
 */
export function matchesDeny(fullID: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.length === 0) continue;
    if (pattern === fullID) return true;
    if (pattern.includes("*")) {
      const re = new RegExp(
        `^${pattern.split("*").map(escapeRegExp).join(".*")}$`,
      );
      if (re.test(fullID)) return true;
    } else if (!pattern.includes("/") && fullID.startsWith(`${pattern}/`)) {
      return true; // bare provider ID denies the whole provider
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Capability scoring
 *
 * Subagents are picked by capability, not by price rank. A price rank
 * cannot tell "expensive because it is good" from "expensive and bad" -
 * it happily promotes the priciest model in the catalog to `heavy`.
 * ------------------------------------------------------------------ */

/** A scored axis: one or more versions of a benchmark family. */
export type BenchmarkFamily = {
  weight: number;
  /**
   * Candidate benchmark IDs, best first. Exactly one is used per model, so
   * incomparable versions (Terminal-Bench 2.1 vs 4.0) never blend.
   */
  members: string[];
};

export type ModelBenchmarks = {
  /** Benchmark ID -> raw score on that benchmark's own published scale. */
  scores: Record<string, number>;
  /** Key into the table's `sources` map. */
  source: string;
  /** Recorded for humans. Never scored. */
  advisory?: Record<string, number>;
};

export type BenchmarkTable = {
  version: number;
  updated?: string;
  /** Minimum number of families a model must report to be scored at all. */
  minFamilies?: number;
  /** Families that must be represented, else the model is not scored. */
  core?: string[];
  families: Record<string, BenchmarkFamily>;
  sources?: Record<string, string>;
  models: Record<string, ModelBenchmarks>;
};

export type ScoredModelEntry = ModelEntry & {
  /** Weighted capability mean, 0-100. Undefined when evidence is insufficient. */
  capability?: number;
  /** Family -> the benchmark ID the score came from (audit trail). */
  basis?: Record<string, string>;
  /** Provenance of the scores, from the table's `sources` map. */
  source?: string;
};

/** Scores land in this band; used to absorb float error at floor boundaries. */
const EPS = 1e-9;

/**
 * Weighted capability score for one model, or an empty object when the model
 * is absent from the table or reports too little evidence to be ranked.
 */
export function capabilityScore(
  fullID: string,
  table: BenchmarkTable | undefined,
): { capability?: number; basis?: Record<string, string>; source?: string } {
  const row = table?.models?.[fullID];
  if (!row) return {};

  const families = table?.families ?? {};
  const core = new Set(table?.core ?? []);
  const basis: Record<string, string> = {};
  let weighted = 0;
  let weight = 0;
  let coreHit = false;

  for (const [family, def] of Object.entries(families)) {
    const member = (def?.members ?? []).find(
      (id) => typeof row.scores?.[id] === "number",
    );
    if (!member) continue;
    const w = Number(def?.weight ?? 0);
    if (!(w > 0)) continue;
    weighted += row.scores[member] * w;
    weight += w;
    basis[family] = member;
    if (core.has(family)) coreHit = true;
  }

  const minFamilies = table?.minFamilies ?? 1;
  if (weight <= 0 || Object.keys(basis).length < minFamilies || !coreHit) {
    return { basis, source: row.source };
  }
  return { capability: weighted / weight, basis, source: row.source };
}

export type TierFloors = { lite?: number; medium?: number; heavy?: number };

export type TierSelection = {
  lite?: ScoredModelEntry;
  medium?: ScoredModelEntry;
  heavy?: ScoredModelEntry;
  /** "capability" = floors drove the pick, "price" = legacy price rank. */
  strategy: "capability" | "price";
  /** Floors actually applied (explicit overrides or cohort quantiles). */
  floors?: { lite: number; medium: number; heavy: number };
  /**
   * In-scope models the benchmark table does not score. This is the table's
   * upkeep list: every entry here is a model the router can never pick.
   */
  gaps: string[];
  /**
   * Scored in-scope models another model beats on every axis at once - no more
   * capable, no cheaper and no newer - so picking them could only lose. Pruned
   * before any tier is filled: a stale model is never chosen while a same-price,
   * stronger, newer one exists.
   */
  dominated: string[];
  warnings: string[];
};

function fullID(entry: ModelEntry): string {
  return `${entry.providerID}/${entry.modelID}`;
}

/** Models the catalog has no release date for sort last, never excluded. */
function byFreshness(a: ScoredModelEntry, b: ScoredModelEntry): number {
  return (b.released ?? 0) - (a.released ?? 0);
}

/** Capability per dollar of throughput (input + output price). */
function valuePerDollar(entry: ScoredModelEntry): number {
  return (entry.capability ?? 0) / entry.price;
}

/**
 * True when `a` is at least as good as `b` on all three axes - capability,
 * price and recency - and strictly better on one. A dominated model can never
 * be the right pick: whatever you want from it, `a` gives you more for no more
 * money, no older.
 */
function dominates(a: ScoredModelEntry, b: ScoredModelEntry): boolean {
  const cap = (m: ScoredModelEntry) => m.capability ?? 0;
  const released = (m: ScoredModelEntry) => m.released ?? 0;
  const atLeastAsGood =
    cap(a) >= cap(b) - EPS &&
    a.price <= b.price + EPS &&
    released(a) >= released(b);
  const strictlyBetter =
    cap(a) > cap(b) + EPS ||
    a.price < b.price - EPS ||
    released(a) > released(b);
  return atLeastAsGood && strictlyBetter;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Selection objective per tier, applied to the models that clear its floor.
 *
 * - `heavy`  maximum capability; freshness then price break ties.
 * - `lite`   minimum price; freshness then capability break ties.
 * - `medium` best capability per dollar; freshness then capability then price
 *            break ties.
 *
 * Freshness is the catalog's release date, so an equally good and equally
 * priced model that shipped later wins the tie.
 */
const RANKING: Record<
  "lite" | "medium" | "heavy",
  (a: ScoredModelEntry, b: ScoredModelEntry) => number
> = {
  heavy: (a, b) =>
    (b.capability ?? 0) - (a.capability ?? 0) || byFreshness(a, b) ||
    a.price - b.price || fullID(a).localeCompare(fullID(b)),
  lite: (a, b) =>
    a.price - b.price || byFreshness(a, b) ||
    (b.capability ?? 0) - (a.capability ?? 0) || fullID(a).localeCompare(fullID(b)),
  medium: (a, b) =>
    valuePerDollar(b) - valuePerDollar(a) || byFreshness(a, b) ||
    (b.capability ?? 0) - (a.capability ?? 0) || a.price - b.price ||
    fullID(a).localeCompare(fullID(b)),
};

/** Nearest-rank quantile of an ascending array. */
function quantile(ascending: number[], q: number): number {
  if (ascending.length === 0) return 0;
  const idx = Math.round(q * (ascending.length - 1));
  return ascending[Math.min(Math.max(idx, 0), ascending.length - 1)];
}

/**
 * Legacy price-rank assignment. Used when no candidate carries a capability
 * score (unknown providers, empty benchmark table) so the plugin still works
 * on catalogs the table does not cover.
 */
function selectByPrice(
  candidates: ModelEntry[],
  opts: { liteDeny: string[]; heavyDeny?: string[] },
): { lite?: ModelEntry; medium?: ModelEntry; heavy?: ModelEntry } {
  const sorted = [...candidates].sort((a, b) => a.price - b.price);

  const pick = (deny: string[] | undefined, exclude: Set<string>) =>
    sorted.find(
      (e) =>
        !matchesDeny(fullID(e), deny) && !exclude.has(fullID(e)),
    );

  const pickLast = (deny: string[] | undefined, exclude: Set<string>) =>
    [...sorted]
      .reverse()
      .find(
        (e) =>
          !matchesDeny(fullID(e), deny) && !exclude.has(fullID(e)),
      );

  const lite = pick(opts.liteDeny, new Set());
  const used = new Set(lite ? [fullID(lite)] : []);
  const heavy = pickLast(opts.heavyDeny ?? [], used);
  if (heavy) used.add(fullID(heavy));
  const remaining = sorted.filter((e) => !used.has(fullID(e)));
  const medium =
    remaining.length > 0
      ? remaining[Math.floor((remaining.length - 1) / 2)]
      : undefined;

  return { lite, medium, heavy };
}

/**
 * Assign the three worker tiers from the benchmark table.
 *
 * Each tier has a capability floor: models below it are ineligible. Above the
 * floor the tier's own objective decides (see `RANKING`), so `lite` buys the
 * cheapest adequate model, `medium` the best capability per dollar, and
 * `heavy` the strongest model that exists.
 *
 * Floors default to quantiles of the scored cohort in scope: lite = 25th
 * percentile, medium = median, heavy = best available. Set `floors` to
 * override any of them.
 *
 * Filled strongest tier first: `heavy` reserves the top model, `medium` takes
 * the best remaining value above its floor, and `lite` is restricted to models
 * no stronger than `medium`'s pick - so capability is monotone across tiers and
 * a cheap tier can never outrank the workhorse tier. Tiers stay distinct unless
 * the cohort is too small to fill them, in which case a warning records the
 * reuse.
 *
 * Dominated models are pruned before any tier is filled (see `dominates`), so a
 * stale model is never chosen while a same-price, stronger, newer one exists.
 */
export function selectTierModels(
  entries: ModelEntry[],
  opts: {
    providers: string[];
    deny?: string[];
    liteDeny: string[];
    heavyDeny?: string[];
    benchmarks?: BenchmarkTable;
    floors?: TierFloors;
  },
): TierSelection {
  const candidates: ScoredModelEntry[] = filterFree(filterToolCalling(entries))
    .filter((e) => opts.providers.includes(e.providerID))
    .filter((e) => !matchesDeny(fullID(e), opts.deny))
    .sort((a, b) => a.price - b.price || fullID(a).localeCompare(fullID(b)))
    .map((e) => ({ ...e, ...capabilityScore(fullID(e), opts.benchmarks) }));

  const scored = candidates.filter((e) => typeof e.capability === "number");

  if (scored.length === 0) {
    return {
      ...selectByPrice(candidates, opts),
      strategy: "price",
      gaps: [],
      dominated: [],
      warnings: opts.benchmarks
        ? ["no candidate is covered by the benchmark table; fell back to price ranking"]
        : [],
    };
  }

  // Freshness dominates: drop models another one beats on capability, price and
  // recency at once. Floors still come from the whole scored cohort - they
  // describe what is adequate for the work, not what happens to be pruned - but
  // no tier can pick a model that loses on every axis.
  const dominated = scored.filter((e) => scored.some((o) => o !== e && dominates(o, e)));
  const dominatedIDs = new Set(dominated.map(fullID));
  const live = scored.filter((e) => !dominatedIDs.has(fullID(e)));

  const caps = scored.map((e) => e.capability as number).sort((a, b) => a - b);
  const floors = {
    lite: opts.floors?.lite ?? quantile(caps, 0.25),
    medium: opts.floors?.medium ?? quantile(caps, 0.5),
    heavy: opts.floors?.heavy ?? caps[caps.length - 1],
  };

  const warnings: string[] = [];
  const used = new Set<string>();

  const pick = (
    tier: "lite" | "medium" | "heavy",
    maxCap?: number,
  ): ScoredModelEntry | undefined => {
    const deny =
      tier === "lite" ? opts.liteDeny : tier === "heavy" ? opts.heavyDeny : undefined;
    const rankable = live.filter((e) => !matchesDeny(fullID(e), deny));
    const floor = floors[tier];
    // Capability ceiling, used to keep a tier below a stronger one.
    const under = (e: ScoredModelEntry) =>
      maxCap === undefined || (e.capability as number) <= maxCap + EPS;

    const clearing = rankable
      .filter((e) => !used.has(fullID(e)) && (e.capability as number) >= floor - EPS)
      .filter(under)
      .sort(RANKING[tier]);
    const winner = clearing[0];

    // A model already assigned to a stronger tier can beat the best unused
    // candidate on capability *and* price at once. Buying the candidate then
    // pays more for less just to keep the tiers distinct - never right.
    const reusable = winner
      ? rankable
          .filter((e) => used.has(fullID(e)) && under(e))
          .sort(RANKING[tier])
          .find(
            (e) =>
              (e.capability as number) >= (winner.capability as number) - EPS &&
              e.price <= winner.price + EPS,
          )
      : undefined;

    if (winner && reusable) {
      warnings.push(
        `${tier}: reuses ${fullID(reusable)} (score ${round2(reusable.capability as number)}, ` +
          `$${reusable.price}/Mtok); no unused model clearing floor ${round2(floor)} is both as ` +
          `strong and as cheap (best was ${fullID(winner)}, score ` +
          `${round2(winner.capability as number)}, $${winner.price}/Mtok)`,
      );
      return reusable;
    }

    if (winner) {
      used.add(fullID(winner));
      return winner;
    }

    // Nothing unused clears the floor. Never silently hand the tier to an
    // under-capable model: record the shortfall and take the best available.
    const fallback = rankable
      .filter((e) => !used.has(fullID(e)))
      .filter(under)
      .sort(
        (a, b) => (b.capability ?? 0) - (a.capability ?? 0) || byFreshness(a, b) ||
          a.price - b.price || fullID(a).localeCompare(fullID(b)),
      )[0];
    if (fallback) {
      warnings.push(
        `${tier}: no unused model clears the capability floor ${round2(floor)}` +
          (maxCap === undefined ? "" : ` under ceiling ${round2(maxCap)}`) +
          `; fell back to ${fullID(fallback)} (${round2(fallback.capability as number)})`,
      );
      used.add(fullID(fallback));
      return fallback;
    }

    // Cohort exhausted: allow a repeat rather than leaving the tier unset.
    const reuse = rankable
      .filter((e) => (e.capability as number) >= floor - EPS)
      .filter(under)
      .sort(RANKING[tier])[0];
    if (reuse) {
      warnings.push(
        `${tier}: reuses ${fullID(reuse)} (every model clearing floor ${round2(floor)}` +
          (maxCap === undefined ? "" : ` under ceiling ${round2(maxCap)}`) +
          ` is already assigned)`,
      );
      return reuse;
    }
    return undefined;
  };

  // Fill order is what makes tier capability monotone: `heavy` reserves the
  // strongest model, `medium` takes the best value above the median, and `lite`
  // is then restricted to models no stronger than `medium`'s pick - a cheap
  // tier can never outrank the workhorse tier.
  const heavy = pick("heavy");
  const medium = pick("medium");
  const lite = pick("lite", medium?.capability);

  const gaps = opts.benchmarks
    ? candidates.filter((e) => typeof e.capability !== "number").map(fullID)
    : [];

  return {
    lite,
    medium,
    heavy,
    strategy: "capability",
    floors,
    gaps,
    dominated: dominated.map(fullID),
    warnings,
  };
}
