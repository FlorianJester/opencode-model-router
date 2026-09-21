import { type Plugin, type PluginInput, tool } from "@opencode-ai/plugin";
import {
  filterFree,
  filterToolCalling,
  flattenModels,
  selectTierModels,
  type BenchmarkTable,
  type ModelsDevCatalog,
  type ModelEntry,
  type ScoredModelEntry,
  type TierFloors,
} from "./lib/model-selector.ts";

const TIERS_PATH = `${process.env.HOME}/.config/opencode/model-tiers.json`;
const CACHE_PATH = `${process.env.HOME}/.cache/opencode/model-prices.json`;
const AUTH_PATH = `${process.env.HOME}/.local/share/opencode/auth.json`;
const MODELS_URL = "https://models.dev/api.json";
/** Versioned with the plugin: capability scores for the models.dev catalog. */
const BENCHMARKS_PATH = new URL("./benchmarks.json", import.meta.url);

/**
 * Built-in blacklist applied on machines that have no model-tiers.json yet.
 * Overridable: set a `deny` array (even []) in model-tiers.json to take
 * explicit control. Pattern syntax: exact "provider/model", bare provider
 * "provider", or globs like "provider/*gemini*".
 */
const DEFAULT_DENY = ["google/*gemini*", "google-vertex/*gemini*", "xai/*"];

type TierFile = {
  lite?: string;
  medium?: string;
  heavy?: string;
  deny?: string[];
  liteDeny?: string[];
  heavyDeny?: string[];
  /** Capability floors (0-100). Omitted = derived from the scored cohort. */
  floors?: TierFloors;
};

type Client = PluginInput["client"];

function fullID(entry: ModelEntry): string {
  return `${entry.providerID}/${entry.modelID}`;
}

const hasBun = typeof Bun !== "undefined";

