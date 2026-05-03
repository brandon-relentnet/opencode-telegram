# Bootstrap

One-time setup for the headless opencode server. All paths are Unraid
defaults; adjust if you store things elsewhere.

## Prerequisites

- Unraid with the Docker engine running
- The Tailscale Community Apps plugin installed and logged in
- A reasonable amount of disk on the cache pool (~5 GB working room)
- A Telegram account on your phone

## 1. Tailscale

1. Open the Tailscale plugin's web UI on Unraid.
2. Confirm the host's tailnet IP (e.g. `100.x.y.z`).
3. From any other tailnet device, `ping <unraid-tailnet-ip>` should succeed.

## 2. Create the Telegram bot

1. In Telegram, DM `@BotFather`.
2. Send `/newbot`. Pick a name and a unique username ending in `_bot`.
3. Save the token BotFather gives you. Treat it like a password.

## 3. Find your Telegram numeric user ID

1. DM `@userinfobot`. Save the `Id` value.
2. (Optional) Repeat for any additional users you want to allow.

## 4. Generate an SSH deploy key for git

Run on the **Unraid host** (web UI terminal `>_`, or `ssh root@<unraid-ip>`):

```sh
mkdir -p /mnt/user/appdata/opencode/ssh
ssh-keygen -t ed25519 -N "" -f /mnt/user/appdata/opencode/ssh/id_ed25519 \
  -C "opencode-server@$(hostname)"
chmod 600 /mnt/user/appdata/opencode/ssh/id_ed25519
chmod 644 /mnt/user/appdata/opencode/ssh/id_ed25519.pub
cat /mnt/user/appdata/opencode/ssh/id_ed25519.pub
```

The `cat` prints the public key. Copy the whole line and add it to GitHub:
- **Per-repo deploy key** (recommended): repo → Settings → Deploy keys → Add deploy key. Tick "Allow write access" if you want the agent to `git push`.
- **Personal SSH key** (simpler for many repos): GitHub profile → Settings → SSH and GPG keys → New SSH key.

## 5. Generate the `.env` file

```sh
mkdir -p /mnt/user/appdata/opencode
PASSWORD="$(openssl rand -hex 32)"
cat > /mnt/user/appdata/opencode/.env <<EOF
TELEGRAM_BOT_TOKEN=PASTE_YOUR_BOTFATHER_TOKEN_HERE
TELEGRAM_ALLOWED_USER_IDS=PASTE_YOUR_NUMERIC_USER_ID_HERE
OPENCODE_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=$PASSWORD
INSTALL_GO_LSP=false
INSTALL_RUST_LSP=false
LOG_LEVEL=info
DEFAULT_MODEL=anthropic/claude-sonnet-4-5
WORKSPACE_HOST_PATH=/mnt/user/code
APPDATA_HOST_PATH=/mnt/user/appdata/opencode
EOF
chmod 600 /mnt/user/appdata/opencode/.env
```

Edit the file and paste the bot token and user ID where indicated.

## 6. Prepare the workspace

```sh
mkdir -p /mnt/user/code
# Clone whatever repos you'll work on into /mnt/user/code/<repo-name>
cd /mnt/user/code
git clone git@github.com:you/myapp.git
git clone git@github.com:you/blog.git
```

## 7. Clone this project somewhere on Unraid and build

```sh
git clone https://github.com/brandon-relentnet/opencode-telegram.git \
  /mnt/user/appdata/opencode/repo
cd /mnt/user/appdata/opencode/repo

# Symlink the .env file *next to the compose file* so every
# `docker compose` command picks it up automatically. Compose's
# default discovery looks in the project directory (deploy/), not
# in your shell's cwd.
ln -sf /mnt/user/appdata/opencode/.env deploy/.env

# Pre-create the bridge's data directory with the right ownership.
# The tg-bridge container runs as UID 1001 (non-root); without this,
# Docker creates the bind-mount target as root and SQLite fails to
# open the database file.
mkdir -p /mnt/user/appdata/opencode/bridge
chown -R 1001:1001 /mnt/user/appdata/opencode/bridge

docker compose -f deploy/compose.yaml build
```

> Unraid doesn't ship `make` by default, and Docker Compose v2 isn't included
> either. Install the **Compose Manager** plugin from Community Apps to get
> `docker compose`. Optionally install **NerdTools** if you want `make`
> available too. Without `make`, use the `docker compose` commands directly
> (shown below).

## 8. Start the stack

```sh
docker compose -f deploy/compose.yaml up -d

docker compose -f deploy/compose.yaml logs -f --tail=200
```

(With `make` installed, these are just `make up-unraid && make logs`.)

You should see opencode logging that it's listening on `:4096` and
tg-bridge logging "starting" with no errors.

## 9. Connect Anthropic (one-time, from a tailnet device)

