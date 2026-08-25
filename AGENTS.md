# AGENTS.md — site1 working conventions

Guidance for AI coding agents (Copilot, Cursor, etc.) working in this repo.

## Terminal command permissions (user preference)

The user wants terminal commands to run **without per-command approval prompts**.
Two settings control this in VS Code (User `settings.json`):

```jsonc
{
  // Agent-initiated terminal commands (Copilot agent mode, etc.)
  "chat.agent.terminalCommandPermissions": "allow",
  // Chat-initiated terminal commands (inline chat, chat panel)
  "chat.terminalCommandPermissions": "allow"
}
```

Values: `allow` | `ask` | `deny`. `allow` runs commands automatically; `ask` prompts
each time; `deny` blocks them.

Alternative: in the terminal permission dropdown that appears when a command is
about to run, pick **"Always allow"** (or "Always allow this command") — VS Code
remembers it for the session/permission scope.

## Environment

- **Windows PowerShell 5.1** is the terminal. Use PowerShell syntax, not bash:
  - File search: `Select-String -Path <file> -Pattern "regex"` (the workspace may
    have a remote-file provider that breaks `grep_search`/`file_search` — use the
    terminal for content searches).
  - List files: `Get-ChildItem -Recurse`, check existence: `Test-Path`.
  - Chained commands: use `;` (PowerShell), **never** `&&`.
- Node.js is available. Throwaway analysis scripts go in the repo root with a
  `_` prefix (e.g. `_verify-x.mjs`) and can be deleted after use.

## Tests

- `node tests/perps-wallet-persist.mjs`
- `node tests/perps-regression.test.mjs`
- `node tests/defi-pnl.test.mjs`
- `node tests/etf-dca.test.mjs`
- `npm run test:perps` — runs all three perps tests

Run the relevant test after touching its area.

## Deploy

- Push to `origin/main` → Vercel auto-builds **https://testedefi.vercel.app**.
- The user wants **automatic production deploys** after any code change, and
  **verification on production** after deploying. See:
  - `.cursor/rules/auto-deploy-vercel.mdc`
  - `.cursor/rules/verify-after-deploy.mdc`
  - `.cursor/rules/vercel-serverless-limit.mdc` (max 12 `api/*.js` functions)
  - `.cursor/rules/persist-watcher-newsfeed.mdc` (Watcher/News Feed sync pattern)

## Perps dashboard architecture (quick facts)

- Vanilla JS SPA: `index.html` (client) + `api/aave-proxy.js` + `api/sync.js` +
  `lib/perps.js`, `lib/closed-leg-reconstruct.js`, `lib/variational-hedge.js`.
- `vercel.json` rewrites `/api/perps` → `/api/aave-proxy`; functions `maxDuration 60`.
- Live API: `https://testedefi.vercel.app/api/perps?wallet=0x523c4fD04438aAB5e96CADCcDC92c855390Fb459&nado=0x523c4fD04438aAB5e96CADCcDC92c855390Fb459&grvt=4860249204328359&days=30&force=1`
- Closed-tab rows are seeded **client-side** each refresh
  (`perpsSeedHlExtendedClosedPairsFromExchange`, `perpsSeedGrvtClosedPairsFromExchange`).
  `_perpsLastData` is a top-level `let`, NOT on `window`.
- HL `closedPnl` on close fills is cumulative, not incremental — the dashboard
  uses price-based incremental PnL (`reconcileLegRealizedPnl` in
  `lib/closed-leg-reconstruct.js`).
- Extended `/user/positions/history` only returns FULLY closed positions; still-open
  partial hedges are reconstructed from fills instead.
