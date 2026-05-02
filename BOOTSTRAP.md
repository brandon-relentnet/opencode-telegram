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
docker compose -f deploy/compose.yaml build
```

> Unraid doesn't ship `make` by default, so the `Makefile` targets won't work
> out of the box. Either install the NerdTools plugin from Community Apps and
> enable `make`, or use the equivalent `docker compose` commands directly
> (shown below).

## 8. Start the stack

```sh
docker compose -f deploy/compose.yaml \
  --env-file /mnt/user/appdata/opencode/.env up -d

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

If any step fails, check `make logs` and the troubleshooting notes in the design spec.

## Routine maintenance

- **Update opencode:** `make build` then `make restart`. Auth and sessions persist via the volumes.
- **Backups:** the CA Backup/Restore Unraid plugin captures `/mnt/user/appdata/opencode/*` automatically. Repos are backed by `git push`.
- **Rotate the bot token:** ask @BotFather to revoke the old one, set the new value in `/mnt/user/appdata/opencode/.env`, `make restart`.
