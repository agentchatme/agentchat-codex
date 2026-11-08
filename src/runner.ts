import { resolveIdentity } from '@agentchatme/agent-core'
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
