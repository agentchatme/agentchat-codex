import { manualPointer, resolveIdentity, runProfileWarning, type RunProfile } from '@agentchatme/agent-core'
import { CodexRunner as PresetCodexRunner, type CodexRunnerOptions } from '@agentchatme/agent-core/presets'
import { API_KEY_ENV } from './host.js'

// ─── One headless run of Codex, as THIS integration's agent ─────────────────
//
// How a `codex exec` run is started — its flags per run profile, how Codex is
// found and its sign-in told — is the Codex preset in
// @agentchatme/agent-core/presets, shared with the
// `agentchat listen --preset codex` listener so the two can never drift. What
// is this integration's own is which agent the runs act as: the hosted tools
// reach the run through `[mcp_servers.agentchat]` in `$CODEX_HOME/config.toml`,
// whose bearer token Codex reads from `AGENTCHAT_API_KEY` — loaded from
// `$CODEX_HOME/.env` at startup and, for the daemon's runs, also set on the
// child environment from this integration's identity file, read per run.
//
// An `answer` run (the default, started by any peer's message) has the
// AgentChat tools and nothing else: no shell, no web, no local-file tool, and
// every other MCP server Codex would load switched off for that run — the
// preset asks `codex mcp list --json` which ones (cached until a config file
// changes). The key is then out of the model's reach (no shell to print the
// environment, nothing to read `.env` with); in `work` and `full` it is not.

export { codexIsLoggedIn, inspectCodexRuntime } from '@agentchatme/agent-core/presets'

export interface IntegrationRunnerOptions extends Omit<CodexRunnerOptions, 'apiKey' | 'keyEnv' | 'mcp'> {
  /** The identity home; the key is read from here for each run's environment. */
  readonly identityHome: string
}

/** The preset's runner, keyed from this integration's identity home under the name config.toml names. */
export class CodexRunner extends PresetCodexRunner {
  constructor(options: IntegrationRunnerOptions) {
    const { identityHome, ...rest } = options
    super({ ...rest, apiKey: () => resolveIdentity(identityHome)?.apiKey ?? null, keyEnv: API_KEY_ENV })
  }
}

/**
 * The line a run prompt ends with: where the manual is (the `agentchat`
 * skill). An `answer` run cannot open it — it has no file tool and no web — so
 * its prompt ends with the served instruction alone: the hosted tools and the
 * served texts are everything it has. `work` and `full` runs read files and
 * the web, and get the pointer.
 */
export function runPointer(profile: RunProfile, skill: string): string {
  return profile === 'answer' ? '' : manualPointer(`at ${skill}`)
}

/** ` — <the engine's warning>` after a `work` or `full` profile name (`runProfileWarning`); nothing after `answer`. */
export function profileNote(profile: string): string {
  const warning = runProfileWarning(profile)
  return warning !== null ? ` — ${warning}` : ''
}
