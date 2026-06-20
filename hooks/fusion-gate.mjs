#!/usr/bin/env node
/**
 * Plugin PreToolUse hook — deterministic cost gate for OpenRouter Fusion.
 *
 * Ships WITH the plugin, so every install gets the same behavior with no settings.json editing:
 * before any `fusion_start` (a PAID multi-model run), Claude Code asks the user to confirm,
 * showing the chosen preset. This is the deterministic backstop to the model-driven selector skill
 * (skills/fusion-selector) — if the model ever skips the list-and-pick step, the launch still can't
 * fire silently.
 *
 * Fail-open: on any error we emit nothing and exit 0 (never break the tool because of the gate).
 */
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw || "{}");
    const ti = input.tool_input || input.toolInput || {};
    const preset = (ti && ti.preset) || "quality";
    const reason =
      `OpenRouter Fusion va lancer une délibération multi-modèles PAYANTE (preset "${preset}"). ` +
      `Confirme pour lancer. Si tu n'as pas choisi ce preset dans la liste fusion_list, refuse et ` +
      `fais d'abord présenter la liste (presets + coût) pour choisir.`;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: reason,
        },
      })
    );
  } catch {
    // fail-open: no decision → default permission flow applies
  }
  process.exit(0);
});
