---
description: OpenRouter Fusion — list configs (models + orchestrator), then ask preset → reasoning effort → temperature, and deliberate (async)
argument-hint: [your question]
---

Drive OpenRouter Fusion **interactively**. Follow these steps **in order**, stopping to **wait for the
user's answer** after each question (don't chain ahead).

**1. List the configs.** Call **`fusion_list`**. Present EVERY preset returned as a **full TABLE** (one
row per preset; columns: **#**, **preset**, **est. cost** `~$low–$high` (from `cost_estimate.low`/`.high`),
**panel**, **judge/orchestrator**, **`reasoning_effort`**). **ALWAYS render this full table at the moment
you ask the user to choose** — even if you showed it earlier, and even when you recommend one: **never
reduce it to just the recommendation**. The cost is an estimated RANGE per run (floor = little web,
ceiling = full `max_tool_calls` web budget); real cost also scales with prompt size (each preset's
`cost_estimate.usd_per_prompt_token`) and reasoning effort. State it's indicative, not a quote.

> `fusion_start` is gated by a permission confirmation in Claude Code (the user approves each paid
> launch). You don't manage it — the harness prompts.

**2. Recommend + ask for the preset.** Mark (⭐) the preset best suited to the request (with its
`cost_tier`), then ask "Which preset (number or name)?" and **WAIT**. Never pick for them. (Skip this
ONLY if the user named the preset **themselves** in the request — you proposing one does not count.)

**3. Ask for the reasoning effort** — `xhigh · high · medium · low · minimal · none`, recalling the
chosen preset's default. Then **WAIT**.

**4. Ask for the temperature** — a number `0–2`, or "model default". Then **WAIT**.

**5. Ask for the question** if it wasn't already provided.

**6. Run.** Call **`fusion_start`** with `preset`, `prompt` (the full question), and
`reasoning_effort` / `temperature` **only if the user chose an explicit value** (otherwise omit them).
Get the `job_id`.

**7. Poll.** Call **`fusion_result`** with that `job_id`; while `{status:"running"}`, call again with
the same `job_id` until the final answer (~45 s long-poll per call).

**8. Return** the synthesized answer **verbatim** (cost footer included), without reformulating.

On error (unknown preset, expired job_id, 401…), explain briefly and don't loop.

Request (may be empty — then ask for it at step 5):
$ARGUMENTS
