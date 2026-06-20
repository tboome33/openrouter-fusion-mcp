#!/usr/bin/env node
/**
 * OpenRouter Fusion — MCP server
 *
 * Calls OpenRouter's Fusion (multi-model deliberation): a panel of models runs in
 * parallel (with web search/fetch), then a judge ("Fuse with" / orchestrator) model
 * synthesizes consensus / contradictions / unique insights / blind spots into one answer.
 *
 * THREE families of configs (mirrors the OpenRouter "Model Fusion" UI):
 *   - quality : built-in frontier panel (Claude Opus + GPT + Gemini Pro), judge Opus.
 *   - budget  : built-in — panel CHOSEN BY OPENROUTER (native preset "general-budget").
 *   - <named> : any number of custom configs, one ENV VAR each:
 *                 OPENROUTER_FUSION_<NAME> = {"label":..,"analysis_models":[..],"judge":..,
 *                                            "reasoning_effort":"high","temperature":0.7,"system":..}
 *               e.g. OPENROUTER_FUSION_MATHS, OPENROUTER_FUSION_MEDECINE, OPENROUTER_FUSION_CODE...
 *
 * Each config carries: analysis_models (panel) · judge (orchestrator / "Fuse with") ·
 * reasoning_effort (xhigh|high|medium|low|minimal|none, default high) · temperature
 * (optional — omitted = model default) · system (optional domain prompt).
 *
 * Tools (async-only, robust against client/proxy timeouts):
 *   - fusion_list   : enumerate configs (name, panel, judge, reasoning, temperature).
 *   - fusion_start  : start a deliberation in the background → job_id (never times out).
 *   - fusion_result : long-poll a job_id (~45s/call) → synthesized answer.
 *
 * Docs: https://openrouter.ai/docs/guides/features/plugins/fusion
 *       https://openrouter.ai/openrouter/fusion
 *
 * Auth: set OPENROUTER_API_KEY (an INFERENCE key with credit) in the environment.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const API_KEY = process.env.OPENROUTER_API_KEY;

// Default reasoning effort when a config doesn't specify one (overridable per call).
const DEFAULT_REASONING = (process.env.OPENROUTER_FUSION_DEFAULT_REASONING || "high")
  .trim()
  .toLowerCase();

// Built-in "quality" panel — explicit so fusion_list can display models + judge.
const QUALITY_PANEL = ["anthropic/claude-opus-4.8", "openai/gpt-5.5", "google/gemini-3.1-pro-preview"];
const QUALITY_JUDGE = "anthropic/claude-opus-4.8";

// Cap on the panel/judge web_search/web_fetch loop (OpenRouter range 1-16, their default 8).
// We default LOWER (3): it bounds web steps so models "must return text", which both cuts cost and
// avoids the failure where the judge keeps tool-calling and never emits a final synthesis.
const DEFAULT_MAX_TOOL_CALLS = (() => {
  const n = parseInt(process.env.OPENROUTER_FUSION_MAX_TOOL_CALLS || "", 10);
  return Number.isFinite(n) && n >= 1 && n <= 16 ? n : 3;
})();

const REASONING_LEVELS = ["xhigh", "high", "medium", "low", "minimal", "none"];

// --- reasoning helpers -------------------------------------------------------
function normReasoning(v) {
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  return s || undefined;
}
const REASONING_SET = new Set(REASONING_LEVELS);
/** Map a reasoning-effort level to the OpenRouter `reasoning` body object. */
function reasoningBody(effort) {
  let s = normReasoning(effort);
  if (!s) return undefined;
  if (!REASONING_SET.has(s)) {
    // A typo'd level in a config env var would otherwise be sent verbatim and trigger an
    // opaque provider error. Fall back to the default instead.
    const fallback = REASONING_SET.has(DEFAULT_REASONING) ? DEFAULT_REASONING : "high";
    console.error(`Unknown reasoning_effort "${s}" — falling back to "${fallback}".`);
    s = fallback;
  }
  if (s === "none") return { enabled: false }; // disable reasoning entirely
  return { effort: s }; // xhigh|high|medium|low|minimal — passed through to OpenRouter
}

