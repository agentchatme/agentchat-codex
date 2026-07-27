import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createIdentityCommands,
  recordOfferDeclined,
  clearOfferDeclined,
  renderDeclinedBlock,
  writeAnchor,
  type DoctorCheck,
  type HostProfile,
} from '@agentchatme/agent-core'
import { identityHome, anchorFile, invocation, LABEL } from './host.js'
import { renderCodexAgents, isCodexWired, removeCodexWiring, codexHooksPath, codexConfigPath } from './wiring.js'

// ─── This agent, described once ─────────────────────────────────────────────
//
// register / login / recover / status / logout / doctor are a contract with the
// AgentChat server — the pending-state machine, the error vocabulary, what a
// credential file holds — so the flows live in @agentchatme/agent-core and this
// file only says which agent they act on, plus what is genuinely different
// about Codex: it wires ITSELF into config.toml and hooks.json, so it has
// wiring to check and wiring to tear down. A host whose installer does that for
// it (a Claude Code plugin) supplies neither.
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
  removeWiring: removeCodexWiring,
  extraDoctorChecks: (): DoctorCheck[] => {
    const wired = isCodexWired()
    return [
      {
        name: 'wiring',
        verdict: wired ? 'PASS' : 'WARN',
        detail: wired ? 'config.toml has the agentchat MCP server' : `not wired — run \`${invocation()}\``,
      },
      hookTrustCheck(),
    ]
  },
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
