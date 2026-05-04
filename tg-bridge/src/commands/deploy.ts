import type { Context } from "grammy";
import type { Logger } from "pino";
import { escapeMarkdownV2 } from "../format.js";
import { describeError } from "../errors.js";
import { safeEdit } from "../safe-telegram.js";
import { Turn, type IncomingPart, type TurnBot } from "../turn.js";
import { parseModelId } from "../config.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";
import type { SessionEventHandler } from "../event-router.js";
import type { PinnedStatusDeps } from "../pinned-status.js";

export interface CoolifyConfig {
  url: string | undefined;
  token: string | undefined;
  serverUuid: string | undefined;
  projectUuid: string | undefined;
  githubAppUuid: string | undefined;
}

export interface DeployDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  router: {
    registerSession(sessionId: string, handler: SessionEventHandler): () => void;
    ensureDirectory(directory: string): boolean;
  };
  bot: TurnBot;
  workspaceRoot: string;
  defaultModel: string;
  coolifyConfig: CoolifyConfig;
  /**
   * Pinned-status manager. handleDeploy flips it to Working at session
   * start, calls notifyStateChange after persisting a new Coolify app
   * (state.setCoolifyApp), and setFailed on error paths.
   */
  pinnedStatus?: PinnedStatusDeps;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Default value for `NIXPACKS_NODE_VERSION` set on every Coolify app the
 * bridge creates. Pinning this avoids surprises when the agent scaffolds a
 * project against a Node version Coolify's Nixpacks doesn't yet ship
 * (e.g. Vite 8 requires Node 22.12+ but Coolify currently bundles 22.11).
 *
 * `"22"` matches the Node major version existing successful projects on
 * the user's Coolify instance run on. Users can override per-app via the
 * Coolify dashboard, or change the default by editing this constant.
 */
export const DEFAULT_NIXPACKS_NODE_VERSION = "22";

/**
 * Build the deterministic prompt for first-time deploy of a project.
 *
 * Three-step Coolify flow so build-time env vars are set BEFORE the build:
 *   1. POST /applications/private-github-app with `instant_deploy: false`
 *   2. POST /applications/{uuid}/envs to set NIXPACKS_NODE_VERSION
 *   3. GET  /api/v1/deploy?uuid={uuid} to start the build explicitly
 *
 * Pushes pending commits first, then runs the three Coolify calls. Parses
 * the create response with `jq` and echoes `deployed:$APP_UUID:$FQDN` for
 * the bridge to parse + persist.
 *
 * Coolify URL/token + the project/server/github-app UUIDs are referenced
 * as shell variables ($COOLIFY_URL, $COOLIFY_TOKEN, etc.) so secrets stay
 * in the opencode container's env and never appear in the prompt body.
 */
