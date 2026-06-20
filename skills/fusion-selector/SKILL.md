---
name: fusion-selector
description: >-
  Interactive selector for OpenRouter Fusion (multi-model deliberation via the openrouter-fusion
  MCP: tools fusion_list / fusion_start / fusion_result). Use this WHENEVER the user wants to run
  Fusion / a multi-model deliberation — "use fusion", "ask fusion", "synthèse avec fusion", "passe
  ça à fusion", etc. — WITHOUT having explicitly named a preset. It lists every config with its
  models + orchestrator, then asks the user to choose the preset, the reasoning effort, and the
  temperature before running. Do NOT auto-pick a preset on the user's behalf.
---

# Fusion selector

When the user wants to use OpenRouter Fusion but has **not** explicitly named a preset, drive this
**interactive** flow. Stop and **wait for the user's answer** after each question — never chain ahead.

1. **List the configs.** Call **`fusion_list`**. Present **every** preset returned as a readable
   numbered list/table, showing for each:
   - the **name** + label,
   - the **panel of models** (`panel` / analysis_models),
   - the **orchestrator / judge** (`judge`, the "Fuse with" model),
   - the default `reasoning_effort`,
   - the **`cost_tier`** (€ / €€ / €€€) so the user picks cost-aware (it's RELATIVE — real cost
     scales with prompt size, reasoning effort and web usage).

   Include all presets (typically: Quality, Budget, maths, medecine, code, code-eco, perso).

2. **Recommend + ask for the preset.** Mark (⭐) the preset best suited to the user's task (with its
   `cost_tier`), then ask the user to choose (number or name) and **WAIT**. Never pick for them — skip
   this only if the user named the preset **themselves** (you proposing one does not count).

3. **Ask for the reasoning effort** — offer `xhigh · high · medium · low · minimal · none`, recalling
   the chosen preset's default. Then **WAIT**.

4. **Ask for the temperature** — a number `0–2`, or "model default". Then **WAIT**.

5. **Ask for the question** if it hasn't been provided yet.

6. **Run.** Call **`fusion_start`** with `preset`, `prompt` (the full question, not summarized), and
   `reasoning_effort` / `temperature` **only if the user chose an explicit value** (otherwise omit
   them so the config/model default applies). Get the `job_id`.

7. **Poll.** Call **`fusion_result`** with that `job_id`; while it returns `{status:"running"}`,
   call it again with the same `job_id` until the final answer (~45 s long-poll per call).

8. **Return** the synthesized answer **verbatim** (including the `Fusion usage —` cost footer), without
   reformulating.

If the user already named a preset, skip step 2 but still confirm reasoning effort + temperature
unless they specified those too. On error (unknown preset, expired job_id, 401…), explain briefly and
don't loop.
