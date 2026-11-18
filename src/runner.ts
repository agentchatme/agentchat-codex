import { manualPointer, PEER_RUN_WARNING, type RunProfile, type RunPreflight, type RunPreflightOptions } from '@agentchatme/agent-core'
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
// An `own` run (the default: the agent itself) runs under the user's own
// config.toml — sandbox, approvals, tools, MCP servers, instructions — with
// nothing of ours but the run's shape and the two pins above; `codex exec`
// answers every approval with "never" itself. Its environment carries no key,
// but Codex's sandboxes never restrict reads, so its shell can read
// `credentials` in the identity home, as in `work` and `full`.
//
// An `answer` run (the lock, an explicit opt-in) has the AgentChat tools and
// nothing else: no shell, no web, no local-file tool, and every other MCP
// server Codex would load switched off for that run — the preset asks
// `codex mcp list --json` which ones (cached until a config file changes).
// The key is then out of the model's reach (no shell to print the
// environment, nothing to read `.env` with); in `own`, `work` and `full` it is
// not.

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
 * served texts are everything it has. `own`, `work` and `full` runs read files
 * (Codex's sandboxes never restrict reads) and get the pointer.
 */
export function runPointer(profile: RunProfile, skill: string): string {
  return profile === 'answer' ? '' : manualPointer(`at ${skill}`)
}

/**
 * What `own` does, in one line: the engine's `ownProfileLine('Codex')`
 * (tests/runner.test.ts holds the two equal once the engine has it).
 */
export const OWN_PROFILE_LINE = 'reply runs use your own Codex permission settings, with anything that would ask refused'

/** The honest sentence after it: the engine's `OWN_RUN_WARNING` (held equal the same way). */
export const OWN_PROFILE_WARNING = "runs started by peers' messages act with those permissions"

/**
 * What a run of `profile` may do, in Codex's terms, for install,
 * `daemon install`, `doctor` and the help. A value that is not a profile is
 * described as `answer`, which is what the engine makes of it.
 */
export function profileSummary(profile: string): string {
  switch (profile) {
    case 'own':
      return `${OWN_PROFILE_LINE}; ${OWN_PROFILE_WARNING}`
    case 'work':
      return `the workspace-write sandbox, never asking; ${PEER_RUN_WARNING}`
    case 'full':
      return `Codex's bypass mode (no sandbox, no approvals); ${PEER_RUN_WARNING}`
    default:
      return 'the AgentChat tools only — no shell, no web, no file tool, no other MCP server'
  }
}

/** ` — <what the profile does>` after a profile name (`profileSummary`). */
export function profileNote(profile: string): string {
  return ` — ${profileSummary(profile)}`
}

/** Whether a run of `profile` never has the home folder or above it as its working root (the engine's fallback folder instead): `own` and `answer`. */
export function guardsHomeWorkdir(profile: string): boolean {
  return profile === 'own' || profile === 'answer'
}
