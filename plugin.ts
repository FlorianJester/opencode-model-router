import { type Plugin, type PluginInput, tool } from "@opencode-ai/plugin";
import {
  filterFree,
  filterToolCalling,
  flattenModels,
  selectTierModels,
  type ModelsDevCatalog,
  type ModelEntry,
} from "./lib/model-selector.ts";

const TIERS_PATH = `${process.env.HOME}/.config/opencode/model-tiers.json`;
const CACHE_PATH = `${process.env.HOME}/.cache/opencode/model-prices.json`;
const AUTH_PATH = `${process.env.HOME}/.local/share/opencode/auth.json`;
const MODELS_URL = "https://models.dev/api.json";

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

async function readFile(path: string): Promise<string | undefined> {
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

async function resolveTiers(client: Client, config?: { provider?: Record<string, unknown> }): Promise<{
  tiers: { lite?: string; medium?: string; heavy?: string };
  sources: { lite: string; medium: string; heavy: string };
  providers: string[];
  providerSource: string;
}> {
  const catalog = await fetchCatalog();
  const file = await readTiers();
  const { providers, source: providerSource } = await listAvailableProviders(
    client,
    config,
  );
  const entries = filterFree(filterToolCalling(flattenModels(catalog)));
  const chosen = selectTierModels(entries, {
    providers,
    deny: file.deny ?? DEFAULT_DENY,
    liteDeny: file.liteDeny ?? [],
    heavyDeny: file.heavyDeny ?? [],
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

  return {
    tiers: { lite: lite.value, medium: medium.value, heavy: heavy.value },
    sources: { lite: lite.source, medium: medium.source, heavy: heavy.source },
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
        const { tiers, sources, providers, providerSource } = await resolveTiers(
          client,
          config,
        );
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
        // Only persist the deny lists here: lite/medium/heavy slots are
        // reserved for MANUAL overrides, so auto-selected tiers must never be
        // written back (they would be mistaken for manual pins on the next
        // launch and would bypass the deny lists).
        await writeFile(
          TIERS_PATH,
          JSON.stringify(
            {
              lite: "",
              medium: "",
              heavy: "",
              deny: (await readTiers()).deny ?? DEFAULT_DENY,
              liteDeny: (await readTiers()).liteDeny ?? [],
              heavyDeny: (await readTiers()).heavyDeny ?? [],
            },
            null,
            2,
          ),
        );
        await log(
          `model-router: lite=${tiers.lite} (${sources.lite}), medium=${tiers.medium} (${sources.medium}), heavy=${tiers.heavy} (${sources.heavy}). Available providers (${providerSource}): ${providers.join(", ")}`,
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
          const { tiers, sources, providers, providerSource } = await resolveTiers(
            client,
            undefined,
          );
          return JSON.stringify(
            {
              availableProviders: providers,
              providerSource,
              tiers,
              sources,
            },
            null,
            2,
          );
        },
      }),
    },
  };
};