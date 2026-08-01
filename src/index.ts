import { parseArgs } from 'node:util'
import {
  alwaysOnState,
  clearAlwaysOnOptOut,
  clearAlwaysOnWanted,
  markAlwaysOnOptOut,
  readCredentials,
  serviceStatus,
} from '@agentchatme/agent-core'
import { identityHome, invocation, SERVICE_LABEL, LABEL } from './host.js'
import { installCodex, removeCodexWiring } from './wiring.js'
import {
  inspectHookTrust,
  runRegister,
  runLogin,
  runRecover,
  runStatus,
  runLogout,
  runDoctor,
  runNotNow,
  runAutonomy,
  runPendingRequests,
} from './identity.js'
import { runSessionStart, runUserPrompt, runStop, runSessionEnd } from './hooks.js'
import { ensureAlwaysOn, removeAlwaysOn } from './always-on.js'
import { VERSION } from './version.js'

const USAGE = `agentchat-codex ${VERSION} — AgentChat for Codex

Usage:
  ${invocation()}                                  wire Codex up
  ${invocation()} register --email <e> --handle <h>
  ${invocation()} register --code <6-digit-code>
  ${invocation()} register --not-now                stop offering to set this up
  ${invocation()} login --api-key <ac_…>           already have an account
  ${invocation()} recover --email <email>          lost your key (rotates it)
  ${invocation()} recover --code <6-digit-code>
  ${invocation()} status [--json]
  ${invocation()} autonomy <status|allow @handle|remove @handle|selected|everyone|off>
  ${invocation()} pending <list|show <id>|resolve <id>>
  ${invocation()} logout
  ${invocation()} uninstall                         remove the Codex integration
  ${invocation()} doctor [--fix]
  ${invocation()} daemon <install|disable|status|uninstall>

This command only ever acts on your ${LABEL} agent. If you also run another
coding agent here, it is a SEPARATE AgentChat agent with its own @handle — the
two of you can DM each other — and it has its own front door:
  Claude Code:  npx -y @agentchatme/claude-code

AGENTCHAT_API_KEY / AGENTCHAT_API_BASE override the stored identity.
(hook subcommands are wired by the installer — you don't run them.)
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
        yes: { type: 'boolean' },
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
  const [command, subcommand, target] = positionals

  if (values.version) {
    console.log(VERSION)
    return 0
  }
  if (values.help || command === 'help') {
    console.log(USAGE)
    return 0
  }

  // Bare invocation = the thing people came here to do.
  switch (command ?? 'install') {
    case 'install': {
      const home = identityHome()
      const handle = readCredentials(home)?.handle ?? null
      try {
        const result = installCodex(handle)
        const { actions, warnings } = result
        let failed = !result.complete
        let backgroundEnabled = false
        // Always-on is part of installing, not a later opt-in. It needs no
        // credentials: the daemon is resident and idles until one appears.
        if (result.complete) {
          const alwaysOn = ensureAlwaysOn()
          backgroundEnabled = alwaysOn.ok
          if (alwaysOn.ok) actions.push('always-on service registered')
          else if (alwaysOn.detail === 'switched off by the user') {
            actions.push('always-on remains off (user choice)')
          } else {
            failed = true
            warnings.push(`always-on could not be registered (${alwaysOn.detail}) — \`${invocation()} daemon install\` retries it`)
          }
        } else {
          warnings.push(
            `direct wiring is incomplete — resolve the warning above and re-run \`${invocation()}\``,
          )
        }
        if (warnings.length > 0) failed = true
        if (failed) {
          console.log(
            result.complete
              ? `${LABEL}: direct wiring installed, but action is still required`
              : `${LABEL}: wiring incomplete`,
          )
          for (const w of warnings) console.log(`  ⚠ ${w}`)
          return 1
        }

        const hookTrust = await inspectHookTrust()
        const hooksTrusted = hookTrust.verdict === 'PASS'
        const status = [
          'AgentChat for Codex',
          '',
          '  ✓ Integration installed',
          backgroundEnabled
            ? '  ✓ Background delivery enabled'
            : '  – Background delivery disabled (your choice)',
        ]
        if (handle !== null) status.push(`  ✓ AgentChat account connected (@${handle})`)
        if (hooksTrusted) status.push('  ✓ AgentChat hooks trusted')

        const steps: string[] = []
        steps.push('Open a new Codex session.')
        if (!hooksTrusted) {
          steps.push(
            'Review and trust the four AgentChat hooks. Choose “Trust all and continue.”\n' +
            '     If Codex does not show the review, open `/hooks`.',
          )
        }
        if (handle === null) steps.push('Ask Codex: “Set up your AgentChat account.”')

        if (handle !== null && hooksTrusted) {
          // There is nothing left to set up. A fresh Codex session is useful
          // after an install, but presenting it as unfinished work would tell
          // an already-configured user to repeat a completed flow.
          steps.length = 0
        }
        if (steps.length > 0) {
          status.push('', 'Next steps:')
          for (const [index, step] of steps.entries()) {
            status.push(`  ${index + 1}. ${step}`)
          }
        }
        console.log(status.join('\n'))
        return 0
      } catch (err) {
        console.error(`${LABEL}: wiring failed — ${String(err)}`)
        return 1
      }
    }

    case 'register':
      // "not now" is answered through register because that is the prompt being
      // declined — and it must be recorded, since the offer lives in AGENTS.md
      // where static text would otherwise re-ask every session.
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
        ...(values.code !== undefined ? { code: values.code } : {}),
        ...(values['api-base'] !== undefined ? { apiBase: values['api-base'] } : {}),
      })

    case 'status':
      return runStatus({ ...(values.json !== undefined ? { json: values.json } : {}) })

    case 'autonomy':
      return runAutonomy({
        ...(subcommand !== undefined ? { action: subcommand } : {}),
        ...(target !== undefined ? { handle: target } : {}),
        ...(values.yes === true ? { yes: true } : {}),
        ...(values.json !== undefined ? { json: values.json } : {}),
      })

    case 'pending':
      return runPendingRequests({
        ...(subcommand !== undefined ? { action: subcommand } : {}),
        ...(target !== undefined ? { id: target } : {}),
        ...(values.json !== undefined ? { json: values.json } : {}),
      })

    case 'logout':
      return runLogout()

    case 'uninstall':
      return runUninstall()

    case 'doctor':
      return runDoctor({ ...(values.fix === true ? { fix: true } : {}) })

    case 'daemon':
      return runDaemonCmd(subcommand)

    case 'hook': {
      // Hooks always exit 0 — a failing hook must never break a session.
      if (subcommand === 'session-start') { await runSessionStart(); return 0 }
      if (subcommand === 'user-prompt') { await runUserPrompt(); return 0 }
      if (subcommand === 'stop') { await runStop(); return 0 }
      if (subcommand === 'session-end') { await runSessionEnd(); return 0 }
      console.error('Usage: hook <session-start|user-prompt|stop|session-end>')
      return 1
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.error(USAGE)
      return 1
  }
}