// --- Preset registry: built-ins + named custom configs (one env var each) ----
//
// A custom config is an env var OPENROUTER_FUSION_<NAME> whose value is a JSON object:
//   {"label":"…","description":"…","analysis_models":["…","…"],"judge":"…",
//    "reasoning_effort":"high","temperature":0.7,"system":"…"}
// The preset name is the <NAME> suffix lowercased (override with an explicit "name" field).
// For forgiveness, the value may also be the bare fragment  "<name>":{…}  or a single-key
// wrapper  {"<name>":{…}}  — both are unwrapped automatically.
function normalizePreset(c, fallbackName) {
  if (!c || typeof c !== "object") return null;
  let analysis_models = Array.isArray(c.analysis_models) ? c.analysis_models : undefined;
  let judge = c.judge || c.judge_model;
  const orchestrator = c.orchestrator || undefined;
  let openrouter_preset = c.openrouter_preset || c.preset || undefined;
  let max_tool_calls = c.max_tool_calls;
  if (Array.isArray(c.tools)) {
    // Accept the OpenRouter docs shape (model/tools/parameters) too.
    const t = c.tools.find((x) => String(x?.type || "").includes("fusion"));
    const p = t?.parameters || {};
    if (!analysis_models && Array.isArray(p.analysis_models)) analysis_models = p.analysis_models;
    if (p.model) judge = judge || p.model;
    if (p.preset) openrouter_preset = openrouter_preset || p.preset;
    if (max_tool_calls == null && p.max_tool_calls != null) max_tool_calls = p.max_tool_calls;
  }
  judge = judge || c.model;
  return {
    name: c.name || fallbackName || null,
    label: c.label || null,
    description: c.description || null,
    analysis_models: analysis_models?.length ? analysis_models : null,
    judge: judge || null,
    orchestrator: orchestrator || null,
    openrouter_preset: openrouter_preset || null,
    reasoning_effort: normReasoning(c.reasoning_effort) || null,
    temperature: typeof c.temperature === "number" ? c.temperature : null,
    max_tool_calls:
      Number.isFinite(max_tool_calls) && max_tool_calls >= 1 && max_tool_calls <= 16
        ? max_tool_calls
        : null,
    system: c.system || null,
  };
}

/** Parse one env value into a config object, tolerating common paste shapes. */
function parseConfigValue(key, val) {
  let parsed;
  try {
    parsed = JSON.parse(val);
  } catch {
    // tolerate a trailing comma and the bare  "name":{…}  fragment the UI invites pasting
    try {
      parsed = JSON.parse("{" + val.replace(/,\s*$/, "") + "}");
    } catch {
      console.error(`${key} is not valid JSON — ignoring it.`);
      return null;
    }
  }
  let name = key.replace(/^OPENROUTER_FUSION_/i, "").toLowerCase();
  let cfg = parsed;
  // Unwrap a single-key wrapper {"<configname>":{…}} where the inner value is the real config.
  // Discriminator: a single key whose value is itself a PLAIN OBJECT means a wrapper — unwrap it.
  // A flat config's only field is always a scalar or array (reasoning_effort:"low",
  // judge:"x", analysis_models:[…], temperature:0.2, …), never a plain object, so it is left
  // as-is. This handles tuning-only inner configs AND configs whose name matches a field word.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed);
    if (keys.length === 1) {
      const inner = parsed[keys[0]];
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        name = inner.name || keys[0].toLowerCase();
        cfg = inner;
      }
    }
  }
  const np = normalizePreset(cfg, name);
  if (np && !np.reasoning_effort) np.reasoning_effort = DEFAULT_REASONING;
  return np;
}

