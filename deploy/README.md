# Deploy

This directory holds the Compose file for running both containers. See
the project root's `BOOTSTRAP.md` for one-time setup steps.

## Files

- `compose.yaml` — service definitions
- `.env.example` — copy to `/mnt/user/appdata/opencode/.env` and fill in

## Common commands

Run from the repo root:

```sh
make build      # build both images
make up         # start the stack (reads /mnt/user/appdata/opencode/.env)
make down       # stop and remove containers
make logs       # tail compose logs
make restart    # down + up
```

## Volume layout (Unraid defaults)

| Container path                       | Unraid path                                    |
|--------------------------------------|------------------------------------------------|
| `/workspace` (opencode rw, bridge ro)| `/mnt/user/code`                               |
| `/root/.local/share/opencode`        | `/mnt/user/appdata/opencode/data`              |
| `/root/.config/opencode`             | `/mnt/user/appdata/opencode/config`            |
| `/root/.ssh` (ro)                    | `/mnt/user/appdata/opencode/ssh`               |
| `/data` (bridge)                     | `/mnt/user/appdata/opencode/bridge`            |

Pin all of the above to the cache pool via Unraid Mover settings.