export function buildFirstDeployPrompt(projectPath: string): string {
  return [
    "Run exactly this single bash command and report only the result. Do not run other commands. Do not retry on failure.",
    "",
    "```bash",
    `set -e`,
    `cd ${projectPath}`,
    `# Coolify rejects .git suffix on git_repository — strip it.`,
    `REPO_URL=$(git remote get-url origin | sed 's/\\.git$//')`,
    `git add -A`,
    `git diff --cached --quiet || git commit -m "Updates from Telegram session"`,
    `git push origin main`,
    `# 1) Create the Coolify app (instant_deploy=false; we set env vars next).`,
    `PAYLOAD=$(cat <<EOF`,
    `{`,
    `  "project_uuid": "$COOLIFY_PROJECT_UUID",`,
    `  "server_uuid": "$COOLIFY_SERVER_UUID",`,
    `  "environment_name": "production",`,
    `  "github_app_uuid": "$COOLIFY_GITHUB_APP_UUID",`,
    `  "git_repository": "$REPO_URL",`,
    `  "git_branch": "main",`,
    `  "build_pack": "nixpacks",`,
    `  "ports_exposes": "3000",`,
    `  "instant_deploy": false`,
    `}`,
    `EOF`,
    `)`,
    `# Use -s without -f so we get the response body even on HTTP errors.`,
    `# Capture status separately so we can surface a clear failure reason.`,
    `RESP=$(curl -s -w "\\n___STATUS:%{http_code}" -X POST "$COOLIFY_URL/api/v1/applications/private-github-app" \\`,
    `  -H "Authorization: Bearer $COOLIFY_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d "$PAYLOAD")`,
    `STATUS=$(echo "$RESP" | sed -n 's/.*___STATUS://p')`,
    `BODY=$(echo "$RESP" | sed '$d' | sed 's/___STATUS:[0-9]*$//')`,
    `if [ "$STATUS" != "200" ] && [ "$STATUS" != "201" ]; then`,
    `  echo "failed: Coolify HTTP $STATUS: $BODY"`,
    `  exit 0`,
    `fi`,
    `APP_UUID=$(echo "$BODY" | jq -r '.uuid // empty')`,
    `# Coolify returns the FQDN under .domains (a string of comma-separated URLs).`,
    `# Take the first URL and strip the scheme so the bridge can prepend https:// itself.`,
    `FQDN=$(echo "$BODY" | jq -r '.domains // empty' | sed 's|^https\\?://||' | cut -d',' -f1)`,
    `if [ -z "$APP_UUID" ] || [ -z "$FQDN" ]; then`,
    `  echo "failed: Coolify response missing uuid or domains: $BODY"`,
    `  exit 0`,
    `fi`,
    `# 2) Set NIXPACKS_NODE_VERSION as a build-time env. Soft-fail: if Coolify`,
    `#    rejects this we continue with their default Node version.`,
    `ENV_RESP=$(curl -s -w "\\n___STATUS:%{http_code}" -X POST "$COOLIFY_URL/api/v1/applications/$APP_UUID/envs" \\`,
    `  -H "Authorization: Bearer $COOLIFY_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"key": "NIXPACKS_NODE_VERSION", "value": "${DEFAULT_NIXPACKS_NODE_VERSION}", "is_buildtime": true, "is_runtime": false}')`,
    `ENV_STATUS=$(echo "$ENV_RESP" | sed -n 's/.*___STATUS://p')`,
    `if [ "$ENV_STATUS" != "200" ] && [ "$ENV_STATUS" != "201" ]; then`,
    `  echo "warn: env-var set returned HTTP $ENV_STATUS; continuing" >&2`,
    `fi`,
    `# 3) Trigger the deploy explicitly (instant_deploy was false above).`,
    `DEP_RESP=$(curl -s -w "\\n___STATUS:%{http_code}" -X GET "$COOLIFY_URL/api/v1/deploy?uuid=$APP_UUID" \\`,
    `  -H "Authorization: Bearer $COOLIFY_TOKEN")`,
    `DEP_STATUS=$(echo "$DEP_RESP" | sed -n 's/.*___STATUS://p')`,
    `if [ "$DEP_STATUS" != "200" ] && [ "$DEP_STATUS" != "201" ]; then`,
    `  DEP_BODY=$(echo "$DEP_RESP" | sed '$d' | sed 's/___STATUS:[0-9]*$//')`,
    `  echo "failed: Coolify deploy trigger HTTP $DEP_STATUS: $DEP_BODY"`,
    `  exit 0`,
    `fi`,
    `echo "deployed:$APP_UUID:$FQDN"`,
    "```",
    "",
    "On success, reply with the line printed by the script (deployed:UUID:FQDN).",
    "",
    "On failure, reply with: failed: <one-line summary of the failing command>",
  ].join("\n");
}

/**
 * Build the deterministic prompt for subsequent deploys. The Coolify app
 * already exists (UUID embedded — UUIDs are not secrets); we just push and
 * trigger a rebuild. Echoes a bare `deployed` marker.
 */
