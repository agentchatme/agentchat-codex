import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { atomicWriteFile, log, readJsonFile } from '@agentchatme/agent-core'
import { buildAgentChatTurnPrompt } from '@agentchatme/agent-core/daemon'
import type { RuntimeAdapter, TurnContext, TurnResult } from '@agentchatme/agent-core/daemon'
import { VERSION } from './version.js'

// ─── Codex adapter ──────────────────────────────────────────────────────────
//
// Drives `codex exec` on the box, riding the user's ChatGPT subscription. The
// user's CODEX_HOME supplies authentication, configuration, rules, tools, and
// permissions. An AgentChat delivery starts a normal Codex turn under those
// same local controls. The integration additionally supplies its normal,
// full-featured AgentChat MCP server with delivery metadata in the prompt.
//
// Empirically load-bearing (verified building the integration): `codex exec`
// HANGS unless stdin is closed → we spawn with stdio.stdin = 'ignore'.

const TURN_TIMEOUT_MS = 240_000
const MAX_EVENT_TAIL_CHARS = 1024 * 1024
export const AGENTCHAT_MCP_PACKAGE = '@agentchatme/mcp@0.1.1121411'
export const MIN_CODEX_VERSION = '0.129.0'
const THREAD_STORE_VERSION = 1

interface CodexThreadStore {
  version: number
  identity_namespace: string
  threads: Record<string, string>
}

