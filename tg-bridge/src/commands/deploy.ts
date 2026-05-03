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
  log?: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Build the deterministic prompt for first-time deploy of a project.
 *
 * Pushes pending commits, then POSTs to Coolify to create a private-GitHub-app
 * application (Coolify auto-deploys). Parses the response with `jq` and
 * echoes `deployed:$APP_UUID:$FQDN` for the bridge to parse + persist.
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
    `  "instant_deploy": true`,
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
    `curl -sf -X GET "$COOLIFY_URL/api/v1/deploy?uuid=${appUuid}" -H "Authorization: Bearer $COOLIFY_TOKEN"`,
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
    const session = await deps.client.createSession(`tg:deploy:${projectPath}`, {
      directory: projectPath,
    });

    const turn = new Turn(deps.bot, chatId, placeholderId);
    const collected: IncomingPart[] = [];
    let unregistered = false;
    const unregister = deps.router.registerSession(session.id, {
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
            const dashboard = dashboardUrl(result.uuid);
            const lines = [
              `✅ Deployed: https://${result.fqdn}`,
              ...(dashboard ? [`Coolify dashboard: ${dashboard}`] : []),
            ].join("\n");
            await safeEdit(deps.bot, chatId, placeholderId, escapeMarkdownV2(lines), deps.log);
          } else if (result?.kind === "subsequent" && existing) {
            await turn.cancel();
            const dashboard = dashboardUrl(existing.uuid);
            const lines = [
              `✅ Redeployed: https://${existing.fqdn}`,
              ...(dashboard ? [`Coolify dashboard: ${dashboard}`] : []),
            ].join("\n");
            await safeEdit(deps.bot, chatId, placeholderId, escapeMarkdownV2(lines), deps.log);
          } else if (result?.kind === "failed") {
            await turn.showError(result.reason);
          } else {
            // Unparseable reply — let Turn render whatever the agent returned.
            await turn.finalize();
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
        try {
          await turn.showError(describeError(err));
        } catch (showErr) {
          deps.log?.error?.(
            { chatId, projectPath, isFirst, err: describeError(showErr) },
            "deploy onError handler threw",
          );
        }
        if (!unregistered) {
          unregistered = true;
          unregister();
        }
      },
      onPermissionUpdated() {
        // Server policy is `allow` for everything in this bridge.
      },
    });

    const model = parseModelId(deps.defaultModel);
    deps.client
      .prompt(session.id, prompt, {
        ...(model ? { model } : {}),
        directory: projectPath,
      })
      .catch(async (err) => {
        try {
          await turn.showError(`prompt failed: ${describeError(err)}`);
        } finally {
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
