import * as os from 'node:os'
import * as path from 'node:path'
import { MANUAL_FILENAME, MANUAL_SKILL_NAME, serviceLabelFor } from '@agentchatme/agent-core'

// ─── The only file in this repo that knows a host exists ────────────────────
//
// Everything host-specific about the Codex doorbell is here: where the
// identity lives, which file carries the identity line, where Codex keeps
// skills, config and its `.env`. The rest of the package reads these;
// @agentchatme/agent-core knows none of them.
//
// There is deliberately no `--platform` flag anywhere in this package, and no
// host detection. This binary acts on the Codex agent because that is what it
// IS, not because of a runtime argument.

/** Codex's config root. Honouring CODEX_HOME matters: users relocate it. */
export function codexHome(): string {
  const override = process.env['CODEX_HOME']
  if (override !== undefined && override.trim().length > 0) return path.resolve(override)
  return path.join(os.homedir(), '.codex')
}

/** THE identity home for this agent. Passed into every agent-core call. */
export function identityHome(): string {
  return path.join(codexHome(), 'agentchat')
}

/** Codex's always-loaded instruction file: the identity line goes here. */
export function anchorFile(): string {
  return path.join(codexHome(), 'AGENTS.md')
}

export function configPath(): string {
  return path.join(codexHome(), 'config.toml')
}

/** Pre-doorbell releases wrote lifecycle hooks here; upgrades remove them. */
export function hooksPath(): string {
  return path.join(codexHome(), 'hooks.json')
}

/**
 * Codex loads environment variables from `$CODEX_HOME/.env` at startup
 * (codex-rs/arg0: `load_dotenv`, every variable except `CODEX_*`). The key
 * lives here and `config.toml` names it by variable (`bearer_token_env_var`),
 * so the key never lands in `config.toml`.
 */
export function dotEnvPath(): string {
  return path.join(codexHome(), '.env')
}

/** Codex skills: `$CODEX_HOME/skills/<name>/SKILL.md` (codex-rs/skills: `SKILLS_DIR_NAME = "skills"`). */
export function skillsDir(): string {
  return path.join(codexHome(), 'skills')
}

export function skillDir(): string {
  return path.join(skillsDir(), MANUAL_SKILL_NAME)
}

export function skillPath(): string {
  return path.join(skillDir(), MANUAL_FILENAME)
}

export const LABEL = 'Codex'

/** The service label of the default config (`~/.codex`) — the label every install before per-home labels used. */
export const SERVICE_BASE_LABEL = 'agentchatd-codex'

/**
 * The doorbell service's label for THIS config. `launchctl` / `systemctl
 * --user` address the user's domain whatever HOME or CODEX_HOME say, so a
 * relocated CODEX_HOME gets its own label (`agentchatd-codex-<8 hex>`) and can
 * never address the default config's service; `~/.codex` keeps the plain
 * label, so existing installs keep working.
 */
export function serviceLabel(): string {
  return serviceLabelFor(SERVICE_BASE_LABEL, identityHome(), path.join(os.homedir(), '.codex', 'agentchat'))
}

/** Labels this config's service replaces: a relocated CODEX_HOME was installed under the plain label before. */
export function supersededServiceLabels(): string[] {
  return serviceLabel() === SERVICE_BASE_LABEL ? [] : [SERVICE_BASE_LABEL]
}

/**
 * The `[mcp_servers.<name>]` table name. Changing it changes every tool name
 * the model sees (`mcp__agentchat__agentchat_inbox`) — keep in lockstep with
 * the prompts the daemon builds.
 */
export const MCP_SERVER_NAME = 'agentchat'

/** The variable `config.toml` names for the bearer token, and the `.env` line's key. */
export const API_KEY_ENV = 'AGENTCHAT_API_KEY'

/** Exactly what a user types to reach this integration. */
export function invocation(): string {
  const override = process.env['AGENTCHAT_CLI_NAME']?.trim()
  if (override !== undefined && override.length > 0) return override
  return 'npx -y @agentchatme/codex'
}

export function hostCopy(): { invoke: string; label: string } {
  return { invoke: invocation(), label: LABEL }
}

/**
 * Env the service must see. A launchd/systemd service does NOT inherit the
 * login shell, so the doorbell's switches are captured at install time:
 * `AGENTCHAT_RUN_PROFILE=work npx -y @agentchatme/codex daemon install`.
 */
export function serviceEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const codexHomeEnv = process.env['CODEX_HOME']?.trim()
  if (codexHomeEnv !== undefined && codexHomeEnv.length > 0) env['CODEX_HOME'] = codexHomeEnv
  for (const key of ['AGENTCHAT_RUN_PROFILE', 'AGENTCHAT_DOORBELL', 'AGENTCHAT_RUN_BUDGET_MS', 'AGENTCHAT_RUN_CWD', 'AGENTCHAT_API_BASE']) {
    const value = process.env[key]?.trim()
    if (value !== undefined && value.length > 0) env[key] = value
  }
  return env
}
