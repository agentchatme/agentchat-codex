import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  alwaysOnOptedOut,
  alwaysOnState,
  alwaysOnWanted,
  createIdentityCommands,
  readAlwaysOnInstalledVersion,
  readCredentials,
  recordOfferDeclined,
  clearOfferDeclined,
  renderDeclinedBlock,
  serviceDefinitionCurrent,
  serviceInstalled,
  writeAnchor,
  type DoctorCheck,
  type DoctorOpts,
  type HostProfile,
} from '@agentchatme/agent-core'
import {
  identityHome,
  codexHome,
  anchorFile,
  invocation,
  LABEL,
  SERVICE_LABEL,
  serviceEnv,
} from './host.js'
import {
  renderCodexAgents,
  isCodexWired,
  codexHooksPath,
  installCodex,
  stableBundlePath,
  stableDaemonPath,
} from './wiring.js'
import {
  AGENTCHAT_MCP_PACKAGE,
  inspectCodexRuntime,
} from './adapter.js'
import { ensureAlwaysOn } from './always-on.js'
import { VERSION } from './version.js'

// ─── This agent, described once ─────────────────────────────────────────────
//
// register / login / recover / status / logout / doctor are a contract with the
// AgentChat server — the pending-state machine, the error vocabulary, what a
// credential file holds — so the flows live in @agentchatme/agent-core and this
// file only says which agent they act on, plus what is genuinely different
// about Codex: it wires ITSELF into config.toml and hooks.json, so it has
// wiring to check. Explicit uninstallation owns teardown; signing out does not.
//
// It used to be ~515 lines here and ~510 in the Claude Code integration, 94%
// identical, and already drifting.
//
// Sharing the flow does not weaken the guarantee. A profile can only describe
// its OWN agent — there is no field naming another host, and nothing here reads
// a `--platform`. The commands built from it can reach exactly one home.

const profile: HostProfile = {
  label: LABEL,
  id: 'codex',
  home: identityHome,
  anchorFile,
  invocation,
  renderAnchor: renderCodexAgents,
  // Anchoring identity into AGENTS.md only makes sense once the MCP server and
  // hooks exist; otherwise the agent is told it has a phone number with nothing
  // to answer it.
  isWired: isCodexWired,
  extraDoctorChecks: (opts): DoctorCheck[] => [
    ...runtimeChecks(),
    wiringCheck(opts.fix === true),
    alwaysOnCheck(opts.fix === true),
  ],
}

function concise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180)
}

function runtimeChecks(): DoctorCheck[] {
  const npx = spawnSync('npx', ['--version'], {
    encoding: 'utf-8',
    timeout: 5_000,
    windowsHide: true,
  })
  const mcpRunner: DoctorCheck = {
    name: 'mcp-runner',
    verdict: !npx.error && npx.status === 0 ? 'PASS' : 'FAIL',
    detail:
      !npx.error && npx.status === 0
        ? `npx ${concise(npx.stdout || npx.stderr)}`
        : npx.error?.message ?? `npx exited ${npx.status}`,
  }
  const runtime = inspectCodexRuntime()
  if (!runtime.ok) {
    return [
      {
        name: 'codex-cli',
        verdict: 'FAIL',
        detail: runtime.detail,
      },
      { name: 'codex-auth', verdict: 'FAIL', detail: 'cannot check until the Codex CLI works' },
      mcpRunner,
    ]
  }

  const auth = spawnSync('codex', ['login', 'status'], {
    encoding: 'utf-8',
    timeout: 5_000,
    windowsHide: true,
  })
  return [
    {
      name: 'codex-cli',
      verdict: 'PASS',
      detail: runtime.detail,
    },
    {
      name: 'codex-auth',
      verdict: auth.status === 0 ? 'PASS' : 'FAIL',
      detail:
        auth.status === 0
          ? 'Codex CLI is authenticated for autonomous turns'
          : concise(auth.stderr || auth.stdout) || `login status exited ${auth.status}`,
    },
    mcpRunner,
  ]
}

function wiringCheck(fix: boolean): DoctorCheck {
  const current = (): boolean => isCodexWired()

  if (fix && !current()) {
    try {
      installCodex(readCredentials(identityHome())?.handle ?? null)
    } catch (err) {
      return { name: 'wiring', verdict: 'FAIL', detail: `repair failed: ${String(err)}` }
    }
  }
  return current()
    ? {
        name: 'wiring',
        verdict: 'PASS',
        detail: `current MCP (${AGENTCHAT_MCP_PACKAGE}), hooks, bundle and manual`,
      }
    : {
        name: 'wiring',
        verdict: 'WARN',
        detail: `missing or stale — run \`${invocation()}${fix ? '' : ' doctor --fix'}\``,
      }
}