async function writeFile(path: string, content: string) {
  if (hasBun) {
    await Bun.write(path, content);
  } else {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

async function readFile(path: string | URL): Promise<string | undefined> {
  if (hasBun) {
    try {
      return await Bun.file(path).text();
    } catch {
      return undefined;
    }
  }
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function fetchCatalog(): Promise<ModelsDevCatalog> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(MODELS_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
    const json = await res.json();
    await writeFile(CACHE_PATH, JSON.stringify(json));
    return json;
  } catch (err) {
    const cached = await readFile(CACHE_PATH);
    if (cached) return JSON.parse(cached);
    throw err;
  }
}

async function readTiers(): Promise<TierFile> {
  const raw = await readFile(TIERS_PATH);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isManual(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Hand-maintained capability table; absent/corrupt means "fall back to price". */
async function readBenchmarks(): Promise<BenchmarkTable | undefined> {
  const raw = await readFile(BENCHMARKS_PATH);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as BenchmarkTable;
  } catch {
    return undefined;
  }
}

const BENCHMARK_STALE_DAYS = 120;

/** Warn when the hand-maintained table has drifted out of relevance. */
function stalenessWarning(table: BenchmarkTable | undefined): string | undefined {
  if (!table?.updated) return undefined;
  const ageMs = Date.now() - Date.parse(table.updated);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return undefined;
  const days = Math.floor(ageMs / 86_400_000);
  return days >= BENCHMARK_STALE_DAYS
    ? `benchmark table is ${days} days old (updated ${table.updated}); re-check it against models.dev`
        : undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Log-safe gap listing: the full set is long and only the count matters there. */
function describeGaps(gaps: string[], limit = 8): string {
  if (gaps.length === 0) return "";
  const head = gaps.slice(0, limit).join(", ");
  return gaps.length > limit ? `${head}, +${gaps.length - limit} more` : head;
}

/** One-line provenance for a scored pick: why this model, per the table. */
function describeEntry(entry: ScoredModelEntry | undefined, table: BenchmarkTable | undefined): string | undefined {
  if (!entry) return undefined;
  const bits: string[] = [];
  if (typeof entry.capability === "number") bits.push(`score ${round2(entry.capability)}`);
  bits.push(`$${round2(entry.price)}/Mtok`);
  const record = table?.models?.[`${entry.providerID}/${entry.modelID}`];
  const basis = record ? Object.keys(record.scores) : [];
  if (basis.length > 0) bits.push(`basis ${basis.join("+")}`);
  if (entry.released) bits.push(`released ${new Date(entry.released).toISOString().slice(0, 10)}`);
  return bits.join(", ");
}

/**
 * Resolve the list of usable provider IDs.
 *
 * The server endpoint `client.config.providers()` is the most accurate source
 * (it merges auth.json, config and env-var credentials), but it DEADLOCKS when
 * invoked from inside the plugin's `config` hook while the config service is
 * still loading. So we race it against a short timeout and fall back to a local
 * enumeration (auth.json keys + provider sections of the merged config), which
 * covers the same ground without any server round-trip.
 */
async function listAvailableProviders(
  client: Client,
  config: { provider?: Record<string, unknown> } | undefined,
): Promise<{ providers: string[]; source: string }> {
  try {
    const result = await Promise.race([
      client.config.providers(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1200)),
    ]);
    const serverIds = (result?.data?.providers ?? [])
      .map((p: { id: string }) => p.id)
      .filter((id: string) => typeof id === "string" && id.length > 0);
    if (serverIds.length > 0) return { providers: serverIds, source: "server" };
  } catch {
    // fall through to local enumeration
  }

  const ids = new Set<string>();
  try {
    const auth = JSON.parse((await readFile(AUTH_PATH)) ?? "{}");
    for (const key of Object.keys(auth)) {
      if (key && key.length > 0) ids.add(key);
    }
  } catch {
    // auth.json missing or unreadable — not fatal
  }
  for (const key of Object.keys(config?.provider ?? {})) {
    if (key && key.length > 0) ids.add(key);
  }
  return { providers: [...ids], source: "local" };
}

type TierResolution = {
  tiers: { lite?: string; medium?: string; heavy?: string };
  sources: { lite: string; medium: string; heavy: string };
  /** Provenance per tier, e.g. "score 84.29, $0.75/Mtok, basis tb21+deepswe11". */
  detail: { lite?: string; medium?: string; heavy?: string };
  strategy: "capability" | "price";
  floors?: { lite: number; medium: number; heavy: number };
  /** In-scope models the benchmark table never scored (router cannot pick them). */
  gaps: string[];
  /** Scored models pruned as beaten on capability, price and recency at once. */
  dominated: string[];
  warnings: string[];
  providers: string[];
  providerSource: string;
};

async function resolveTiers(
  client: Client,
  config?: { provider?: Record<string, unknown> },
): Promise<TierResolution> {
  const catalog = await fetchCatalog();
  const file = await readTiers();
  const { providers, source: providerSource } = await listAvailableProviders(
    client,
    config,
  );
  const table = await readBenchmarks();
  const entries = filterFree(filterToolCalling(flattenModels(catalog)));
  const chosen = selectTierModels(entries, {
    providers,
    deny: file.deny ?? DEFAULT_DENY,
    liteDeny: file.liteDeny ?? [],
    heavyDeny: file.heavyDeny ?? [],
    benchmarks: table,
    floors: file.floors,
  });

  const pick = (key: "lite" | "medium" | "heavy") => {
    const manual = file[key];
    if (isManual(manual)) return { value: manual, source: "manual" };
    const entry = chosen[key];
    return entry
      ? { value: fullID(entry), source: "auto" }
      : { value: undefined, source: "none" };
  };

  const lite = pick("lite");
  const medium = pick("medium");
  const heavy = pick("heavy");
  const warnings = [...chosen.warnings];
  const stale = stalenessWarning(table);
  if (stale) warnings.push(stale);

  return {
    tiers: { lite: lite.value, medium: medium.value, heavy: heavy.value },
    sources: { lite: lite.source, medium: medium.source, heavy: heavy.source },
    detail: {
      lite: describeEntry(chosen.lite, table),
      medium: describeEntry(chosen.medium, table),
      heavy: describeEntry(chosen.heavy, table),
    },
    strategy: chosen.strategy,
    floors: chosen.floors,
    gaps: chosen.gaps,
    dominated: chosen.dominated,
    warnings,
    providers,
    providerSource,
  };
}

export const ModelRouterPlugin: Plugin = async ({ client }) => {
  const log = async (message: string) => {
    try {
      await client.app.log({
        body: { service: "model-router", level: "info", message },
      });
    } catch {}
  };

  return {
    config: async (config) => {
      try {
        const res = await resolveTiers(client, config);
        const { tiers, sources, detail, strategy, floors } = res;
        for (const [agent, model] of [
          ["worker-lite", tiers.lite],
          ["worker-medium", tiers.medium],
          ["worker-heavy", tiers.heavy],
        ] as const) {
          if (!model) continue;
          config.agent ??= {};
          config.agent[agent] ??= {};
          config.agent[agent].model = model;
        }
        // Only persist the deny lists and floors here: lite/medium/heavy slots
        // are reserved for MANUAL overrides, so auto-selected tiers must never
        // be written back (they would be mistaken for manual pins on the next
        // launch and would bypass the deny lists).
        const file = await readTiers();
        await writeFile(
          TIERS_PATH,
          JSON.stringify(
            {
              lite: "",
              medium: "",
              heavy: "",
              deny: file.deny ?? DEFAULT_DENY,
              liteDeny: file.liteDeny ?? [],
              heavyDeny: file.heavyDeny ?? [],
              ...(file.floors ? { floors: file.floors } : {}),
            },
            null,
            2,
          ),
        );
        const describe = (key: "lite" | "medium" | "heavy") =>
          `${key}=${tiers[key]} (${sources[key]}${detail[key] ? `; ${detail[key]}` : ""})`;
        const gapPreview = describeGaps(res.gaps);
        const dominatedPreview = describeGaps(res.dominated);
        await log(
          `model-router: strategy=${strategy}${floors ? ` floors=${round2(floors.lite)}/${round2(floors.medium)}/${round2(floors.heavy)}` : ""}. ` +
            `${describe("heavy")}, ${describe("medium")}, ${describe("lite")}. ` +
            `Providers (${res.providerSource}): ${res.providers.join(", ")}.` +
            (gapPreview ? ` Unscored in scope (never routed): ${gapPreview}.` : "") +
            (dominatedPreview
              ? ` Dominated in scope (never routed): ${dominatedPreview}.`
              : "") +
            (res.warnings.length > 0 ? ` WARNINGS: ${res.warnings.join(" | ")}` : ""),
        );
      } catch (err) {
        await log(
          `model-router: selection failed, agents left unset: ${(err as Error).message}`,
        );
      }
    },
    tool: {
      list_models: tool({
        description:
          "List currently available provider models and the current worker tier assignments (worker-lite/medium/heavy). Use before dispatching a worker subagent to pick the right tier.",
        args: {},
        async execute() {
          const res = await resolveTiers(client, undefined);
          return JSON.stringify(
            {
              availableProviders: res.providers,
              providerSource: res.providerSource,
              strategy: res.strategy,
              floors: res.floors,
              tiers: res.tiers,
              sources: res.sources,
              detail: res.detail,
              unscoredInScope: res.gaps,
              dominatedInScope: res.dominated,
              warnings: res.warnings,
            },
            null,
            2,
          );
        },
      }),
    },
  };
};
