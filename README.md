# opencode-model-router

An [OpenCode](https://opencode.ai) plugin that auto-selects models for your
`worker-lite` / `worker-medium` / `worker-heavy` subagent tiers from the
[models.dev](https://models.dev) catalog, using **capability scores from coding
benchmarks** rather than price alone.

Price is a terrible proxy for quality: the priciest model in your catalog is
often not the smartest one, and a cheap model can out-score a flagship. So each
tier is assigned by what it is *for*, above a capability floor:

- **lite** → cheapest model that clears the floor, capped at medium's pick
  (freshness breaks price ties)
- **medium** → best capability per dollar above the floor
- **heavy** → strongest model available, newest among equals

Floors default to quantiles of the scored cohort in scope (p25 / p50 / max) and
can be pinned per tier. Tiers are filled strongest-first — heavy reserves the top
model, medium takes the best value left, and lite may then only pick something
**no stronger than medium** — so capability is monotone across tiers (`lite` ≤
`medium` ≤ `heavy`) and a cheap tier can never outrank the workhorse tier. Every
pick is logged with its score, price, benchmark basis and release date.

Two rules keep the result honest rather than merely distinct:

- **Dominated models are pruned before selection.** A model that another one
  beats on *all three* axes at once — at least as capable, no more expensive, and
  no older — is never routed, and is reported as *dominated in scope*. This is
  what stops a tier from silently downgrading to a stale twin (same price, older,
  weaker) or to a pricier model with a lower score.
- **Reuse beats a worse-and-pricier candidate.** If the best unused model that
  clears the floor is no stronger and no cheaper than one already assigned to a
  stronger tier, the tier reuses that model (and warns) instead of paying more
  for less. Tiers only stay distinct when distinctness is worth its price.

Other properties:

- Only considers providers you are authenticated with (`auth.json`, configured
  providers, or env-var credentials), so it never assigns a provider you can't use
- Models the benchmark table does not score are **never** routed; the plugin
  reports them as *unscored in scope* so the table's upkeep list is visible
- Ships with a built-in blacklist for Gemini and Grok models (override any time)
- Falls back to the legacy price ranking when no candidate has a score

## Install

Add the plugin to `~/.config/opencode/opencode.jsonc` next to your other
plugins, exactly like the superpowers entry:

```jsonc
{
  "plugin": [
    "superpowers@git+https://github.com/obra/superpowers.git",
    "opencode-model-router@git+https://github.com/FlorianJester/opencode-model-router.git"
  ]
}
```

Then copy the worker agents (they define the tiers the router assigns models
to) into your OpenCode config:

```bash
cp -r agents/ ~/.config/opencode/
```

Restart OpenCode. The plugin fetches the models.dev catalog (cached for
24h in `~/.cache/opencode/model-prices.json`), picks the tiers, and prints
a summary via `opencode status` / the event log:

```
model-router: strategy=capability floors=74.08/76.26/84.29. heavy=opencode-go/deepseek-v4.1-flash (auto; score 84.29, $0.75/Mtok, basis tb21+deepswe11, released 2026-09-10), medium=opencode-go/muse-spark-1.3-contributor (auto; score 83.65, $0.3/Mtok, basis tb21+deepswe11, released 2026-09-02), lite=opencode-go/muse-spark-1.3-contributor (auto; score 83.65, $0.3/Mtok, basis tb21+deepswe11, released 2026-09-02). Providers (server): opencode-go. Dominated in scope (never routed): opencode-go/muse-spark-1.2-contributor, opencode-go/qwen3.8-flash, opencode-go/glm-5.3-flash, opencode-go/glm-5.2, opencode-go/glm-5.3, opencode-go/qwen3.8-max, opencode-go/kimi-k3. WARNINGS: lite: reuses opencode-go/muse-spark-1.3-contributor (every model clearing floor 74.08 under ceiling 83.65 is already assigned)
```

A matching `model-tiers.json` is created automatically on first run; a
template is included in this repo.

## Configuration: `~/.config/opencode/model-tiers.json`

```json
{
  "lite": "",
  "medium": "",
  "heavy": "",
  "deny": ["google/*gemini*", "google-vertex/*gemini*", "xai/*"],
  "liteDeny": [],
  "heavyDeny": [],
  "floors": { "lite": 74, "medium": 76, "heavy": 84 }
}
```

| Field      | Meaning                                                                 |
|------------|-------------------------------------------------------------------------|
| `lite` / `medium` / `heavy`  | Manual model pins like `"provider/model"`. **Empty = auto-select.** Leave empty unless you want to pin. |
| `deny`     | Global blacklist, applied to **all** tiers (lite, medium, heavy). |
| `liteDeny` | Blacklist applied only to the lite pick. |
| `heavyDeny`| Blacklist applied only to the heavy pick. |
| `floors`   | Optional capability floors (`0-100`) gating each tier's eligibility. Omit the key to derive them from the scored cohort. |

Deny patterns can be:

- an exact model: `"opencode-go/glm-5.3-flash"`
- a whole provider: `"xai"`
- a glob: `"google-vertex/*gemini*"`

Set `"deny": []` to explicitly disable the built-in blacklist.

## Benchmarks: `benchmarks.json`

The plugin ships the capability table it scores candidates with. It is
hand-maintained because benchmark results are not machine-readable from a
single trustworthy source.

```jsonc
{
  "version": 1,
  "updated": "2026-09-21",          // drives a staleness warning after 120 days
  "minFamilies": 2,                 // evidence threshold: at least 2 benchmarks
  "core": ["terminalBench", "deepswe"],  // families a model MUST have scores for
  "families": {
    "terminalBench": { "weight": 40, "members": ["tb21"] },
    "deepswe": { "weight": 25, "members": ["deepswe11"] },
    "livecodebench": { "weight": 15, "members": ["lcb"] },
    "swePro": { "weight": 10, "members": ["swePro"] },
    "frontierSwe": { "weight": 10, "members": ["frontierSwe"] }
  },
  "models": {
    "opencode-go/deepseek-v4.1-flash": {
      "source": "vendor + terminal-bench leaderboard",
      "scores": { "tb21": 90.6, "deepswe11": 74.2 }
    }
  }
}
```

Rules the table enforces:

- A model's score is the weight-weighted mean of the families it has scores
  for, normalised to 0-100.
- It needs scores in at least `minFamilies` families **and** in every family
  listed in `core`, otherwise it stays unscored (and unroutable).
- `members` lists the concrete benchmark versions whose numbers are in play
  (`tb21` = Terminal-Bench 2.1, `deepswe11` = DeepSWE 1.1, …). Versions not in
  `members` are ignored, so a table can keep outdated numbers around without
  them influencing selection.
- Every scored family should be a *software-engineering* benchmark: agentic
  terminal work, SWE-bench-style issue resolution, competitive coding.
  General-chat or "vibe" leaderboards are noise here.

Upkeep: when a new model appears, add its scores; when a benchmark version
supersedes another, move the `members` entry. Models you leave out are reported
in the plugin log and by `list_models`, which is exactly the point - an
evidence-free model is never silently routed.

## Tools

The plugin also exposes a `list_models` tool: call it before dispatching a
worker subagent to see your current tier assignments, why each was picked
(score, price, benchmark basis, release date), which floors were applied, and
which in-scope models the table does not score or has pruned as dominated.

## Development

```bash
node --experimental-strip-types --test lib/model-selector.test.ts
```