function alwaysOnCheck(fix: boolean): DoctorCheck {
  const home = identityHome()
  if (alwaysOnOptedOut(home)) {
    return { name: 'always-on', verdict: 'PASS', detail: 'disabled by the user' }
  }

  const service = {
    label: SERVICE_LABEL,
    home,
    entry: stableDaemonPath(),
    env: serviceEnv(),
  }
  const current = (): boolean =>
    alwaysOnWanted(home) &&
    fs.existsSync(service.entry) &&
    readAlwaysOnInstalledVersion(home) === VERSION &&
    serviceInstalled(service) &&
    serviceDefinitionCurrent(service)

  if (fix && isCodexWired() && !current()) {
    const repaired = ensureAlwaysOn()
    if (!repaired.ok) {
      return {
        name: 'always-on',
        verdict: 'FAIL',
        detail: `repair failed: ${repaired.detail ?? 'unknown error'}`,
      }
    }
  }
  if (!current()) {
    return {
      name: 'always-on',
      verdict: isCodexWired() ? 'FAIL' : 'WARN',
      detail: `service, durable bundle or version marker is missing/stale — run \`${invocation()} doctor --fix\``,
    }
  }

  const state = alwaysOnState(home)
  return {
    name: 'always-on',
    verdict: state === 'down' ? 'FAIL' : 'PASS',
    detail: `${state}; service definition and daemon bundle match ${VERSION}`,
  }
}

/**
 * Is Codex actually going to RUN the hooks we wrote?
 *
 * Codex requires every command hook to be reviewed and trusted before it runs,
 * and treats new or CHANGED hooks as untrusted — it records trust as a
 * `[hooks.state."<hooks.json>:<event>:<group>:<handler>"]` entry in config.toml.
 * Until the user approves ours in Codex's own review UI (startup review when
 * offered, `/hooks` as the fallback), all four are SKIPPED: no setup offer, no
 * inbox digest, no mid-task pickup, no delivery acks. Silently.
 *
 * `doctor` used to report everything green while that was true because it only
 * searched config.toml for a trust-state key. That misses changed definitions
 * whose old key remains. The current check asks Codex's read-only hooks/list
 * API for the effective currentHash/trustStatus instead.
 */
interface ListedHook {
  eventName?: unknown
  command?: unknown
  sourcePath?: unknown
  enabled?: unknown
  trustStatus?: unknown
}

export function hookTrustFromList(payload: unknown): DoctorCheck {
  const hooksPath = codexHooksPath()
  if (!fs.existsSync(hooksPath)) {
    return { name: 'hook-trust', verdict: 'WARN', detail: `no hooks.json — run \`${invocation()}\`` }
  }

  const result = payload as
    | { data?: Array<{ hooks?: ListedHook[]; warnings?: string[]; errors?: unknown[] }> }
    | undefined
  const entry = result?.data?.[0]
  if (!entry || !Array.isArray(entry.hooks)) {
    return {
      name: 'hook-trust',
      verdict: 'WARN',
      detail:
        'Codex did not return a readable hook inventory; verify AgentChat in ' +
        'Codex’s hook review (`/hooks` if it is not offered at startup)',
    }
  }

  const canonical = (candidate: string): string => {
    try {
      return fs.realpathSync.native(candidate)
    } catch {
      return path.resolve(candidate)
    }
  }
  const normalizedHooksPath = canonical(hooksPath)
  const normalizedBundlePath = canonical(stableBundlePath())
  const ours = entry.hooks.filter(
    (hook) => {
      if (
        typeof hook.sourcePath !== 'string' ||
        canonical(hook.sourcePath) !== normalizedHooksPath ||
        typeof hook.command !== 'string'
      ) {
        return false
      }
      const match = hook.command.match(/^node "(.+)" hook (?:session-start|user-prompt|stop|session-end)$/)
      return match?.[1] !== undefined && canonical(match[1]) === normalizedBundlePath
    },
  )
  const expected = new Set([
    'sessionStart',
    'userPromptSubmit',
    'stop',
    'sessionEnd',
  ])
  const normalizeEventName = (value: string): string => {
    const compact = value.replace(/[_-]/g, '').toLowerCase()
    if (compact === 'sessionstart') return 'sessionStart'
    if (compact === 'userpromptsubmit') return 'userPromptSubmit'
    if (compact === 'sessionend') return 'sessionEnd'
    if (compact === 'stop') return 'stop'
    return value
  }
  const byEvent = new Map(
    ours
      .filter(
        (hook): hook is ListedHook & { eventName: string } =>
          typeof hook.eventName === 'string',
      )
      .map((hook) => [normalizeEventName(hook.eventName), hook]),
  )
  const missing = [...expected].filter((event) => !byEvent.has(event))
  if (missing.length > 0) {
    return {
      name: 'hook-trust',
      verdict: 'WARN',
      detail:
        `${missing.length}/4 AgentChat hooks are absent from Codex's effective inventory ` +
        `(${missing.join(', ')}) — run \`${invocation()} doctor --fix\`, then approve them ` +
        'in Codex’s hook review (`/hooks` if Codex does not offer the review at startup)',
    }
  }

  const disabled = [...expected].filter(
    (event) => byEvent.get(event)?.enabled !== true,
  )
  const untrusted = [...expected].filter((event) => {
    const status = byEvent.get(event)?.trustStatus
    return status !== 'trusted' && status !== 'managed'
  })
  if (disabled.length === 0 && untrusted.length === 0) {
    return {
      name: 'hook-trust',
      verdict: 'PASS',
      detail: 'all four current AgentChat hook definitions are enabled and trusted',
    }
  }
  return {
    name: 'hook-trust',
    verdict: 'WARN',
    detail:
      `${untrusted.length} untrusted/changed, ${disabled.length} disabled — approve the ` +
      'AgentChat hooks in Codex’s review (`/hooks` if it is not offered at startup). ' +
      'Until then lifecycle delivery is inactive.',
  }
}

