# Headless opencode server with Telegram bridge

A two-container Docker stack that runs opencode as an always-on headless server,
accessible from a laptop via Tailscale (`opencode web`) and from a phone via a
Telegram bot.

See `docs/superpowers/specs/2026-05-02-headless-opencode-server-design.md` for the design.

See `BOOTSTRAP.md` for one-time setup.

## Quick commands

```sh
make build      # build images
make up         # start the stack
make logs       # tail logs
make test       # run bridge tests
```
