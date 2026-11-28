import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import {
  alwaysOnState,
  daemonPidOf,
  clearAlwaysOnWanted,
  clearAlwaysOnOptOut,
  clearIntegrationStatus,
  describeListenerStopped,
  INTEGRATION_ENV,
  INTEGRATION_ENV_LEGACY,
  INTEGRATION_ENV_LEGACY_REMOVAL,
  integrationDisabled,
  integrationDisabledBy,
  formatIntegrationStatus,
  markAlwaysOnOptOut,
  readCredentials,
  readIntegrationStatus,
  reportListenerStopped,
  resolveRunProfile,
  PEER_RUN_WARNING,
  serviceStatus,
  clearInstallId,
  HOST_FILE,
} from '@agentchatme/agent-core'
import { CLIENT, codexHome, identityHome, invocation, serviceLabel, LABEL } from './host.js'
import { formatPlacement, placeAll, placementProblemOf, removePlacement } from './placement.js'
import { confirmSetup, currentServedPlacement, listenerEnsureOf, reportSetup, runRegister, runLogin, runRecover, runStatus, runLogout, runDoctor, runNotNow } from './identity.js'
import { inspectCodexRuntime, OWN_PROFILE_LINE, OWN_PROFILE_WARNING, profileNote, profileSummary } from './runner.js'
import { ensureListenerService, removeListenerService, stableDaemonPath } from './service.js'
import { VERSION } from './version.js'
import { homeIdentity } from './home-identity.js'

// The switch names and the day the previous one stops being read are
// agent-core's (contract v1, section 7), so this text cannot outlive the reader.
const USAGE = `agentchat-codex ${VERSION} — the AgentChat integration for Codex

Usage:
  ${invocation()}                                  install: place the served manual, the hosted tools, the identity line; register the integration service
  ${invocation()} register --email <e> --handle <h>
  ${invocation()} register --code <6-digit-code>
  ${invocation()} register --not-now                stop offering to set this up
  ${invocation()} login --api-key - < <file>      already have an account: the key from a file on stdin (in a terminal: login, then paste it)
  ${invocation()} recover --handle <h> --email <e>  lost your key (rotates it; --handle defaults to yours)
  ${invocation()} recover --code <6-digit-code>
  ${invocation()} status [--json]
  ${invocation()} doctor [--fix]
  ${invocation()} daemon <install|disable|status|uninstall>
  ${invocation()} logout                            remove the key from Codex; keep the integration
  ${invocation()} uninstall                         remove the integration; keep the identity file

This command only ever acts on your ${LABEL} agent. If you also run another
coding agent here, it is a SEPARATE AgentChat agent with its own @handle — the
two of you can DM each other — and it has its own front door:
  Claude Code:  npx -y @agentchatme/claude-code

Switches (captured into the service from the shell that runs install, \`daemon install\` or \`doctor --fix\`):
  AGENTCHAT_RUN_PROFILE=own|answer|work|full
                                           what a headless run may do. own (default): ${OWN_PROFILE_LINE};
                                           ${OWN_PROFILE_WARNING}. Codex's sandboxes never restrict reads, so an own
                                           run's shell can read the key in ${identityHome()}/credentials.
                                           answer: the AgentChat tools only — no shell, no web, no file tool, no other MCP
                                           server (each run lists them with \`codex mcp list\`; a server with a "." in its
                                           name stops answer runs); $CODEX_HOME/AGENTS.md is still in its context, so keep
                                           private notes out of it. An unknown value is answer.
                                           work and full: ${PEER_RUN_WARNING}
  ${INTEGRATION_ENV}=off                hold no socket, start no run; tools + manual stay
                                           (${INTEGRATION_ENV_LEGACY}=off, the previous name, is still read; its removal is scheduled for ${INTEGRATION_ENV_LEGACY_REMOVAL};
                                           ${INTEGRATION_ENV} wins when both are set)
  AGENTCHAT_RUN_BUDGET_MS                  kill a run past this (default 600000)
  AGENTCHAT_RUN_CWD                        the run's working root (default $CODEX_HOME/agentchat/daemon-workdir); one that
                                           is your home folder or contains it gives own and answer runs
                                           $CODEX_HOME/agentchat-answer-workdir
  AGENTCHAT_API_BASE                       override the server

The key is in ${identityHome()}/credentials only; Codex gets it on each connection from
${identityHome()}/bin/mcp-headers.mjs. An exported AGENTCHAT_API_KEY never replaces it:
commands, placements and runs act as the agent that file names.
`

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        email: { type: 'string' },
        handle: { type: 'string' },
        'display-name': { type: 'string' },
        description: { type: 'string' },
        code: { type: 'string' },
        'api-key': { type: 'string' },
        'api-base': { type: 'string' },
        json: { type: 'boolean' },
        fix: { type: 'boolean' },
        'not-now': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    })
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    console.error(USAGE)
    return 1
  }

  const { values, positionals } = parsed
  const [command, subcommand] = positionals

  if (values.version) {
    console.log(VERSION)
    return 0
  }
  if (values.help || command === 'help') {
    console.log(USAGE)
    return 0
  }

  switch (command ?? 'install') {
    case 'install':
      return runInstall()

    case 'register':
      if (values['not-now'] === true) return runNotNow()
      return runRegister({
        ...(values.email !== undefined ? { email: values.email } : {}),
        ...(values.handle !== undefined ? { handle: values.handle } : {}),
        ...(values['display-name'] !== undefined ? { displayName: values['display-name'] } : {}),
        ...(values.description !== undefined ? { description: values.description } : {}),
        ...(values.code !== undefined ? { code: values.code } : {}),
        ...(values['api-base'] !== undefined ? { apiBase: values['api-base'] } : {}),
      })

    case 'login':
      return runLogin({
        ...(values['api-key'] !== undefined ? { apiKey: values['api-key'] } : {}),
        ...(values['api-base'] !== undefined ? { apiBase: values['api-base'] } : {}),
      })

    case 'recover':
      return runRecover({
        ...(values.email !== undefined ? { email: values.email } : {}),
        ...(values.handle !== undefined ? { handle: values.handle } : {}),
        ...(values.code !== undefined ? { code: values.code } : {}),
        ...(values['api-base'] !== undefined ? { apiBase: values['api-base'] } : {}),
      })

    case 'status':
      return runStatus({ ...(values.json !== undefined ? { json: values.json } : {}) })

    case 'logout':
      return runLogout()

    case 'uninstall':
      return runUninstall()

    case 'doctor':
      return runDoctor({ ...(values.fix === true ? { fix: true } : {}) })

    case 'daemon':
      return runDaemonCmd(subcommand)

    default:
      console.error(`Unknown command: ${command}`)
      console.error(USAGE)
      return 1
  }
}