/**
 * Ask Codex itself for effective hook hashes/trust. Reading config.toml text
 * cannot detect a changed hook whose stale trusted_hash is still present.
 */
export async function inspectHookTrust(): Promise<DoctorCheck> {
  return new Promise<DoctorCheck>((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const child = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: codexHome() },
    })

    const finish = (check: DoctorCheck): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.stdin.end()
        child.kill()
      } catch {
        /* already closed */
      }
      resolve(check)
    }
    const fail = (detail: string): void =>
      finish({
        name: 'hook-trust',
        verdict: 'WARN',
        detail:
          `${detail}; verify AgentChat in Codex’s hook review ` +
          '(`/hooks` if it is not offered at startup)',
      })
    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    const consume = (line: string): void => {
      if (!line.trim()) return
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (message['id'] === 1) {
        if (message['error'] !== undefined) {
          fail('Codex app-server initialization failed')
          return
        }
        send({ method: 'initialized', params: {} })
        send({
          method: 'hooks/list',
          id: 2,
          params: { cwds: [process.cwd()] },
        })
      } else if (message['id'] === 2) {
        if (message['error'] !== undefined) {
          fail('this Codex version could not inspect hook trust')
          return
        }
        finish(hookTrustFromList(message['result']))
      }
    }

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      let newline: number
      while ((newline = stdout.indexOf('\n')) >= 0) {
        consume(stdout.slice(0, newline))
        stdout = stdout.slice(newline + 1)
      }
      if (stdout.length > 1_048_576) stdout = stdout.slice(-1_048_576)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 1_000) {
        stderr += String(chunk).slice(0, 1_000 - stderr.length)
      }
    })
    child.on('error', (err) => fail(`could not start Codex app-server: ${err.message}`))
    child.on('close', () => {
      consume(stdout)
      if (!settled) {
        fail(
          concise(stderr) ||
            'Codex app-server closed before returning the hook inventory',
        )
      }
    })

    const timer = setTimeout(
      () => fail('Codex hook inspection timed out'),
      8_000,
    )
    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'agentchat_doctor',
          title: 'AgentChat doctor',
          version: VERSION,
        },
      },
    })
  })
}

const commands = createIdentityCommands(profile)

/**
 * Record "not now" and stop asking.
 *
 * The setup offer lives in AGENTS.md because Codex's hook trust means the
 * session-start hook may never fire. Static instruction text has no memory, so
 * without this an agent re-reads the offer and raises it every single session —
 * trading a silent failure for a nag. This persists the answer and rewrites the
 * block to a variant that states the fact and instructs nothing.
 */
export function runNotNow(): number {
  const home = identityHome()
  recordOfferDeclined(home)
  try {
    writeAnchor(anchorFile(), renderDeclinedBlock({ invoke: invocation(), label: LABEL }))
  } catch (err) {
    console.error(`Recorded, but could not update ${path.basename(anchorFile())}: ${String(err)}`)
    return 1
  }
  console.log(
    [
      `Noted — ${LABEL} will not ask about AgentChat again.`,
      `Changed your mind? ${invocation()} register --email <email> --handle <handle>`,
    ].join('\n'),
  )
  return 0
}

export const { runRegister, runLogin, runRecover, runStatus, runLogout } = commands

export async function runDoctor(opts: DoctorOpts = {}): Promise<number> {
  const base = await commands.runDoctor(opts)
  const trust = await inspectHookTrust()
  console.log(`${trust.verdict.padEnd(4)} ${trust.name}: ${trust.detail}`)
  return base !== 0 || trust.verdict === 'FAIL' ? 1 : 0
}

export type { RegisterOpts, DoctorOpts } from '@agentchatme/agent-core'
