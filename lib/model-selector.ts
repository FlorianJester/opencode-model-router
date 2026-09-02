export type ModelEntry = {
  modelID: string;
  providerID: string;
  price: number;
  toolCall: boolean;
};

type ModelsDevModel = {
  cost?: { input?: number; output?: number };
  tool_call?: boolean;
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
      entries.push({
        modelID,
        providerID,
        price: input + output,
        toolCall: model?.tool_call === true,
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

export function selectTierModels(
  entries: ModelEntry[],
  opts: {
    providers: string[];
    deny?: string[];
    liteDeny: string[];
    heavyDeny?: string[];
  },
): {
  lite?: ModelEntry;
  medium?: ModelEntry;
  heavy?: ModelEntry;
} {
  const candidates = filterFree(filterToolCalling(entries))
    .filter((e) => opts.providers.includes(e.providerID))
    .filter((e) => !matchesDeny(`${e.providerID}/${e.modelID}`, opts.deny))
    .sort((a, b) => a.price - b.price);

  const pick = (deny: string[] | undefined, exclude: Set<string>) =>
    candidates.find(
      (e) =>
        !matchesDeny(`${e.providerID}/${e.modelID}`, deny) &&
        !exclude.has(`${e.providerID}/${e.modelID}`),
    );

  const pickLast = (deny: string[] | undefined, exclude: Set<string>) =>
    [...candidates]
      .reverse()
      .find(
        (e) =>
          !matchesDeny(`${e.providerID}/${e.modelID}`, deny) &&
          !exclude.has(`${e.providerID}/${e.modelID}`),
      );

  const lite = pick(opts.liteDeny, new Set());
  const used = new Set(lite ? [`${lite.providerID}/${lite.modelID}`] : []);
  const heavy = pickLast(opts.heavyDeny ?? [], used);
  if (heavy) used.add(`${heavy.providerID}/${heavy.modelID}`);
  const remaining = candidates.filter(
    (e) => !used.has(`${e.providerID}/${e.modelID}`),
  );
  const medium =
    remaining.length > 0
      ? remaining[Math.floor((remaining.length - 1) / 2)]
      : undefined;

  return { lite, medium, heavy };
}