1. From your laptop (on the tailnet), open `http://<unraid-tailnet-ip>:4096`.
2. Sign in with username `opencode` and the `OPENCODE_SERVER_PASSWORD` value.
3. Click "Connect Anthropic" (or whichever provider).
4. Complete the OAuth flow. The token is saved into the `data` volume.

## 10. Smoke test from your phone

1. In Telegram, search for your bot (the BotFather username) and start a chat.
2. Send `/help` — you should get a reply listing commands.
3. Send `/projects` — you should see your repos listed.
4. Send `/switch myapp` — bot confirms the switch and creates a session.
5. Send `what is 2+2` — bot replies "4" (or thereabouts).
6. Send `list the files in this project` — agent will use a tool. You'll see a "thinking…" message that updates as it works.
7. Send `run the tests` — agent will request bash permission. Tap `✅ Once`. The bash output appears.

If any step fails, check `docker compose logs -f tg-bridge` (or `make logs`)
and the troubleshooting notes in the design spec.

> **Use the actual Telegram client.** The permission keyboard
> (`✅ Once / ✓ Always / ❌ Deny`) uses Telegram's `inline_keyboard`
> feature. Multi-protocol bridges like Beeper and matrix-telegram
> bridges typically do **not** render inline keyboards — you'll see
> the permission text but no buttons, leaving you unable to grant
> access. Use the official Telegram app on iOS/Android/Desktop, or
> Telegram Web at telegram.org, for any session that needs to grant
> bash/webfetch permissions. Read-only chats (no permission prompts)
> work fine in any Telegram-compatible client.

## 11. (Optional) Configure /init-remote + /deploy

If you want to use `/init-remote` (auto-create GitHub repos) and `/deploy` (push to your Coolify server), do this one-time setup. Skip this section if you only need local-project workflows; everything else keeps working without these env vars.

### A. GitHub PAT

1. Visit https://github.com/settings/tokens/new
2. Note name: `tg-bridge-coolify`
3. Expiration: pick a value (90 days recommended; 1 year is the max practical)
4. Scopes: check **`repo`** (Full control of private repositories) and **`workflow`** (Update GitHub Action workflows)
5. Generate token; copy the `ghp_...` value
6. Add to `/mnt/user/appdata/opencode/.env`:
   ```
   GH_TOKEN=ghp_...
   GH_OWNER=your-github-username
   ```
   (`GH_OWNER` is your username for personal repos, or an org name if you want repos created in an org. The PAT must have access to that namespace.)

### B. Coolify GitHub App (one-time per Coolify instance)

1. In Coolify dashboard → **Sources** → **+ New** → **GitHub App**
2. Walk through the GitHub OAuth flow to install the Coolify GitHub App into your account (or org)
3. After installation, click the source in Coolify and copy its **UUID** from the page

### C. Coolify API token

1. Coolify dashboard → top-right avatar → **Keys & Tokens** → **API Tokens** → **+ Create New Token**
2. Permissions: include **read** + **write** + **deploy** (or "all" for simplicity)
3. Copy the token

### D. Note your Coolify Server + Project UUIDs

1. **Server UUID:** Coolify dashboard → **Servers** → click your server → URL bar contains `/server/<uuid>`
2. **Project UUID:** Coolify dashboard → **Projects** → click your project (or create one named "telegram-deploys") → URL bar contains `/project/<uuid>`

### E. Add to `/mnt/user/appdata/opencode/.env`

```
COOLIFY_URL=https://coolify.your-domain.com
COOLIFY_TOKEN=...
COOLIFY_SERVER_UUID=...
COOLIFY_PROJECT_UUID=...
COOLIFY_GITHUB_APP_UUID=...
```

### F. Restart the stack

```bash
cd /mnt/user/appdata/opencode/repo
docker compose -f deploy/compose.yaml up -d
```

The opencode container needs to be recreated so it picks up `GH_TOKEN` and the `COOLIFY_*` vars (the agent's bash reads them via shell expansion).

### G. Smoke test from Telegram

1. `/init-remote test-deploy-1` — see streaming view → final auto-switch confirmation
2. Visit `https://github.com/<your-username>/test-deploy-1` — confirm private repo with one commit
3. Chat: "build me a simple hello-world Astro site"
4. `/deploy` — see streaming view → final "✅ Deployed: https://..." message
5. Open the deploy URL — confirm site loads
6. Chat: "change the heading to 'Hello, World 2'"
7. `/deploy` again — confirm rebuild after a minute (Coolify takes 30s-2min depending on stack)

If anything fails: `docker logs tg-bridge --tail=200` and `docker logs opencode --tail=200` show what went wrong.

## Routine maintenance

- **Update opencode:** `make build` then `make restart`. Auth and sessions persist via the volumes.
- **Backups:** the CA Backup/Restore Unraid plugin captures `/mnt/user/appdata/opencode/*` automatically. Repos are backed by `git push`.
- **Rotate the bot token:** ask @BotFather to revoke the old one, set the new value in `/mnt/user/appdata/opencode/.env`, `make restart`.
