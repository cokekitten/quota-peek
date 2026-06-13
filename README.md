# Quota Peek

Aggregate usage/quota from **Claude Code**, **Codex (ChatGPT)**, and **GLM Coding Plan** into one dashboard. No cron, no database — providers run live on every request.

Built with **Next.js 15 (App Router) + TypeScript**.

```
GET /api/usage/:provider   → one provider's usage (claude | codex | glm)
GET /                      → dashboard
```

The dashboard fires **3 parallel requests** (one per provider). Each card renders as soon as its own response arrives — the slowest provider never blocks the others.

## Quick start

```bash
npm install
cp .env.example .env   # then fill in GLM_API_KEY
npm run dev            # → http://localhost:3000   (or: npm run build && npm start)
```

Requires Node ≥ 18.18.

## Provider config

| Provider | How it authenticates | Config |
| --- | --- | --- |
| **Claude Code** | runs `claude -p "/usage" --output-format json` (CLI must be logged in) | optional `CLAUDE_TIMEOUT_MS` |
| **Codex** | reads `~/.codex/auth.json`, calls internal `wham/usage` endpoint | optional `CODEX_AUTH_PATH`, `CODEX_USAGE_URL` |
| **GLM** | API key header | `GLM_API_KEY` (required), optional `GLM_BASE_URL` (z.ai international) |

A provider that isn't configured returns `ok: false` with an `error` string — it never breaks the others.

## Project structure

```
app/
  api/usage/[provider]/route.ts   # single dynamic route handler (force-dynamic, nodejs)
  globals.css                     # dark dashboard styles
  icon.svg                        # favicon
  layout.tsx                      # root layout
  page.tsx                        # server component → <Dashboard />
components/
  Dashboard.tsx                   # 'use client' — fires 3 parallel fetches, refresh + auto(10m)
  ProviderCard.tsx                # 'use client' — per-card loading/error/data, renders independently
  types.ts                        # client-side response types
lib/providers/
  claude.ts  codex.ts  glm.ts     # server-only providers (node:child_process, node:fs)
  index.ts                        # registry + fetchOneUsage()
  types.ts                        # shared domain types
```

## Response shape

`GET /api/usage/glm` →

```jsonc
{
  "ok": true,
  "timestamp": "2026-06-13T18:19:33.000Z",
  "provider": {
    "ok": true, "provider": "glm", "label": "GLM Coding Plan",
    "summary": {
      "level": "Max", "planLabel": "GLM Max",
      "limits": [
        { "label": "MCP · weekly",      "kind": "MCP",     "percent": 0, "used": 0, "total": 4000, "resetAt": "…" },
        { "label": "Tokens · 5h window", "kind": "Tokens", "percent": 1, "resetAt": "…" },
        { "label": "Tokens · weekly",    "kind": "Tokens", "percent": 4, "resetAt": "…" }
      ]
    },
    "raw": { /* full provider response */ }
  }
}
```

Each provider's `summary.limits` is an array of `{ label, kind, percent, used?, total?, resetAt?, detail? }` — the dashboard renders these as progress bars.

## Notes & caveats

- **Codex** uses an internal ChatGPT endpoint (`backend-api/wham/usage`). It can change without notice.
- **GLM** period labels (`5h window` / `weekly` / `monthly`) are derived from each limit's actual `nextResetTime`, not guessed from the opaque `unit` field.
- The dashboard auto-refresh toggle defaults **off**; when on, it polls every 10 minutes.
