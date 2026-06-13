# Quota Peek

Aggregate usage/quota from **Claude Code**, **Codex (ChatGPT)**, and **GLM Coding Plan** into one dashboard. No cron, no database — providers run live on every request.

```
GET /api/usage           → all three providers in parallel
GET /api/usage/:provider → one of claude | codex | glm
GET /                    → dashboard (static)
```

## Quick start

```bash
npm install
cp .env.example .env   # then fill in GLM_API_KEY
npm start              # → http://localhost:3000
```

Requires Node ≥ 18.

## Provider config

| Provider | How it authenticates | Config |
| --- | --- | --- |
| **Claude Code** | runs `claude -p "/usage" --output-format json` (CLI must be logged in) | optional `CLAUDE_TIMEOUT_MS` |
| **Codex** | reads `~/.codex/auth.json`, calls internal `wham/usage` endpoint | optional `CODEX_AUTH_PATH`, `CODEX_USAGE_URL` |
| **GLM** | API key header | `GLM_API_KEY` (required), optional `GLM_BASE_URL` (z.ai international) |

A provider that isn't configured returns `ok: false` with an `error` string — it never breaks the others (each runs under `Promise.allSettled`).

## Response shape

```jsonc
{
  "ok": true,
  "timestamp": "2026-06-13T17:46:21.057Z",
  "providers": {
    "claude": {
      "ok": true, "provider": "claude", "label": "Claude Code",
      "summary": {
        "plan_label": "Claude Code",
        "limits": [
          { "label": "Session",              "kind": "current_session",            "percent": 0 },
          { "label": "Week · all models",    "kind": "current_week_all_models",    "percent": 5 },
          { "label": "Week · Sonnet only",   "kind": "current_week_sonnet_only",   "percent": 0 }
        ]
      },
      "text": "…", "raw": { /* full claude JSON envelope */ }
    },
    "codex": { "ok": true, "summary": { "plan_type": "pro", "plan_label": "Codex pro", "limits": [
      { "label": "Primary · 5h window", "percent": 7,  "reset_at": "…" },
      { "label": "Secondary · weekly",  "percent": 53, "reset_at": "…" }
    ] }, "raw": { /* … */ } },
    "glm": { "ok": true, "summary": { "level": "Max", "plan_label": "GLM Max", "limits": [
      { "label": "MCP · weekly",     "percent": 0, "used": 0, "total": 4000, "reset_at": "…" },
      { "label": "Tokens · 5h window","percent": 3, "reset_at": "…" },
      { "label": "Tokens · weekly",  "percent": 3, "reset_at": "…" }
    ] }, "raw": { /* … */ } }
  }
}
```

Each provider's `summary.limits` is an array of `{ label, kind, percent, used?, total?, reset_at?, detail? }` — the dashboard renders these as progress bars.

## Notes & caveats

- **Codex** uses an internal ChatGPT endpoint (`backend-api/wham/usage`). It can change without notice.
- **GLM** period labels (`5h window` / `weekly` / `monthly`) are derived from each limit's actual `nextResetTime`, not guessed from the opaque `unit` field.
- The dashboard auto-refresh toggle defaults **off**; when on, it polls every 10 minutes.
