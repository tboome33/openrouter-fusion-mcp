# Publishing to the MCPHub market

MCPHub's **"market"** (the browsable server catalog in the dashboard) is a single file in the
upstream repo: [`servers.json`](https://github.com/samanhappy/mcphub/blob/main/servers.json) — a
JSON object keyed by server id (~300 entries). There is no separate market repo and no
`CONTRIBUTING.md`: **you publish by opening a pull request that adds your entry to that file.**

The entry for this server is ready in [`mcphub-market-entry.json`](mcphub-market-entry.json) —
copy its `"openrouter-fusion": { ... }` block into `servers.json` (alphabetical-ish order).

## Prerequisite — the server must be installable from a public source

The market install command has to work for anyone. This server is plain ESM with a `bin` entry,
so the simplest path needs **no npm publish** — just a public GitHub repo, run via `npx`:

```
npx -y github:tboome33/openrouter-fusion-mcp
```

So step 1 is to push this repo to GitHub (public). Optionally publish to npm later and switch
the install args to `["-y", "openrouter-fusion-mcp"]`.

## Steps

1. **Create a public GitHub repo** and push (under `tboome33`):

   ```bash
   gh repo create openrouter-fusion-mcp --public --source . --remote origin --push
   ```

2. **Verify the npx install works** from the public repo:

   ```bash
   OPENROUTER_API_KEY=sk-or-... npx -y github:tboome33/openrouter-fusion-mcp
   # should print: openrouter-fusion MCP server v2 running on stdio
   ```

3. **Fork** `samanhappy/mcphub`, add the entry to `servers.json`:

   ```bash
   gh repo fork samanhappy/mcphub --clone
   # edit servers.json: paste the "openrouter-fusion" block from mcphub-market-entry.json
   git checkout -b add-openrouter-fusion
   git commit -am "market: add openrouter-fusion (multi-model deliberation)"
   git push -u origin add-openrouter-fusion
   ```

4. **Open the PR** against `samanhappy/mcphub`:

   ```bash
   gh pr create --repo samanhappy/mcphub --title "market: add openrouter-fusion" \
     --body "Adds OpenRouter Fusion (multi-model deliberation) to the market. Repo: https://github.com/tboome33/openrouter-fusion-mcp"
   ```

## Entry schema (mirrors existing market entries)

`name` · `display_name` · `description` · `repository {type,url}` · `homepage` · `author {name}` ·
`license` · `categories[]` (valid: AI Systems, MCP Tools, Dev Tools, Web Services, Databases,
Knowledge Base, Productivity, Finance, Media Creation, Analytics, Messaging, System Tools,
Professional Apps) · `tags[]` · `examples[] {title,description,prompt}` ·
`installations {<type>: {type,command,args,env,description}}` (types: npm, uvx, custom, python,
docker, cli) · `arguments {<ENV>: {description,required,example}}` · `tools[] {name,description,inputSchema}`.

This server uses categories **AI Systems** + **MCP Tools** and an **npm/npx-from-GitHub** install.