function buildPresets() {
  /** @type {Record<string, any>} */
  const presets = {};

  // Built-in: Quality (frontier panel, judge Opus) — like the UI "Quality" tab.
  presets.quality = {
    name: "quality",
    label: "Quality",
    description:
      "Panel frontier (Claude Opus + GPT + Gemini Pro), juge Opus. Comme l'onglet Quality d'OpenRouter.",
    analysis_models: QUALITY_PANEL,
    judge: QUALITY_JUDGE,
    orchestrator: null,
    openrouter_preset: null,
    reasoning_effort: DEFAULT_REASONING,
    temperature: null,
    system: null,
  };

  // Built-in: Budget (panel CHOSEN BY OPENROUTER via native preset) — like the UI "Budget" tab.
  presets.budget = {
    name: "budget",
    label: "Budget",
    description:
      "Panel économique CHOISI PAR OPENROUTER (preset natif general-budget). Comme l'onglet Budget.",
    analysis_models: null,
    judge: null,
    orchestrator: null,
    openrouter_preset: "general-budget",
    reasoning_effort: "medium",
    temperature: null,
    system: null,
  };

  // Named custom configs — one env var each: OPENROUTER_FUSION_<NAME>.
  const RESERVED = new Set([
    "OPENROUTER_FUSION_PRESETS",
    "OPENROUTER_FUSION_PERSO_CONFIG",
    "OPENROUTER_FUSION_PERSO_PANEL",
    "OPENROUTER_FUSION_PERSO_JUDGE",
    "OPENROUTER_FUSION_PERSO_ORCHESTRATOR",
    "OPENROUTER_FUSION_DEFAULT_REASONING",
  ]);
  for (const [key, val] of Object.entries(process.env)) {
    if (!/^OPENROUTER_FUSION_/i.test(key)) continue;
    if (RESERVED.has(key.toUpperCase())) continue;
    if (!val || !val.trim()) continue;
    const np = parseConfigValue(key, val);
    if (!np) continue;
    const finalName = np.name || key.replace(/^OPENROUTER_FUSION_/i, "").toLowerCase();
    if (presets[finalName]) {
      console.error(`Fusion config "${finalName}" (from ${key}) overrides an existing config of the same name.`);
    }
    presets[finalName] = np;
  }

  // Backward-compat: the legacy single-map OPENROUTER_FUSION_PRESETS.
  const rawMap = process.env.OPENROUTER_FUSION_PRESETS;
  if (rawMap) {
    try {
      const m = JSON.parse(rawMap);
      for (const [n, c] of Object.entries(m)) {
        const np = normalizePreset(c, n);
        if (np) {
          if (!np.reasoning_effort) np.reasoning_effort = DEFAULT_REASONING;
          presets[n] = np;
        }
      }
    } catch {
      console.error("OPENROUTER_FUSION_PRESETS is not valid JSON — ignoring it.");
    }
  }

  // Backward-compat: legacy perso config → preset "perso" (if not already defined).
  if (!presets.perso && process.env.OPENROUTER_FUSION_PERSO_CONFIG) {
    const np = parseConfigValue("OPENROUTER_FUSION_PERSO", process.env.OPENROUTER_FUSION_PERSO_CONFIG);
    if (np) {
      np.name = "perso";
      np.label = np.label || "Perso";
      presets.perso = np;
    }
  }

  return presets;
}
const PRESETS = buildPresets();

/**
 * Call OpenRouter Fusion and return the synthesized final answer as text.
 *
 * @param {object} opts
 * @param {string}    opts.prompt            The user question.
 * @param {string=}   opts.system            Optional system prompt.
 * @param {number=}   opts.temperature       Optional sampling temperature (omit = model default).
 * @param {string[]=} opts.analysis_models   Custom panel (Fusion plugin).
 * @param {string=}   opts.judge_model       Custom judge / orchestrator ("Fuse with") model.
 * @param {string=}   opts.orchestrator      Outer model (server-tool form). Usually null.
 * @param {string=}   opts.reasoning_effort  xhigh|high|medium|low|minimal|none.
 * @param {string=}   opts.openrouter_preset Native OpenRouter fusion preset (e.g. general-budget).
 * @param {number=}   opts.max_tool_calls    Cap the panel/judge web loop (1-16). Default DEFAULT_MAX_TOOL_CALLS.
 * @returns {Promise<string>}
 */