export function loadCodexThreads(
  file: string,
  identityNamespace: string,
): Map<string, string> {
  const stored = readJsonFile<CodexThreadStore>(file)
  if (
    !stored ||
    stored.version !== THREAD_STORE_VERSION ||
    stored.identity_namespace !== identityNamespace ||
    typeof stored.threads !== 'object' ||
    stored.threads === null
  ) {
    return new Map()
  }
  return new Map(
    Object.entries(stored.threads).filter(
      ([conversationId, threadId]) =>
        /^(conv|grp)_/.test(conversationId) &&
        typeof threadId === 'string' &&
        threadId.length > 0,
    ),
  )
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function semverAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = value.match(/(\d+)\.(\d+)\.(\d+)/)
    return match
      ? [Number(match[1]), Number(match[2]), Number(match[3])]
      : null
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

export function inspectCodexRuntime(): CodexRuntimeInspection {
  const result = spawnSync('codex', ['--version'], {
    encoding: 'utf-8',
    timeout: 5_000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      detail:
        result.error?.message ??
        `${result.stderr || result.stdout || `exited ${result.status}`}`.trim(),
    }
  }
  const rendered = String(result.stdout || result.stderr).trim()
  return semverAtLeast(rendered, MIN_CODEX_VERSION)
    ? { ok: true, detail: rendered }
    : {
        ok: false,
        detail:
          `${rendered || 'unrecognized version'}; AgentChat requires Codex ` +
          `>= ${MIN_CODEX_VERSION} for trusted lifecycle hooks`,
      }
}

export function turnIdempotencyKey(
  ctx: TurnContext,
  identityNamespace: string,
): string {
  const messageIds = ctx.pendingBatch?.messageIds ?? [ctx.messageId]
  const digest = crypto
    .createHash('sha256')
    .update('agentchat-daemon-turn-v1\0')
    .update(identityNamespace)
    .update('\0')
    .update(ctx.conversationId)
    .update('\0')
    .update(messageIds.join('\0'))
    .digest('hex')
  return `ac_turn_${digest}`
}

function turnConfig(identityHome: string, idempotencyKey: string): string[] {
  const env: Record<string, string> = {
    AGENTCHAT_HOME: identityHome,
    AGENTCHAT_CLIENT_NAME: 'codex',
    AGENTCHAT_CLIENT_VERSION: VERSION,
    AGENTCHAT_TURN_IDEMPOTENCY_KEY: idempotencyKey,
  }
  const config: Array<[string, string]> = [
    ['mcp_servers.agentchat.command', tomlString('npx')],
    [
      'mcp_servers.agentchat.args',
      `[${['-y', AGENTCHAT_MCP_PACKAGE].map(tomlString).join(',')}]`,
    ],
    ['mcp_servers.agentchat.startup_timeout_sec', '30'],
    ['mcp_servers.agentchat.required', 'true'],
    ['mcp_servers.agentchat.default_tools_approval_mode', tomlString('approve')],
    ...Object.entries(env).map(
      ([key, value]) =>
        [`mcp_servers.agentchat.env.${key}`, tomlString(value)] as [string, string],
    ),
  ]
  return config.flatMap(([key, value]) => ['-c', `${key}=${value}`])
}

/** Exported so tests can pin the real autonomous launch contract. */
export function buildCodexArgs(
  ctx: TurnContext,
  identityHome: string,
  workdir: string,
  priorThread?: string,
  idempotencyKey = turnIdempotencyKey(ctx, 'unbound'),
): string[] {
  const prompt = buildPrompt(ctx)
  const common = [
    '--json',
    '--skip-git-repo-check',
    ...turnConfig(identityHome, idempotencyKey),
  ]
  return priorThread
    ? ['exec', 'resume', priorThread, ...common, prompt]
    : ['exec', ...common, '-C', workdir, prompt]
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

function fatalRuntimeError(detail: string): boolean {
  return /not logged in|authentication|unauthorized|invalid api key|login required/i.test(detail)
}

function resultIsError(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false
  const record = result as Record<string, unknown>
  return record['isError'] === true || record['is_error'] === true
}

/**
 * Tracks the part of `codex exec --json` that is delivery-critical. Seeing a
 * tool call start is not success: only its matching item.completed event with
 * status=completed allows the daemon to ACK the inbound batch.
 */
export class CodexTurnEvents {
  threadId: string | undefined
  private readonly pending = new Set<string>()
  private anonymousPending = 0
  private successfulSends = 0
  private failure: string | null = null

  consume(event: unknown): void {
    if (typeof event !== 'object' || event === null) return
    const record = event as Record<string, unknown>
    if (
      record['type'] === 'thread.started' &&
      typeof record['thread_id'] === 'string'
    ) {
      this.threadId = record['thread_id']
    }

    const item = record['item']
    if (typeof item !== 'object' || item === null) return
    const tool = item as Record<string, unknown>
    if (
      tool['type'] !== 'mcp_tool_call' ||
      tool['server'] !== 'agentchat' ||
      tool['tool'] !== 'agentchat_send_message'
    ) {
      return
    }

    const id = typeof tool['id'] === 'string' ? tool['id'] : null
    if (record['type'] === 'item.started') {
      if (id !== null) this.pending.add(id)
      else this.anonymousPending += 1
      return
    }
    if (record['type'] !== 'item.completed') return

    if (id !== null) this.pending.delete(id)
    else this.anonymousPending = Math.max(0, this.anonymousPending - 1)

    if (
      tool['status'] === 'completed' &&
      tool['error'] == null &&
      !resultIsError(tool['result'])
    ) {
      this.successfulSends += 1
    } else {
      const status =
        typeof tool['status'] === 'string' ? tool['status'] : 'missing status'
      this.failure = `AgentChat send did not complete (${status})`
    }
  }

  outcome(): { ok: boolean; sent: boolean; detail?: string } {
    if (this.failure !== null) {
      return { ok: false, sent: this.successfulSends > 0, detail: this.failure }
    }
    const pending = this.pending.size + this.anonymousPending
    if (pending > 0) {
      return {
        ok: false,
        sent: this.successfulSends > 0,
        detail: `${pending} AgentChat send tool call(s) never completed`,
      }
    }
    return { ok: true, sent: this.successfulSends > 0 }
  }
}

export function missingCodexThread(detail: string): boolean {
  return (
    /no (?:conversation|rollout|session|thread).*found/i.test(detail) ||
    /(?:conversation|rollout|session|thread).*(?:not found|does not exist)/i.test(detail) ||
    /unable to (?:find|resume).*(?:conversation|rollout|session|thread)/i.test(detail)
  )
}

export class CodexAdapter implements RuntimeAdapter {
  readonly name = 'codex'
  // conversationId → codex thread_id. Persisted so Codex and Claude both
  // retain per-conversation runtime continuity across daemon restarts.
  private threads = new Map<string, string>()
  private identityNamespace = 'unbound'
  private readonly threadStorePath: string

  constructor(
    private readonly codexHome: string,
    private readonly identityHome: string,
    private readonly workdir: string,
  ) {
    this.threadStorePath = path.join(identityHome, 'daemon-codex-threads.json')
  }

  reset(identityNamespace: string): void {
    this.identityNamespace = identityNamespace
    this.threads = loadCodexThreads(this.threadStorePath, identityNamespace)
  }

  private persistThreads(): void {
    try {
      atomicWriteFile(
        this.threadStorePath,
        `${JSON.stringify({
          version: THREAD_STORE_VERSION,
          identity_namespace: this.identityNamespace,
          threads: Object.fromEntries(this.threads),
        } satisfies CodexThreadStore)}\n`,
        0o600,
      )
    } catch (err) {
      // Continuity is an optimization, not a delivery prerequisite. A
      // read-only identity home falls back to the existing fresh-thread path.
      log.warn(`could not persist Codex conversation threads: ${String(err)}`)
    }
  }

  async preflight(): Promise<{ ok: boolean; detail?: string }> {
    const runtime = inspectCodexRuntime()
    if (!runtime.ok) return { ok: false, detail: runtime.detail }
    const status = spawnSync('codex', ['login', 'status'], {
      encoding: 'utf-8',
      env: { ...process.env, CODEX_HOME: this.codexHome },
    })
    if (status.error || status.status !== 0) {
      const detail = `${status.stdout ?? ''}${status.stderr ?? ''}`.trim()
      return {
        ok: false,
        detail: detail
          ? `codex login status failed: ${detail.slice(0, 200)}`
          : 'codex is not logged in (run `codex login` on this machine)',
      }
    }
    fs.mkdirSync(this.workdir, { recursive: true })
    return { ok: true }
  }

  async runTurn(ctx: TurnContext): Promise<TurnResult> {
    const prior = this.threads.get(ctx.conversationId)
    let result = await this.spawnTurn(ctx, prior)
    if (!result.ok && prior && missingCodexThread(result.detail ?? '')) {
      // Codex may prune its saved transcript while this resident process still
      // remembers the id. Recover inside the same delivery attempt instead of
      // retrying a permanently missing resume target.
      log.info(`codex thread for ${ctx.conversationId} disappeared — recreating`)
      this.threads.delete(ctx.conversationId)
      this.persistThreads()
      result = await this.spawnTurn(ctx)
    }
    return result
  }

  private spawnTurn(ctx: TurnContext, prior?: string): Promise<TurnResult> {
    // `codex exec resume` inherits the original session's working directory and
    // REJECTS -C (it is an `exec`-only flag: passing it fails with exit 2,
    // "unexpected argument '-C'"). So the workdir goes on the FRESH turn only;
    // resumes carry just the shared flags.
    const args = buildCodexArgs(
      ctx,
      this.identityHome,
      this.workdir,
      prior,
      turnIdempotencyKey(ctx, this.identityNamespace),
    )

    return new Promise<TurnResult>((resolve) => {
      let settled = false
      const finish = (result: TurnResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const child = spawn('codex', args, {
        // stdin MUST be closed or codex exec hangs forever waiting on EOF.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CODEX_HOME: this.codexHome,
          AGENTCHAT_LOG_LEVEL: 'silent',
          // If Codex still discovers the integration's trusted user hooks,
          // they must not recursively drain the inbox inside the daemon turn.
          AGENTCHAT_HOOKS_ENABLED: '0',
        },
        detached: process.platform !== 'win32',
      })
      const events = new CodexTurnEvents()
      let stdout = ''
      let stderr = ''
      const consumeLine = (line: string): void => {
        if (!line.trim()) return
        try {
          events.consume(JSON.parse(line))
        } catch {
          /* malformed CLI output is ignored; close status remains authoritative */
        }
      }
      child.stdout.on('data', (d) => {
        stdout += String(d)
        // JSONL chunks can end midway through an event. Parse only complete
        // lines and retain the tail for the next chunk.
        let nl: number
        while ((nl = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, nl)
          stdout = stdout.slice(nl + 1)
          consumeLine(line)
        }
        // A corrupted or counterfeit CLI on PATH must not grow the resident
        // daemon without bound by emitting one unterminated line.
        if (stdout.length > MAX_EVENT_TAIL_CHARS) {
          stdout = stdout.slice(-MAX_EVENT_TAIL_CHARS)
        }
      })
      child.stderr.on('data', (d) => {
        if (stderr.length < 16_384) stderr += String(d).slice(0, 16_384 - stderr.length)
      })

      const killTimer = setTimeout(() => {
        killProcessTree(child)
        finish({ ok: false, detail: 'turn timed out' })
      }, TURN_TIMEOUT_MS)

      child.on('error', (err) => {
        clearTimeout(killTimer)
        finish({ ok: false, fatal: true, detail: `codex spawn failed: ${String(err)}` })
      })

      child.on('close', (code) => {
        clearTimeout(killTimer)
        consumeLine(stdout)
        if (events.threadId && !prior) {
          this.threads.set(ctx.conversationId, events.threadId)
          this.persistThreads()
        }
        // We DISCARD the turn text — the reply (if any) went via the MCP send
        // tool. A clean exit with no send is a deliberate silence, not a
        // failure. Non-zero exit is a real turn failure.
        if (code === 0) {
          const outcome = events.outcome()
          if (!outcome.ok) {
            finish({
              ok: false,
              detail: outcome.detail ?? 'AgentChat send outcome was not successful',
            })
            return
          }
          log.info(`codex turn done for ${ctx.conversationId} (sent=${outcome.sent})`)
          finish({ ok: true, detail: outcome.sent ? 'replied' : 'silent' })
        } else {
          const detail = `codex exited ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`
          finish({ ok: false, fatal: fatalRuntimeError(detail), detail })
        }
      })
    })
  }
}

/** Exported for tests — the first-touch orientation string is the whole point
 *  of the enrichment, so it is worth pinning. */
export function buildPrompt(ctx: TurnContext): string {
  return buildAgentChatTurnPrompt(ctx)
}
