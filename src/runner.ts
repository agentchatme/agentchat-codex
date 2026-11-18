import { manualPointer, runProfileWarning, type RunProfile, type RunPreflight, type RunPreflightOptions } from '@agentchatme/agent-core'
import { CodexRunner as PresetCodexRunner, type CodexRunnerOptions } from '@agentchatme/agent-core/presets'
import { API_KEY_ENV, MCP_SERVER_NAME } from './host.js'
import { headersHelperCommand, headersHelperPathFor, writeHeadersHelper } from './headers-helper.js'

// ─── One headless run of Codex, as THIS integration's agent ─────────────────
//
// How a `codex exec` run is started — its flags per run profile, how Codex is
// found and its sign-in told — is the Codex preset in
// @agentchatme/agent-core/presets, shared with the
// `agentchat listen --preset codex` listener so the two can never drift. What
// is this integration's own is which agent the runs act as: the hosted tools
// reach the run through `[mcp_servers.agentchat]` in `$CODEX_HOME/config.toml`,
// whose Authorization header Codex gets from the headers helper
// (headers-helper.ts), which reads this integration's identity file on each
// connection. No key is in a run's environment: not set by the daemon, and
// any `AGENTCHAT_API_KEY` the daemon inherited is taken out. (Releases up to
// 0.5.2 set it there from the identity file — and Codex's own `.env` load
// overwrote it, so a foreign key in `.env` made the runs another agent.)
//
// The daemon builds the runner per identity and pins, on every run, the
// hosted server's URL (`pinMcpUrl`, `-c mcp_servers.agentchat.url=…`) and the
// helper (`-c mcp_servers.agentchat.http_headers_helper=…`, the identity
// home's): another config layer cannot point the agentchat server, or the
// key, elsewhere.
//
// An `answer` run (the default, started by any peer's message) has the
// AgentChat tools and nothing else: no shell, no web, no local-file tool, and
// every other MCP server Codex would load switched off for that run — the
// preset asks `codex mcp list --json` which ones (cached until a config file
// changes). The key is then out of the model's reach (no shell to print the
// environment, nothing to read `.env` with); in `work` and `full` it is not.

export { codexIsLoggedIn, inspectCodexRuntime } from '@agentchatme/agent-core/presets'

export interface IntegrationRunnerOptions extends Omit<CodexRunnerOptions, 'apiKey' | 'keyEnv' | 'mcp'> {
  /** The identity home: the headers helper reads the key from its `credentials` when a run connects. */
  readonly identityHome: string
}

/** The preset's runner, authenticated by this integration's identity home through the headers helper; no key in the run's environment. */
export class CodexRunner extends PresetCodexRunner {
  private readonly identityHome: string
  private readonly helper: string | null

  constructor(options: IntegrationRunnerOptions) {
    const { identityHome, ...rest } = options
    super({ ...rest, apiKey: () => null, keyEnv: API_KEY_ENV })
    this.identityHome = identityHome
    this.helper = headersHelperCommand(headersHelperPathFor(identityHome))
  }

  /** The preset's argv with the identity home's helper pinned before the prompt (which stays last). */
  override args(): string[] {
    const args = super.args()
    if (this.helper === null) return args
    return [...args.slice(0, -1), '-c', `mcp_servers.${MCP_SERVER_NAME}.http_headers_helper=${JSON.stringify(this.helper)}`, args[args.length - 1]!]
  }

  /** The preset's environment without any `AGENTCHAT_API_KEY`: the key reaches a run through the helper only. */
  override env(): NodeJS.ProcessEnv {
    const env = super.env()
    delete env[API_KEY_ENV]
    return env
  }

  /** The helper is there (written when missing or not this release's) before the preset's own gate. */
  override async preflight(options: RunPreflightOptions = {}): Promise<RunPreflight> {
    if (this.helper === null) return { ok: false, detail: `the path of Node (${process.execPath}) or of ${headersHelperPathFor(this.identityHome)} holds a character a shell command cannot carry quoted` }
    try {
      writeHeadersHelper(this.identityHome)
    } catch (err) {
      return { ok: false, detail: `could not write the headers helper ${headersHelperPathFor(this.identityHome)}: ${String(err)}` }
    }
    return super.preflight(options)
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