async function callFusion({
  prompt,
  system,
  temperature,
  analysis_models,
  judge_model,
  orchestrator,
  reasoning_effort,
  openrouter_preset,
  max_tool_calls,
}) {
  if (!API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Add an inference key (with credit) to the MCP server environment before calling Fusion."
    );
  }

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  /** @type {Record<string, unknown>} */
  const body = { messages };
  if (typeof temperature === "number") body.temperature = temperature;
  const reasoning = reasoningBody(reasoning_effort);
  if (reasoning) body.reasoning = reasoning;
  const maxToolCalls =
    Number.isFinite(max_tool_calls) && max_tool_calls >= 1 && max_tool_calls <= 16
      ? max_tool_calls
      : DEFAULT_MAX_TOOL_CALLS;

  if (orchestrator) {
    // Server-tool form: a custom outer model writes the final answer using fusion analysis.
    body.model = orchestrator;
    const params = { max_tool_calls: maxToolCalls };
    if (analysis_models && analysis_models.length) params.analysis_models = analysis_models;
    if (judge_model) params.model = judge_model;
    if (openrouter_preset) params.preset = openrouter_preset;
    body.tools = [{ type: "openrouter:fusion", parameters: params }];
    body.tool_choice = "required"; // the orchestrator must actually invoke the fusion tool
  } else {
    // Alias form: openrouter/fusion resolves an outer model; the judge synthesizes.
    // IMPORTANT: do NOT set tool_choice:"required" here. It forces the outer model to emit a tool
    // call (web_search) instead of the final text synthesis → content:null, a wasted paid run.
    // Empirically verified 2026-06-19 (required → no text; no tool_choice + low max_tool_calls → text).
    body.model = "openrouter/fusion";
    const fusion = { id: "fusion", max_tool_calls: maxToolCalls };
    if (analysis_models && analysis_models.length) fusion.analysis_models = analysis_models;
    if (judge_model) fusion.model = judge_model;
    if (openrouter_preset) fusion.preset = openrouter_preset;
    body.plugins = [fusion];
  }

  // One request attempt. Throws { retryable, msg } so the loop can retry transient 429/5xx.
  const attemptOnce = async () => {
    let res;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://github.com/mcphub",
          "X-Title": process.env.OPENROUTER_SITE_NAME || "OpenRouter Fusion MCP",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw { retryable: true, msg: `Network error contacting OpenRouter: ${e?.message || e}` };
    }
    const raw = await res.text();
    if (!res.ok) {
      throw {
        retryable: res.status === 429 || res.status >= 500,
        msg: `OpenRouter returned ${res.status} ${res.statusText}: ${raw.slice(0, 600)}`,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw { retryable: false, msg: `Could not parse OpenRouter response as JSON: ${raw.slice(0, 2000)}` };
    }
    // HTTP 200 can still embed an error (panel/judge model rate-limited, etc.).
    const embErr = parsed?.error || parsed?.choices?.[0]?.error;
    if (embErr) {
      const code = embErr.code;
      const etype = embErr.metadata?.error_type || "";
      const mdl = parsed?.model || "";
      const retryable =
        code === 429 || etype === "rate_limit_exceeded" || (typeof code === "number" && code >= 500);
      throw {
        retryable,
        msg: `Fusion provider error ${code}${etype ? " " + etype : ""}${mdl ? " on " + mdl : ""}: ${
          embErr.message || ""
        }`.trim(),
      };
    }
    return parsed;
  };

  let data;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      data = await attemptOnce();
      break;
    } catch (err) {
      const e =
        err && typeof err === "object" && "msg" in err
          ? err
          : { retryable: false, msg: String(err?.message || err) };
      if (e.retryable && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, attempt * 4000)); // 4s, then 8s backoff
        continue;
      }
      throw new Error(e.msg);
    }
  }

  const choice = data?.choices?.[0]?.message;
  let answer = "";
  if (typeof choice?.content === "string") {
    answer = choice.content;
  } else if (Array.isArray(choice?.content)) {
    answer = choice.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  }
  if (!answer.trim()) {
    // No final text — the outer/judge model ended on a tool call (e.g. web_search) instead of a
    // synthesis. Surface a clear, typed error rather than dumping raw JSON the caller can't use.
    const fr = data?.choices?.[0]?.finish_reason || "unknown";
    const toolCall = (choice?.tool_calls && choice.tool_calls.length) || choice?.function_call;
    throw new Error(
      `Fusion returned no final text (finish_reason=${fr}${toolCall ? ", ended on a tool call" : ""}). ` +
        `This is the 'judge emitted a web_search tool call instead of synthesizing' failure. ` +
        `The server no longer forces tool_choice and caps max_tool_calls=${maxToolCalls}; ` +
        `if it recurs, lower OPENROUTER_FUSION_MAX_TOOL_CALLS (or the preset's max_tool_calls) and retry.`
    );
  }

  // Compact usage/cost footer when available.
  const u = data?.usage;
  if (u) {
    const parts = [];
    if (u.prompt_tokens != null) parts.push(`in ${u.prompt_tokens}`);
    if (u.completion_tokens != null) parts.push(`out ${u.completion_tokens}`);
    if (u.total_tokens != null) parts.push(`total ${u.total_tokens}`);
    if (u.cost != null) parts.push(`$${u.cost}`);
    if (parts.length) answer += `\n\n---\n_Fusion usage — ${parts.join(" · ")}_`;
  }

  return answer;
}

