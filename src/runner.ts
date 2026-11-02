import * as fs from 'node:fs'
import { log, resolveIdentity, spawnCommandSync, type RunProfile } from '@agentchatme/agent-core'
import { spawnRun, type RunOutcome, type RunRequest, type RunRunner } from '@agentchatme/agent-core/daemon'
import { API_KEY_ENV } from './host.js'
import { MIN_CODEX_VERSION, codexRunArgs } from './profile.js'

// ─── One headless run of Codex ──────────────────────────────────────────────
//
// `codex exec` on the box, riding the user's own Codex sign-in and config. The
// hosted AgentChat tools reach the run through `[mcp_servers.agentchat]` in
// `$CODEX_HOME/config.toml`, whose bearer token Codex reads from
// `AGENTCHAT_API_KEY` — loaded from `$CODEX_HOME/.env` at startup and, for the
// daemon's runs, also set on the child environment from the identity file. The
// run's output is discarded by `spawnRun`.

function semverAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = value.match(/(\d+)\.(\d+)\.(\d+)/)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
  }
  const a = parse(actual)
  const b = parse(minimum)
  if (a === null || b === null) return false
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return (a[index] ?? 0) > (b[index] ?? 0)
  }
  return true
}

export interface CodexRuntimeInspection {
  ok: boolean
  detail: string
}

export function inspectCodexRuntime(codexHome: string, command = 'codex'): CodexRuntimeInspection {
  const result = spawnCommandSync(command, ['--version'], {
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHome },
  })
  if (result.error) return { ok: false, detail: `codex CLI not found on PATH (${result.error.message})` }
  const rendered = String(result.stdout || result.stderr).trim()
  if (result.status !== 0) return { ok: false, detail: rendered || `codex --version exited ${result.status}` }
  return semverAtLeast(rendered, MIN_CODEX_VERSION)
    ? { ok: true, detail: rendered }
    : { ok: false, detail: `${rendered || 'unrecognized version'}; AgentChat requires Codex >= ${MIN_CODEX_VERSION}` }
}

/** `codex login status` exits 0 when signed in. */
export function codexIsLoggedIn(codexHome: string, command = 'codex'): { ok: boolean; detail: string } {
  const status = spawnCommandSync(command, ['login', 'status'], {
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHome },
  })
  if (status.error) return { ok: false, detail: status.error.message }
  const detail = `${status.stdout ?? ''}${status.stderr ?? ''}`.trim().slice(0, 200)
  return status.status === 0 ? { ok: true, detail: detail || 'signed in' } : { ok: false, detail: detail || 'codex is not signed in (run `codex login`)' }
}

export interface CodexRunnerOptions {
  readonly codexHome: string
  /** The identity home; the key is read from here for the child's environment. */
  readonly identityHome: string
  /** The run's working root (`-C`); the `work` profile may write here. */
  readonly workdir: string
  readonly profile: RunProfile
  /** Test seam: the binary to run. */
  readonly command?: string
  readonly env?: NodeJS.ProcessEnv
}

export class CodexRunner implements RunRunner {
  readonly name = 'codex'
  private readonly command: string

  constructor(private readonly options: CodexRunnerOptions) {
    this.command = options.command ?? 'codex'
  }

  async preflight() {
    const runtime = inspectCodexRuntime(this.options.codexHome, this.command)
    if (!runtime.ok) return { ok: false, detail: runtime.detail }
    const auth = codexIsLoggedIn(this.options.codexHome, this.command)
    if (!auth.ok) return { ok: false, detail: `codex login status failed: ${auth.detail}` }
    fs.mkdirSync(this.options.workdir, { recursive: true })
    return { ok: true }
  }

  /** The exact argv one run uses — exported for tests to pin per profile. */
  args(prompt: string): string[] {
    return codexRunArgs(this.options.profile, { workdir: this.options.workdir, prompt })
  }

  /** The child environment: Codex's home, the key the hosted server needs, and nothing of ours otherwise. */
  env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), CODEX_HOME: this.options.codexHome }
    const identity = resolveIdentity(this.options.identityHome)
    if (identity !== null) env[API_KEY_ENV] = identity.apiKey
    return env
  }

  async start(request: RunRequest): Promise<RunOutcome> {
    const args = this.args(request.prompt)
    log.debug(`codex ${args.slice(0, -1).join(' ')} <prompt> (${request.kind} run ${request.runId})`)
    return spawnRun({
      command: this.command,
      args,
      cwd: this.options.workdir,
      env: this.env(),
      // stdin MUST be closed or codex exec waits for EOF forever.
      stdin: null,
      budgetMs: request.budgetMs,
    })
  }
}
