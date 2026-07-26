import { createIdentityCommands, type DoctorCheck, type HostProfile } from '@agentchatme/agent-core'
import { identityHome, anchorFile, invocation, LABEL } from './host.js'
import { renderCodexAgents, isCodexWired, removeCodexWiring } from './wiring.js'

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
    ]
  },
}

export const { runRegister, runLogin, runRecover, runStatus, runLogout, runDoctor } =
  createIdentityCommands(profile)

export type { RegisterOpts, DoctorOpts } from '@agentchatme/agent-core'