export function buildSubsequentDeployPrompt(projectPath: string, appUuid: string): string {
  return [
    "Run exactly this single bash command and report only the result. Do not run other commands. Do not retry on failure.",
    "",
    "```bash",
    `set -e`,
    `cd ${projectPath}`,
    `git add -A`,
    `git diff --cached --quiet || git commit -m "Updates from Telegram session"`,
    `git push origin main`,
    `# Coolify auto-deploys on push via webhook; this guarantees a build even with no commits.`,
    `# -s without -f so we get the response body even on HTTP errors.`,
    `RESP=$(curl -s -w "\\n___STATUS:%{http_code}" -X GET "$COOLIFY_URL/api/v1/deploy?uuid=${appUuid}" -H "Authorization: Bearer $COOLIFY_TOKEN")`,
    `STATUS=$(echo "$RESP" | sed -n 's/.*___STATUS://p')`,
    `BODY=$(echo "$RESP" | sed '$d' | sed 's/___STATUS:[0-9]*$//')`,
    `if [ "$STATUS" = "404" ]; then`,
    `  echo "failed: app_not_found: Coolify app ${appUuid} no longer exists (404). The bridge will reset its state on next deploy."`,
    `  exit 0`,
    `elif [ "$STATUS" != "200" ] && [ "$STATUS" != "201" ]; then`,
    `  echo "failed: Coolify HTTP $STATUS: $BODY"`,
    `  exit 0`,
    `fi`,
    `echo "deployed"`,
    "```",
    "",
    "On success, reply with the single word: deployed",
    "",
    "On failure, reply with: failed: <one-line summary of the failing command>",
  ].join("\n");
}

export type DeployReply =
  | { kind: "first"; uuid: string; fqdn: string }
  | { kind: "subsequent" }
  | { kind: "failed"; reason: string };

/**
 * Parse the agent's final text part into a structured deploy result, or null
 * if unrecognized. Whitespace is trimmed; the prefix is matched
 * case-insensitively so verbose wording like "Deployed:..." still parses.
 */
export function parseDeployReply(text: string, isFirstDeploy: boolean): DeployReply | null {
  const t = text.trim();
  if (t.length === 0) return null;
  const failedMatch = t.match(/^failed:\s*(.+)$/i);
  if (failedMatch) return { kind: "failed", reason: failedMatch[1]!.trim() };
  if (isFirstDeploy) {
    const m = t.match(/^deployed:([^:]+):(.+)$/i);
    if (m) return { kind: "first", uuid: m[1]!.trim(), fqdn: m[2]!.trim() };
    return null;
  }
  if (/^deployed\s*$/i.test(t)) return { kind: "subsequent" };
  return null;
}

/**
 * Drive the /deploy flow:
 *  1. Validate chat has a project + COOLIFY_* env vars are present
 *  2. Branch on whether a coolify_app row exists for (chat, project):
 *     - first-deploy → buildFirstDeployPrompt + parse UUID/FQDN + persist
 *     - subsequent  → buildSubsequentDeployPrompt + just confirm
 *  3. Open a one-shot opencode session anchored at the project directory
 *  4. Stream parts into the placeholder via Turn; on session.idle, parse
 *     the last text part and finalize accordingly
 */
