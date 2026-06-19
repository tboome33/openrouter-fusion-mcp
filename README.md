# OpenRouter Fusion — MCP server

A tiny [MCP](https://modelcontextprotocol.io) server that exposes **OpenRouter Fusion**
(multi-model deliberation) to any MCP client (MCPHub, Claude Desktop, Claude Code, …) when you
need a *very* good answer.

> **What is Fusion?** It turns your prompt into a small multi-model deliberation: a panel of
> models answers in parallel (with web search/fetch), then a *judge* ("Fuse with") model
> synthesizes consensus, contradictions, unique insights and blind spots into one final answer.
> It beats any single model on hard questions — at roughly **4–5× the cost** of a single completion.
> Docs: <https://openrouter.ai/docs/guides/features/plugins/fusion> · model page: <https://openrouter.ai/openrouter/fusion>

## Tools (v2 — async only)

| Tool | Role |
|------|------|
| `fusion_list` | List the available configs (name, label, panel, judge, reasoning_effort, temperature). |
| `fusion_start` | Start a deliberation in the **background** and return a `job_id` immediately (never times out). |
| `fusion_result` | Long-poll a `job_id` (~45 s/call) → the synthesized answer, or `{status:"running"}` to retry. |

The old synchronous wrappers (`fusion_quality` / `fusion_ultra` / `fusion_perso`) were removed —
sync calls were cut by client/proxy timeouts. Everything goes through `fusion_start` + `fusion_result`.

```
fusion_start({ prompt, preset:"quality" }) → { job_id }
fusion_result({ job_id }) → answer   (re-call while {status:"running"})
```

`fusion_start` forces the deliberation pipeline (`tool_choice:"required"`). Per-call overrides:
`preset`, `reasoning_effort`, `temperature`, `analysis_models`, `judge_model`, `system`.

## Configs (Quality / Budget / Custom)

Mirrors OpenRouter's "Model Fusion" UI tabs. Two are **built-in** in `server.mjs`; the rest are
**named custom configs**, one per environment variable.

| Config | Source | Panel | Judge | Reasoning |
|--------|--------|-------|-------|-----------|
| `quality` | built-in | Opus 4.8 + GPT-5.5 + Gemini 3.1 Pro | Opus 4.8 | high |
| `budget` | built-in | **chosen by OpenRouter** (`general-budget`) | OpenRouter | medium |
| `maths`, `medecine`, `code`, `code-eco`, `perso` | env var | see `fusion-presets.json` | — | high |

Each config carries `analysis_models` (panel) · `judge` (orchestrator) · `reasoning_effort`
(`xhigh`\|`high`\|`medium`\|`low`\|`minimal`\|`none`, default `high`) · `temperature` (`null` =
model default, or `0–2`) · optional `system`.

### Configuring — one env var per config

The server scans every `OPENROUTER_FUSION_<NAME>` env var and registers it as a config named
`<name>` (lowercased; override with a `name` field — e.g. `code-eco`). The value is the JSON
object `{...}`; the parser also tolerates a `"name":{...}` fragment or a `{"name":{...}}` wrapper.

```
OPENROUTER_FUSION_MATHS    = {"name":"maths","analysis_models":[...],"judge":"...","reasoning_effort":"high","temperature":null,"system":"..."}
OPENROUTER_FUSION_CODE     = {...}
OPENROUTER_FUSION_PERSO    = {...}
```

- `fusion-presets.json` — canonical, documented copy of all configs.
- `fusion-env-vars.json` — the exact compact values to paste into the mcphub env (one per config).
- Extra vars: `OPENROUTER_API_KEY` (an **inference** key with credit), `OPENROUTER_FUSION_DEFAULT_REASONING`.
- Legacy `OPENROUTER_FUSION_PRESETS` (single map) and `OPENROUTER_FUSION_PERSO_CONFIG` are still read for backward-compat.

Diagnostic: `FUSION_DUMP_PRESETS=1 node server.mjs` prints the resolved configs and exits.

## Install

```bash
npm install
```

No build step — plain ESM (`node server.mjs`). Requires Node ≥ 18 (global `fetch`).

Set your key via the client's `env`, or copy `.env.example` → `.env`:

```
OPENROUTER_API_KEY=sk-or-...
```

## Use with MCPHub

Add a **stdio** server pointing at the absolute path of `server.mjs`:

```json
{
  "name": "openrouter-fusion",
  "config": {
    "type": "stdio",
    "command": "node",
    "args": ["/absolute/path/to/openrouter-fusion/server.mjs"],
    "env": {
      "OPENROUTER_API_KEY": "sk-or-xxxxxxxxxxxxxxxx",
      "OPENROUTER_FUSION_MATHS": "{...}",
      "OPENROUTER_FUSION_CODE": "{...}"
    }
  }
}
```

> If `node` isn't on the launching process's PATH, replace `"node"` with an absolute path.

## Use with Claude Code / Claude Desktop

Two ways, depending on whether you also want the interactive selector UX.

### A) MCP server only

```bash
claude mcp add openrouter-fusion -e OPENROUTER_API_KEY=sk-or-... -- npx -y github:tboome33/openrouter-fusion-mcp
```

You get the 3 tools. The **interactive selector behavior travels with the server via the tool
descriptions** — when you ask to use Fusion without naming a preset, the model is told to call
`fusion_list` and ask you to choose preset → reasoning effort → temperature (it should not auto-pick).
This is the only layer that also works on claude.ai / Cursor / other MCP clients.

### B) As a Claude Code plugin (MCP **+** skill **+** `/fusion` command)

This repo is also a Claude Code **plugin** (`.claude-plugin/plugin.json`). Installing it bundles the
MCP server (`.mcp.json`, run via npx), a model-invoked **skill** (`skills/fusion-selector`) that
auto-triggers the selector whenever you want Fusion, and an explicit **`/fusion`** slash command.

```
/plugin marketplace add tboome33/openrouter-fusion-mcp
/plugin install openrouter-fusion@tboome33
```

Set `OPENROUTER_API_KEY` in your environment first (the plugin's `.mcp.json` reads `${OPENROUTER_API_KEY}`).

> Why a plugin? Slash commands and skills do **not** travel with a plain MCP install (only tool
> descriptions do). A plugin is what bundles the MCP server together with its command/skill so a
> user gets the full interactive UX in one install.

## Optional — package as a one-click `.mcpb` bundle

```bash
npx @anthropic-ai/mcpb pack
```

The bundle prompts the user for their OpenRouter API key on install (`user_config`).

## Examples

```jsonc
// start a quality deliberation
{ "prompt": "Explain the trade-offs between ridge, lasso and elastic net.", "preset": "quality" }

// a custom config with a per-call reasoning override
{ "prompt": "Review this clinical case and list differential diagnoses.", "preset": "medecine", "reasoning_effort": "xhigh" }
```

## Notes

- Model slugs use OpenRouter syntax — pick valid slugs from <https://openrouter.ai/models>.
- Fusion is billed per the panel + judge it runs — `quality` (~$0.09 on a trivial probe) costs
  more than `budget` (~$0.04). Keep the heavy configs for the cases that justify them.
- A tool-set change only shows client-side after the connector reconnects (cached manifest); calls still hit the live server.
- Jobs live in memory only. If the server process restarts, in-flight `job_id`s become `Unknown` — just call `fusion_start` again. Finished jobs are pruned after ~30 min (and on a background timer).
