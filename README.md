# opencode-model-router

An [OpenCode](https://opencode.ai) plugin that auto-selects models for your
`worker-lite` / `worker-medium` / `worker-heavy` subagent tiers from the
[models.dev](https://models.dev) catalog:

- **lite** → cheapest tool-calling, paid model among your available providers
- **medium** → median-priced model of the rest
- **heavy** → most expensive model
- Only considers providers you are authenticated with (`auth.json`, configured
  providers, or env-var credentials), so it never assigns a provider you can't use
- Ships with a built-in blacklist for Gemini and Grok models (override any time)

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
model-router: lite=opencode-go/muse-spark-1.2-contributor (auto), medium=opencode-go/mimo-v2-omni (auto), heavy=opencode-go/kimi-k3 (auto). Available providers (local): opencode-go
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
  "heavyDeny": []
}
```

| Field      | Meaning                                                                 |
|------------|-------------------------------------------------------------------------|
| `lite` / `medium` / `heavy`  | Manual model pins like `"provider/model"`. **Empty = auto-select.** Leave empty unless you want to pin. |
| `deny`     | Global blacklist, applied to **all** tiers (lite, medium, heavy). |
| `liteDeny` | Blacklist applied only to the lite pick. |
| `heavyDeny`| Blacklist applied only to the heavy pick. |

Deny patterns can be:

- an exact model: `"opencode-go/glm-5.3-flash"`
- a whole provider: `"xai"`
- a glob: `"google-vertex/*gemini*"`

Set `"deny": []` to explicitly disable the built-in blacklist.

## Tools

The plugin also exposes a `list_models` tool: call it before dispatching a
worker subagent to see your current tier assignments and available providers.

## Development

```bash
node --experimental-strip-types --test lib/model-selector.test.ts
```