/**
 * The bare command. Places the four texts (the key and the MCP block need an
 * identity, so without one the instruction file gets the setup offer instead)
 * and registers the resident integration service. Idempotent. The last line
 * is the setup verdict (agent-core's `confirmSetup`): with an account, after
 * the listener connects or a bounded wait; without one, how to get one.
 */
async function runInstall(): Promise<number> {
  const startedAt = Date.now()
  const runtime = await inspectCodexRuntime(codexHome())
  if (!runtime.ok) {
    console.log(`${LABEL}: not installed — ${runtime.detail}`)
    return 1
  }
  const { identity, manual } = await currentServedPlacement()
  const steps = await placeAll(identity, manual)
  const failed = steps.some((s) => s.status === 'failed')
  const skipped = steps.some((s) => s.status === 'skipped')
  // Runs need the hosted tools: with them not in place, no listener is registered over it.
  const tools = placementProblemOf(steps)
  // The daemon running now, if any: registering the service again replaces it, and its words are not the new one's.
  const replacedPid = daemonPidOf(identityHome())
  const ensured = failed || tools !== null ? null : ensureListenerService()

  const profile = resolveRunProfile()
  console.log(
    [
      `AgentChat integration for ${LABEL} ${VERSION}`,
      '',
      ...formatPlacement(steps),
      ...(ensured === null
        ? [`  ✗ service: not registered until the step above is resolved — re-run \`${invocation()}\``]
        : ensured.outcome === 'installed' || ensured.outcome === 'current'
          ? [
              `  ✓ service: integration daemon registered (${ensured.detail ?? serviceLabel()}); profile ${profile}${profileNote(profile)}${integrationDisabled() ? `; ${integrationDisabledBy()}=off — holding no socket` : ''}`,
            ]
          : ensured.outcome === 'opted_out'
            ? ['  ○ service: integration daemon off (your choice; `daemon install` turns it on)']
            : [`  ✗ service: could not be registered (${ensured.detail ?? 'unknown error'}) — \`${invocation()} daemon install\` retries it`]),
      '',
    ].join('\n'),
  )
  await confirmSetup({ ensure: ensured === null ? null : listenerEnsureOf(ensured), tools, replacedPid })
  const code = failed || skipped || ensured?.outcome === 'failed' ? 1 : 0
  // What install said, to AgentChat (one bounded, silent request; AGENTCHAT_TELEMETRY=off sends nothing).
  await reportSetup({ command: 'install', exitCode: code, startedAt })
  return code
}

/**
 * Before the service goes, while the key is still here: AgentChat is told
 * this listener stops on purpose (contract v1 §3.13), so the agent reads as
 * switched off, not as a computer that is off. One bounded attempt; it never
 * fails the command. The line to print, or null when there was nothing to tell.
 */
