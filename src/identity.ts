import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
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
  type HostProfile,
} from '@agentchatme/agent-core'
import {
  identityHome,
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
  codexConfigPath,
  installCodex,
  manualPath,
  stableBundlePath,
  stableDaemonPath,
} from './wiring.js'
import { AGENTCHAT_MCP_PACKAGE } from './adapter.js'
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
    hookTrustCheck(),
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
  const version = spawnSync('codex', ['--version'], {
    encoding: 'utf-8',
    timeout: 5_000,
    windowsHide: true,
  })
  if (version.error || version.status !== 0) {
    return [
      {
        name: 'codex-cli',
        verdict: 'FAIL',
        detail: version.error ? `unavailable: ${version.error.message}` : `exited ${version.status}`,
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
      detail: concise(version.stdout || version.stderr) || 'available',
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
  const current = (): boolean => {
    try {
      const config = fs.readFileSync(codexConfigPath(), 'utf-8')
      return (
        isCodexWired() &&
        config.includes(AGENTCHAT_MCP_PACKAGE) &&
        config.includes('required = true') &&
        config.includes('agentchat_get_conversation') &&
        config.includes('agentchat_send_message') &&
        fs.existsSync(codexHooksPath()) &&
        fs.existsSync(stableBundlePath()) &&
        fs.existsSync(manualPath())
      )
    } catch {
      return false
    }
  }

  if (fix && !current()) {
    try {
      installCodex(process.argv[1] ?? '', readCredentials(identityHome())?.handle ?? null)
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
 * Until the user runs `/hooks` and approves ours, all three are SKIPPED: no
 * setup offer, no inbox digest, no mid-task pickup, no delivery acks. Silently.
 *
 * `doctor` reported everything green while that was true, which is how it went
 * unnoticed. It cannot verify the HASH (the algorithm is Codex's, undocumented)
 * — but presence versus absence is exactly the fresh-install case, and that is
 * the one that was biting people.
 */
function hookTrustCheck(): DoctorCheck {
  const hooksPath = codexHooksPath()
  if (!fs.existsSync(hooksPath)) {
    return { name: 'hook-trust', verdict: 'WARN', detail: `no hooks.json — run \`${invocation()}\`` }
  }
  let cfg = ''
  try {
    cfg = fs.readFileSync(codexConfigPath(), 'utf-8')
  } catch {
    /* treated as untrusted below */
  }
  // Codex keys trust on the hooks.json path plus the snake_case event name.
  const events = ['session_start', 'user_prompt_submit', 'stop']
  const missing = events.filter((e) => !cfg.includes(`${hooksPath}:${e}`))
  if (missing.length === 0) {
    return { name: 'hook-trust', verdict: 'PASS', detail: 'Codex has trusted the AgentChat hooks' }
  }
  return {
    name: 'hook-trust',
    verdict: 'WARN',
    detail:
      `${missing.length}/3 hooks not trusted by Codex yet — run \`/hooks\` in Codex and approve them. ` +
      'Until then there is no inbox digest, no mid-task pickup and no delivery acks.',
  }
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

export const { runRegister, runLogin, runRecover, runStatus, runLogout, runDoctor } = commands

export type { RegisterOpts, DoctorOpts } from '@agentchatme/agent-core'