export async function handleDeploy(ctx: Context, deps: DeployDeps): Promise<void> {
  try {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") return;

    const stateRow = deps.state.get(chatId);
    if (!stateRow?.projectPath) {
      await ctx.reply(
        escapeMarkdownV2("Use /switch <project> first, then /deploy."),
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    const cfg = deps.coolifyConfig;
    const missing: string[] = [];
    if (!cfg.url) missing.push("COOLIFY_URL");
    if (!cfg.token) missing.push("COOLIFY_TOKEN");
    if (!cfg.serverUuid) missing.push("COOLIFY_SERVER_UUID");
    if (!cfg.projectUuid) missing.push("COOLIFY_PROJECT_UUID");
    if (!cfg.githubAppUuid) missing.push("COOLIFY_GITHUB_APP_UUID");
    if (missing.length > 0) {
      await ctx.reply(
        escapeMarkdownV2(
          `Coolify env vars not set on the bridge: ${missing.join(", ")}. See BOOTSTRAP.md.`,
        ),
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    const projectPath = stateRow.projectPath;
    const existing = deps.state.getCoolifyApp(chatId, projectPath);
    const isFirst = existing == null;

    const placeholder = await ctx.reply(
      escapeMarkdownV2(isFirst ? "creating Coolify app + deploying…" : "deploying…"),
      { parse_mode: "MarkdownV2" },
    );
    const placeholderId =
      typeof (placeholder as { message_id?: number }).message_id === "number"
        ? (placeholder as { message_id: number }).message_id
        : 0;

    const prompt = isFirst
      ? buildFirstDeployPrompt(projectPath)
      : buildSubsequentDeployPrompt(projectPath, existing.uuid);

    deps.router.ensureDirectory(projectPath);
    // Pinned status reflects the in-flight deploy. The detail string keeps
    // the user oriented when the placeholder scrolls off-screen.
    deps.pinnedStatus?.setWorking(
      chatId,
      isFirst ? "deploying (first)" : "deploying",
    );
    const session = await deps.client.createSession(`tg:deploy:${projectPath}`, {
      directory: projectPath,
    });

    const turn = new Turn(deps.bot, chatId, placeholderId);
    const collected: IncomingPart[] = [];
    // Track user-role message IDs so the unparseable-reply fallback doesn't
    // echo the deploy prompt back at the user.
    const userMessageIds = new Set<string>();
    let unregistered = false;
    const unregister = deps.router.registerSession(session.id, {
      onMessageCreated(msg) {
        const m = msg as { info?: { id?: string; role?: string } };
        if (m.info?.role === "user" && typeof m.info.id === "string") {
          userMessageIds.add(m.info.id);
        }
      },
      onPartUpdated(part) {
        const p = part as IncomingPart;
        if (typeof p.id !== "string") return;
        const idx = collected.findIndex((cp) => cp.id === p.id);
        if (idx >= 0) collected[idx] = p;
        else collected.push(p);
        turn.appendPart(p);
      },
      async onIdle() {
        try {
          const lastText =
            collected
              .filter((p) => p.type === "text" && typeof p.text === "string")
              .map((p) => (p.text ?? "").trim())
              .filter((t) => t.length > 0)
              .at(-1) ?? "";
          const result = parseDeployReply(lastText, isFirst);
          // Build the Coolify dashboard URL so the user can manage the app.
          // Coolify's app URL pattern is /project/<P>/environment/production/application/<A>.
          // We don't know the environment UUID without an extra API call, so use the
          // /applications/<uuid> shortcut which Coolify resolves correctly.
          const dashboardUrl = (uuid: string): string =>
            cfg.url ? `${cfg.url.replace(/\/+$/, "")}/applications/${uuid}` : "";
          if (result?.kind === "first") {
            // Stop streaming view BEFORE we overwrite the placeholder, so a
            // queued setTimeout can't fire afterward and revert.
            await turn.cancel();
            deps.state.setCoolifyApp(chatId, projectPath, result.uuid, result.fqdn);
            // Coolify-app row changed → pinned message gains a "Deploy" line.
            deps.pinnedStatus?.notifyStateChange(chatId);
            deps.pinnedStatus?.setIdle(chatId);
            const dashboard = dashboardUrl(result.uuid);
            const lines = [
              `✅ Deployed: https://${result.fqdn}`,
              ...(dashboard ? [`Coolify dashboard: ${dashboard}`] : []),
            ].join("\n");
            await safeEdit(
              deps.bot,
              chatId,
              placeholderId,
              escapeMarkdownV2(lines),
              deps.log,
              "MarkdownV2",
            );
          } else if (result?.kind === "subsequent" && existing) {
            await turn.cancel();
            deps.pinnedStatus?.setIdle(chatId);
            const dashboard = dashboardUrl(existing.uuid);
            const lines = [
              `✅ Redeployed: https://${existing.fqdn}`,
              ...(dashboard ? [`Coolify dashboard: ${dashboard}`] : []),
            ].join("\n");
            await safeEdit(
              deps.bot,
              chatId,
              placeholderId,
              escapeMarkdownV2(lines),
              deps.log,
              "MarkdownV2",
            );
          } else if (result?.kind === "failed") {
            // Special case: subsequent-deploy got 404 from Coolify, meaning
            // the cached app was deleted (manually or by Coolify cleanup).
            // Clear stale chat-state so next /deploy creates a fresh app.
            if (!isFirst && /^app_not_found:/.test(result.reason)) {
              await turn.cancel();
              deps.state.clearCoolifyApp(chatId, projectPath);
              // Cleared coolify_app → pinned "Deploy" line should disappear.
              deps.pinnedStatus?.notifyStateChange(chatId);
              deps.pinnedStatus?.setFailed(chatId, "Coolify app missing");
              await safeEdit(
                deps.bot,
                chatId,
                placeholderId,
                escapeMarkdownV2(
                  "⚠️ The previous Coolify app was deleted. Cleared cached UUID — run /deploy again to create a fresh one.",
                ),
                deps.log,
                "MarkdownV2",
              );
            } else {
              await turn.showError(result.reason);
              deps.pinnedStatus?.setFailed(chatId, result.reason.slice(0, 80));
            }
          } else {
            // Unparseable reply — let Turn render whatever the agent returned.
            await turn.finalize({ userMessageIds });
            // Treat as Idle: agent finished, just didn't follow the contract.
            deps.pinnedStatus?.setIdle(chatId);
          }
        } catch (err) {
          deps.log?.error?.(
            { chatId, projectPath, isFirst, err: describeError(err) },
            "deploy onIdle handler threw",
          );
        }
        if (!unregistered) {
          unregistered = true;
          unregister();
        }
      },
      async onError(err) {
        const msg = describeError(err);
        try {
          await turn.showError(msg);
        } catch (showErr) {
          deps.log?.error?.(
            { chatId, projectPath, isFirst, err: describeError(showErr) },
            "deploy onError handler threw",
          );
        }
        deps.pinnedStatus?.setFailed(chatId, msg.slice(0, 80));
        if (!unregistered) {
          unregistered = true;
          unregister();
        }
      },
      onPermissionUpdated() {
        // Server policy is `allow` for everything in this bridge.
      },
    });

    // Inherit the chat's selected model so /deploy doesn't silently switch
    // provider behind the user's back. The user reported /deploy auto-using
    // anthropic/claude-sonnet-4-5 (the bridge default) and hitting a token
    // ceiling on that account, even though their normal chat ran on a
    // different provider. stateRow.model is null until the user runs /model
    // — fall through to deps.defaultModel in that case.
    const modelId = stateRow.model ?? deps.defaultModel;
    const model = parseModelId(modelId);
    deps.client
      .prompt(session.id, prompt, {
        ...(model ? { model } : {}),
        directory: projectPath,
      })
      .catch(async (err) => {
        const msg = describeError(err);
        try {
          await turn.showError(`prompt failed: ${msg}`);
        } finally {
          deps.pinnedStatus?.setFailed(chatId, msg.slice(0, 80));
          if (!unregistered) {
            unregistered = true;
            unregister();
          }
        }
      });
  } catch (err) {
    await ctx.reply(escapeMarkdownV2(`❌ /deploy failed: ${describeError(err)}`), {
      parse_mode: "MarkdownV2",
    });
  }
}