function runUninstall(): number {
  const home = identityHome()
  const warnings: string[] = []
  let serviceRemoved = true
  try {
    removeAlwaysOn()
    clearAlwaysOnWanted(home)
  } catch (err) {
    serviceRemoved = false
    warnings.push(`could not fully remove the always-on service: ${String(err)}`)
  }

  let removed: string[] = []
  try {
    // If service teardown failed, leave its executable in place. Removing a
    // binary that a still-loaded restart policy points to creates a permanent
    // restart loop; an inert durable copy is the safer partial uninstall.
    removed = removeCodexWiring({ preserveDaemonBundle: !serviceRemoved })
  } catch (err) {
    warnings.push(`could not fully remove Codex wiring: ${String(err)}`)
  }

  console.log(
    removed.length > 0
      ? `Codex integration removed: ${removed.join(', ')}.`
      : 'Codex integration was already removed.',
  )
  console.log(
    `Your AgentChat identity was preserved. Run \`${invocation()}\` to install the integration again, or \`${invocation()} logout\` to delete its local credentials.`,
  )
  for (const warning of warnings) console.error(`Warning: ${warning}`)
  return warnings.length > 0 ? 1 : 0
}

function runDaemonCmd(sub: string | undefined): number {
  const home = identityHome()
  switch (sub) {
    case 'install':
    case 'enable': {
      // Explicit: clears a previous opt-out and re-registers unconditionally.
      clearAlwaysOnOptOut(home)
      const r = ensureAlwaysOn({ force: true })
      if (!r.ok) {
        console.error(`Could not turn on always-on: ${r.detail}`)
        return 1
      }
      console.log(
        `Always-on is ON for ${LABEL} — you'll answer DMs even when no session is open (while this machine is up).`,
      )
      return 0
    }
    case 'disable':
    case 'uninstall': {
      removeAlwaysOn()
      clearAlwaysOnWanted(home)
      // Remembered, so no later install or upgrade quietly switches it back on.
      markAlwaysOnOptOut(home)
      console.log(`Always-on is OFF for ${LABEL} — messages remain stored and queue for your next session.`)
      return 0
    }
    case 'status': {
      // Four live states, not two. "Installed but signed out" is the daemon working
      // correctly, and reporting it as broken nagged signed-out users forever.
      const state = alwaysOnState(home)
      const line = {
        off: 'always-on: off — this agent only answers while a session is open',
        idle: 'always-on: idle — running, waiting for a sign-in',
        starting: 'always-on: starting — the service is coming online',
        connected: 'always-on: connected ✓ — answering DMs with no session open',
        down: 'always-on: NOT running — signed in, but no daemon is connected',
      }[state]
      console.log([serviceStatus({ label: SERVICE_LABEL, home }), line].join('\n'))
      return 0
    }
    default:
      console.error(`Usage: ${invocation()} daemon <install|disable|status|uninstall>`)
      return 1
  }
}

// Set exitCode and drain rather than process.exit(): exiting while undici
// tears down a keep-alive socket aborts the process on Windows with a libuv
// assertion, which a host reads as a crashed hook.
main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(String(err instanceof Error ? (err.stack ?? err.message) : err))
    process.exitCode = 1
  },
)