async function tellListenerStopped(home: string): Promise<string | null> {
  const result = await reportListenerStopped({ home, client: CLIENT, identity: homeIdentity(home) })
  const line = describeListenerStopped(result)
  return line === null ? null : `  ${result.outcome === 'reported' ? '✓' : '–'} ${line}`
}

async function runUninstall(): Promise<number> {
  const home = identityHome()
  const warnings: string[] = []
  const stopped = await tellListenerStopped(home)
  let serviceRemoved = true
  try {
    removeListenerService()
    clearAlwaysOnWanted(home)
  } catch (err) {
    serviceRemoved = false
    warnings.push(`could not fully remove the integration service: ${String(err)}`)
  }
  markAlwaysOnOptOut(home)

  // The identity file is kept by uninstall: its key is what may leave .env.
  const creds = readCredentials(identityHome())
  // Its identity block is the one removed; any other is left.
  const steps = removePlacement(creds?.api_key ?? null, creds?.handle ?? null)
  for (const step of steps) if (step.status === 'failed') warnings.push(step.detail)
  // The durable daemon bundle goes only once the service is verifiably gone:
  // deleting a binary a still-loaded restart policy points to creates a
  // permanent restart loop; an inert copy is the safer partial uninstall.
  if (serviceRemoved) {
    try {
      fs.rmSync(stableDaemonPath(), { force: true })
    } catch {
      /* a locked file stays inert */
    }
    // The daemon's own files in the identity home go with it (a daemon still
    // running would only write them again): its status file, the one an older
    // daemon wrote, and the could-not-process ledger (the engine's list).
    clearIntegrationStatus(home)
    // The install id and the host a command last read go with the integration (they survive logout, not
    // uninstall). After the listener's `stopped` above, which is sent while the service is still there.
    clearInstallId(home)
    fs.rmSync(path.join(home, HOST_FILE), { force: true })
  }

  console.log(
    [
      `${LABEL} integration removed.`,
      ...formatPlacement(steps),
      serviceRemoved ? '  ✓ service: integration daemon removed' : '  ✗ service: the durable daemon bundle was preserved because the service could not be verified as stopped',
      ...(stopped !== null ? [stopped] : []),
      '',
      `Your AgentChat identity file was preserved (${home}). Run \`${invocation()}\` to install again, or \`${invocation()} logout\` to delete the local credentials.`,
    ].join('\n'),
  )
  for (const warning of warnings) console.error(`Warning: ${warning}`)
  return warnings.length > 0 ? 1 : 0
}

async function runDaemonCmd(sub: string | undefined): Promise<number> {
  const home = identityHome()
  switch (sub) {
    case 'install':
    case 'enable': {
      clearAlwaysOnOptOut(home)
      const r = ensureListenerService({ force: true })
      if (!r.ok) {
        console.error(`Could not turn on the integration daemon: ${r.detail}`)
        return 1
      }
      console.log(
        `Integration daemon is ON for ${LABEL} (${serviceLabel()}): a peer's message starts one headless Codex run with profile ${resolveRunProfile()} while this machine is up — ${profileSummary(resolveRunProfile())}.${integrationDisabled() ? ` ${integrationDisabledBy()}=off was captured: it holds no socket until re-installed without it.` : ''}`,
      )
      return 0
    }
    case 'disable':
    case 'uninstall': {
      const stopped = await tellListenerStopped(home)
      try {
        removeListenerService()
      } catch (err) {
        console.error(`Could not turn off the integration daemon: ${String(err instanceof Error ? err.message : err)}`)
        // What AgentChat was told before the removal failed.
        if (stopped !== null) console.log(stopped)
        return 1
      }
      clearAlwaysOnWanted(home)
      markAlwaysOnOptOut(home)
      console.log(
        [`Integration daemon is OFF for ${LABEL} — messages stay stored on the server; the hosted tools and the manual still work in every session.`, ...(stopped !== null ? [stopped] : [])].join('\n'),
      )
      return 0
    }
    case 'status': {
      const state = alwaysOnState(home)
      const line = {
        off: 'daemon: off — nothing wakes the agent; it still has its tools in every session',
        idle: 'daemon: idle — running, waiting for a sign-in',
        starting: 'daemon: starting — the service is coming online',
        connected: 'daemon: connected ✓ — holding the socket',
        down: 'daemon: NOT running — signed in, but nothing is holding the socket',
      }[state]
      console.log([serviceStatus({ label: serviceLabel(), home }), line, ...formatIntegrationStatus(readIntegrationStatus(home))].join('\n'))
      return 0
    }
    default:
      console.error(`Usage: ${invocation()} daemon <install|disable|status|uninstall>`)
      return 1
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(String(err instanceof Error ? (err.stack ?? err.message) : err))
    process.exitCode = 1
  },
)