const server = new McpServer({
  name: "openrouter-fusion",
  version: "2.0.0",
});

// ---------------------------------------------------------------------------
// fusion_list — enumerate configs so the caller (or user) can pick one.
// ---------------------------------------------------------------------------
server.registerTool(
  "fusion_list",
  {
    title: "Fusion (list configs)",
    description:
      "List the available Fusion configurations — for each: name, label, panel (analysis_models), " +
      "judge (orchestrator/'Fuse with'), reasoning_effort, temperature, cost_tier, description. ALWAYS " +
      "call this FIRST whenever the user wants to use Fusion without explicitly naming a preset himself " +
      "(you proposing one does NOT count). Present EVERY preset WITH its models, its orchestrator and its " +
      "cost_tier; RECOMMEND the one best suited to the task (mark it ⭐) — but do NOT pick for them: ask " +
      "the user to choose. After they pick, ask the reasoning effort, then the temperature, then call " +
      "fusion_start with preset:'<name>'.",
    inputSchema: {},
  },
  async () => {
    // Rough RELATIVE cost tier from panel composition (a precise $ would mislead — real cost
    // scales with prompt size, reasoning effort and web usage). Frontier slugs = pricey.
    // Heuristic, perishable list of "pricey/frontier" slug fragments — update when the panel
    // evolves (a future gpt-6 / claude-opus-5 won't match → counted as cheap).
    // `gemini[-\d.]*pro` matches both `gemini-pro` AND versioned `gemini-3.1-pro-preview`
    // (but not the cheap `gemini-3.5-flash`).
    const isFrontier = (m) => /opus|gpt-5|gemini[-\d.]*pro|grok|\bo3\b|sonnet/i.test(m || "");
    const costTier = (p) => {
      if (p.openrouter_preset) return "€ (éco · choisi par OpenRouter)";
      const models = [...(p.analysis_models || []), p.judge].filter(Boolean);
      const n = models.filter(isFrontier).length;
      if (n === 0) return "€ (éco)";
      if (n <= 2) return "€€ (moyen)";
      return "€€€ (cher)";
    };
    const list = Object.entries(PRESETS).map(([name, p]) => ({
      preset: name,
      label: p.label || name,
      description: p.description || "",
      panel: p.analysis_models || (p.openrouter_preset ? `(choisi par OpenRouter: ${p.openrouter_preset})` : "(défaut Quality OpenRouter)"),
      judge: p.judge || (p.openrouter_preset ? "(choisi par OpenRouter)" : "(défaut)"),
      orchestrator: p.orchestrator || null,
      reasoning_effort: p.reasoning_effort || DEFAULT_REASONING,
      temperature: p.temperature == null ? "(défaut modèle)" : p.temperature,
      max_tool_calls: p.max_tool_calls == null ? DEFAULT_MAX_TOOL_CALLS : p.max_tool_calls,
      cost_tier: costTier(p),
    }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              presets: list,
              usage:
                "Présente la liste AVEC le cost_tier, RECOMMANDE le preset le plus adapté à la tâche (⭐), " +
                "fais CHOISIR le preset à l'utilisateur → reasoning → température, puis lance fusion_start " +
                "puis poll fusion_result. Ne lance JAMAIS direct sans avoir fait choisir (sauf si " +
                "l'utilisateur a lui-même nommé le preset). cost_tier = indicateur RELATIF (€/€€/€€€) ; le " +
                "coût réel monte avec la taille du prompt, le reasoning et l'usage web (un run lourd peut " +
                "dépasser 0,50–1 $).",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Async job pattern — survives short CLIENT-side / proxy tool-call timeouts.
// Fusion takes minutes; many MCP clients (and proxies that don't forward
// progress) cut the request at ~60s. So we run the deliberation in the
// background and let the caller poll: fusion_start -> job_id, fusion_result -> answer.
// ---------------------------------------------------------------------------
const jobs = new Map(); // id -> { status:'running'|'done'|'error', result?, error?, ts }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let jobSeq = 0;
function newJobId() {
  jobSeq = (jobSeq + 1) % 1e6;
  return "fj_" + jobSeq.toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
function pruneJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.status === "running") continue; // never expire an in-flight job, even if it runs long
    if (now - j.ts > 1800000) jobs.delete(id); // drop finished/errored jobs 30 min after completion
  }
}
// Prune on a timer too, so a finished-but-never-polled job (client gave up) can't linger
// until the next fusion_start. unref() keeps the timer from holding the process open.
setInterval(pruneJobs, 600000).unref();

server.registerTool(
  "fusion_start",
  {
    title: "Fusion (start async)",
    description:
      "Start an OpenRouter Fusion deliberation in the BACKGROUND and return a job_id immediately " +
      "(never times out), then call fusion_result with the job_id. Set preset:'<name>'. IMPORTANT: do " +
      "NOT auto-pick a preset on the user's behalf — if the user hasn't explicitly named one, call " +
      "fusion_list first, show the presets (with models + orchestrator), and ask them to choose the " +
      "preset, then the reasoning effort, then the temperature. (preset falls back to 'quality' only as " +
      "a last-resort server default.) reasoning_effort and temperature default to the config's; pass " +
      "them only when the user chose an explicit value.",
    inputSchema: {
      prompt: z.string().describe("The question or task to deliberate on."),
      preset: z
        .string()
        .optional()
        .describe("Config name from fusion_list (quality, budget, or a custom one). Default: quality."),
      system: z.string().optional().describe("Optional system instruction (overrides the config's)."),
      reasoning_effort: z
        .enum(REASONING_LEVELS)
        .optional()
        .describe("Override reasoning effort. Default: config's (quality/custom=high, budget=medium)."),
      temperature: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe("Override sampling temperature. Default: config's (usually the model default)."),
      analysis_models: z
        .array(z.string())
        .min(1)
        .max(8)
        .optional()
        .describe("Override the config's panel."),
      judge_model: z.string().optional().describe("Override the config's judge/orchestrator."),
      max_tool_calls: z
        .number()
        .int()
        .min(1)
        .max(16)
        .optional()
        .describe("Cap the panel/judge web_search/web_fetch loop (1-16). Default 3. Lower = cheaper, less web."),
    },
  },
  async ({ prompt, preset, system, reasoning_effort, temperature, analysis_models, judge_model, max_tool_calls }) => {
    // Resolve the config FIRST. Only default to quality when preset is omitted; a provided-but-
    // unknown preset (typo, or a custom whose env var failed to load) is an error — never a
    // silent fallback to the most expensive built-in.
    const presetName = (preset || "quality").toLowerCase();
    const cfg = PRESETS[presetName];
    if (!cfg) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Unknown Fusion preset "${preset}". Available: ${Object.keys(PRESETS).join(", ")}. Call fusion_list to see them.`,
            }),
          },
        ],
      };
    }

    pruneJobs();
    const id = newJobId();
    jobs.set(id, { status: "running", ts: Date.now() });

    const panel = analysis_models?.length ? analysis_models : cfg.analysis_models || undefined;
    const judge = judge_model || cfg.judge || undefined;
    const orch = cfg.orchestrator || undefined;
    // Drop the native OpenRouter preset (e.g. budget's general-budget) only when the caller
    // overrides the PANEL — that would conflict with the preset's own panel. A judge-only
    // override keeps the preset's panel intact (just swaps the synthesizer).
    const oPreset = analysis_models?.length ? undefined : cfg.openrouter_preset || undefined;
    const reff = reasoning_effort != null ? reasoning_effort : cfg.reasoning_effort || DEFAULT_REASONING;
    const temp =
      typeof temperature === "number"
        ? temperature
        : typeof cfg.temperature === "number"
        ? cfg.temperature
        : undefined;
    const mtc =
      typeof max_tool_calls === "number"
        ? max_tool_calls
        : typeof cfg.max_tool_calls === "number"
        ? cfg.max_tool_calls
        : undefined;

    callFusion({
      prompt,
      system: system || cfg.system || undefined,
      temperature: temp,
      analysis_models: panel,
      judge_model: judge,
      orchestrator: orch,
      reasoning_effort: reff,
      openrouter_preset: oPreset,
      max_tool_calls: mtc,
    }).then(
      (text) => jobs.set(id, { status: "done", result: text, ts: Date.now() }),
      (err) => jobs.set(id, { status: "error", error: String(err?.message || err), ts: Date.now() })
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            job_id: id,
            status: "running",
            preset: cfg.name || preset || "quality",
            next:
              "Call fusion_result with this job_id. It long-polls up to ~45s and returns the answer when ready, or status 'running' (then call it again).",
          }),
        },
      ],
    };
  }
);

server.registerTool(
  "fusion_result",
  {
    title: "Fusion (fetch async result)",
    description:
      "Fetch the result of a fusion_start job. Long-polls up to ~45s: returns the synthesized " +
      "answer when ready, or {status:'running'} (call again with the same job_id). Fast per call, " +
      "so it never hits the client timeout.",
    inputSchema: {
      job_id: z.string().describe("The job_id returned by fusion_start."),
    },
  },
  async ({ job_id }) => {
    const deadline = Date.now() + 45000;
    for (;;) {
      const j = jobs.get(job_id);
      if (!j) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: "Unknown or expired job_id." }) }],
        };
      }
      if (j.status === "done") {
        jobs.delete(job_id);
        return { content: [{ type: "text", text: j.result }] };
      }
      if (j.status === "error") {
        jobs.delete(job_id);
        return { isError: true, content: [{ type: "text", text: j.error }] };
      }
      if (Date.now() >= deadline) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "running",
                job_id,
                next: "Not ready yet — call fusion_result again with the same job_id.",
              }),
            },
          ],
        };
      }
      await sleep(2000);
    }
  }
);

// Diagnostic: `FUSION_DUMP_PRESETS=1 node server.mjs` prints the resolved configs and exits
// (before connecting, so stdout is free). Handy to verify env-var configs on the host.
if (process.env.FUSION_DUMP_PRESETS) {
  const summary = Object.fromEntries(
    Object.entries(PRESETS).map(([n, p]) => [
      n,
      {
        label: p.label,
        panel: p.analysis_models || (p.openrouter_preset ? `openrouter:${p.openrouter_preset}` : "(default)"),
        judge: p.judge || (p.openrouter_preset ? "(openrouter)" : "(default)"),
        reasoning_effort: p.reasoning_effort,
        temperature: p.temperature,
        max_tool_calls: p.max_tool_calls == null ? DEFAULT_MAX_TOOL_CALLS : p.max_tool_calls,
      },
    ])
  );
  process.stdout.write(JSON.stringify({ count: Object.keys(PRESETS).length, presets: summary }, null, 2) + "\n");
  process.exit(0);
}

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr is safe for logs; stdout is reserved for the MCP protocol.
console.error("openrouter-fusion MCP server v2 running on stdio");
