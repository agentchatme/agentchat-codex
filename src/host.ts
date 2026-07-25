import * as os from 'node:os'
import * as path from 'node:path'

// ─── The only file in this repo that knows a host exists ────────────────────
//
// Everything host-specific about the Codex integration is here: where the
// identity lives, which file carries the anchor, what this command is called.
// The rest of the package reads these constants; @agentchatme/agent-core knows
// none of them.
//
// There is deliberately no `--platform` flag anywhere in this package, and no
// host detection. This binary acts on the Codex agent because that is what it
// IS, not because of a runtime argument — so "acted on the wrong agent" is not
// a bug that can be written here. The predecessor to this design was one CLI
// serving every coding agent, whose commands had to choose a host; they chose
// wrong, and users lost credentials and wiring for agents they never named.

/** Codex's config root. Honouring CODEX_HOME matters: users relocate it, and
 *  the MCP server, hooks and anchor must all agree on one place. */
export function codexHome(): string {
  const override = process.env['CODEX_HOME']
  if (override !== undefined && override.trim().length > 0) return path.resolve(override)
  return path.join(os.homedir(), '.codex')
}

/** THE identity home for this agent. Passed into every agent-core call. */
export function identityHome(): string {
  return path.join(codexHome(), 'agentchat')
}

/** Codex's always-loaded instruction file — its skills are on-demand and may
 *  never trigger, so identity + condensed etiquette live here instead. */
export function anchorFile(): string {
  return path.join(codexHome(), 'AGENTS.md')
}

export const LABEL = 'Codex'

/** The service/unit name for this integration's always-on daemon. Unique per
 *  integration so a user's Codex and Claude Code daemons coexist. */
export const SERVICE_LABEL = 'agentchatd-codex'

/**
 * Exactly what a user types to reach this integration, used verbatim in every
 * hint we print. Someone who ran `npx -y @agentchatme/codex` has no global
 * `agentchat` binary, so telling them to run one would be a dead end.
 * Overridable for the bundled-binary case (hooks invoke an absolute path).
 */
export function invocation(): string {
  const override = process.env['AGENTCHAT_CLI_NAME']?.trim()
  if (override !== undefined && override.length > 0) return override
  return 'npx -y @agentchatme/codex'
}

export function hostCopy(): { invoke: string; label: string } {
  return { invoke: invocation(), label: LABEL }
}

/** Env the always-on service must inherit — a systemd/launchd unit does not
 *  get the login shell, and the adapter shells out to `codex`. */
export function serviceEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const codexHomeEnv = process.env['CODEX_HOME']
  if (codexHomeEnv !== undefined && codexHomeEnv.trim().length > 0) env['CODEX_HOME'] = codexHomeEnv
  return env
}
