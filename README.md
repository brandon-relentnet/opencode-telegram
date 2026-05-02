# Headless opencode server with Telegram bridge

An always-on, self-hosted opencode AI coding agent that you can drive
from any device:

- **Laptop:** open `opencode web` in a browser over Tailscale.
- **Phone:** chat with a Telegram bot that bridges into the opencode SDK.

## What's in here

- `opencode-image/` — Docker image for the headless opencode server (LSPs + tools)
- `tg-bridge/` — TypeScript Telegram bot using `grammy` + `@opencode-ai/sdk`
- `deploy/` — Docker Compose stack
- `docs/superpowers/specs/` — design document
- `docs/superpowers/plans/` — implementation plan

## Architecture in one diagram

```
[Phone]   ──Telegram──▶  [tg-bridge]  ──HTTP/SSE──▶  [opencode]
[Laptop]  ──Tailscale──▶                opencode web (port 4096)
                          (both containers run on Unraid)
```

## Quick start

See `BOOTSTRAP.md` for the one-time setup. After that:

```sh
make up-unraid    # start the stack
make logs         # tail logs
make down         # stop
```

## Slash commands (Telegram)

- `/help` — list commands
- `/projects` — list available projects under `/workspace`
- `/switch <name>` — pick a project (creates a fresh session)
- `/new` — start a new session in the current project
- `/abort` — stop the current task
- `/status` — show project, session, model
- `/model [providerID/modelID]` — show or set the model
- Any other text — talk to the agent

## Development

```sh
cd tg-bridge
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run dev       # tsx watch
```

## Design

The full design rationale and trade-offs are in
`docs/superpowers/specs/2026-05-02-headless-opencode-server-design.md`.
