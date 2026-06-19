---
description: OpenRouter Fusion — list configs (models + orchestrator), then ask preset → reasoning effort → temperature, and deliberate (async)
argument-hint: [your question]
---

Drive OpenRouter Fusion **interactively**. Follow these steps **in order**, stopping to **wait for the
user's answer** after each question (don't chain ahead).

**1. List the configs.** Call **`fusion_list`**. Present EVERY preset returned as a readable numbered
list, showing for each: the **name** + label, the **panel of models** (`panel`), the
**orchestrator/judge** (`judge`, the "Fuse with"), and the default `reasoning_effort`. Include all
presets (typically: Quality, Budget, maths, medecine, code, code-eco, perso).

**2. Ask for the preset** (number or name), then **WAIT**. (If the user already named one in the
request, skip this.)

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
