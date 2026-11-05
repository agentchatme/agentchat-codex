import * as path from 'node:path'
import {
  alwaysOnOptedOut,
  alwaysOnState,
  createIdentityCommands,
  fetchIdentityLine,
  integrationDisabledBy,
  integrationStatusAge,
  probeHostedMcp,
  readCredentials,
  readIntegrationStatus,
  recordOfferDeclined,
  renderAnchorBlock,
  renderDeclinedBlock,
  resolveIdentity,
  writeAnchor,
  type DoctorCheck,
  type DoctorContext,
  type DoctorOpts,
  type HostProfile,
} from '@agentchatme/agent-core'
import { CLIENT, identityHome, anchorFile, codexHome, invocation, LABEL } from './host.js'
import { checkPlacement, placeAll, skillIsCurrent, unplaceIdentity, type PlacementIdentity } from './placement.js'
import { codexIsLoggedIn, inspectCodexRuntime } from './runner.js'
import { doorbellServiceCurrent, ensureDoorbellService } from './service.js'
import { VERSION } from './version.js'

// ─── This agent, described once ─────────────────────────────────────────────
//
// register / login / recover / status / logout / doctor are a contract with the
// AgentChat server, so the flows live in @agentchatme/agent-core and this file
// only says which agent they act on and how to PLACE for it: every time the key
// changes, `.env` gets the new key, the MCP block is refreshed, the manual is
// refreshed and the identity line rewritten.

export function currentPlacementIdentity(identityLine: string | null = null): PlacementIdentity | null {
  const identity = resolveIdentity(identityHome())
  if (identity === null || identity.handle === null) return null
  return { handle: identity.handle, apiKey: identity.apiKey, apiBase: identity.apiBase, identityLine }
}

/** The identity plus its served identity line (fetched now, else the identity-home cache, else null). */
export async function currentPlacementIdentityWithLine(): Promise<PlacementIdentity | null> {
  const identity = currentPlacementIdentity()
  if (identity === null) return null
  const identityLine = await fetchIdentityLine({ home: identityHome(), apiKey: identity.apiKey, apiBase: identity.apiBase, client: CLIENT })
  return { ...identity, identityLine }
}

const profile: HostProfile = {
  label: LABEL,
  id: 'codex',
  client: CLIENT,
  home: identityHome,
  anchorFile,
  invocation,
  renderAnchor: renderAnchorBlock,
  isWired: skillIsCurrent,
  // agent-core fetches the served identity line (cache fallback) before calling this.
  place: (handle, apiKey, identityLine) => {
    const identity = resolveIdentity(identityHome())
    return placeAll({ handle, apiKey, apiBase: identity?.apiBase ?? 'https://api.agentchat.me', identityLine }).map((s) => `  ${s.status === 'failed' ? 'FAILED' : s.name}: ${s.detail}`)
  },
  unplace: () => unplaceIdentity().map((s) => `  ${s.name}: ${s.detail}`),
  logoutHints: () => [`To remove the integration too, run \`${invocation()} uninstall\`.`],
  extraDoctorChecks: (ctx: DoctorContext): DoctorCheck[] => [...runtimeChecks(), ...placementChecks(ctx.fix === true, ctx.identityLine), serviceCheck(ctx.fix === true), integrationCheck()],
}

function concise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180)
}

function runtimeChecks(): DoctorCheck[] {
  const runtime = inspectCodexRuntime(codexHome())
  if (!runtime.ok) {
    return [
      { name: 'codex-cli', verdict: 'FAIL', detail: runtime.detail },
      { name: 'codex-auth', verdict: 'FAIL', detail: 'cannot check until the Codex CLI works' },
    ]
  }
  const auth = codexIsLoggedIn(codexHome())
  return [
    { name: 'codex-cli', verdict: 'PASS', detail: concise(runtime.detail) },
    { name: 'codex-auth', verdict: auth.ok ? 'PASS' : 'FAIL', detail: auth.ok ? 'Codex is signed in; headless runs can start' : concise(auth.detail) },
  ]
}

function placementChecks(fix: boolean, identityLine: string | null): DoctorCheck[] {
  const identity = currentPlacementIdentity(identityLine)
  if (fix) placeAll(identity)
  return checkPlacement(identity)
    .filter((c) => c.name !== 'identity') // the shared doctor already reports the identity line
    .map((c) => ({
      name: c.name === 'mcp' ? 'hosted-mcp' : c.name,
      verdict: c.ok ? 'PASS' : c.name === 'legacy' ? 'WARN' : identity ? 'FAIL' : 'WARN',
      detail: c.ok ? c.detail : `${c.detail} — run \`${invocation()}${fix ? '' : ' doctor --fix'}\``,
    }))
}

/** One MCP `initialize` with the key: can this agent's tools be reached from here? */
export async function hostedMcpReachCheck(): Promise<DoctorCheck> {
  const identity = currentPlacementIdentity()
  if (identity === null) return { name: 'hosted-mcp-reach', verdict: 'WARN', detail: 'no identity — nothing to probe with' }
  const probe = await probeHostedMcp({ apiKey: identity.apiKey, apiBase: identity.apiBase, client: CLIENT, clientName: '@agentchatme/codex doctor', clientVersion: VERSION })
  return probe.ok
    ? { name: 'hosted-mcp-reach', verdict: 'PASS', detail: `initialize ok${probe.serverName ? ` (${probe.serverName}${probe.serverVersion ? ` ${probe.serverVersion}` : ''})` : ''}` }
    : { name: 'hosted-mcp-reach', verdict: 'FAIL', detail: probe.error ?? `HTTP ${probe.status ?? '?'}` }
}

function serviceCheck(fix: boolean): DoctorCheck {
  const home = identityHome()
  if (alwaysOnOptedOut(home)) return { name: 'service', verdict: 'PASS', detail: 'disabled by the user (`daemon install` re-enables)' }
  if (fix && !doorbellServiceCurrent()) {
    const repaired = ensureDoorbellService()
    if (!repaired.ok) return { name: 'service', verdict: 'FAIL', detail: `repair failed: ${repaired.detail ?? 'unknown error'}` }
  }
  if (!doorbellServiceCurrent()) return { name: 'service', verdict: 'WARN', detail: `service, durable daemon bundle or version marker is missing/stale — run \`${invocation()} doctor --fix\`` }
  const state = alwaysOnState(home)
  return { name: 'service', verdict: state === 'down' ? 'FAIL' : 'PASS', detail: `${state}; service definition and daemon bundle match ${VERSION}` }
}

function integrationCheck(): DoctorCheck {
  const home = identityHome()
  if (readCredentials(home) === null) return { name: 'integration', verdict: 'PASS', detail: 'no identity — the daemon idles by design' }
  const status = readIntegrationStatus(home)
  if (status === null) return { name: 'integration', verdict: 'WARN', detail: 'no status written yet — the daemon has not run, or is still starting' }
  const age = integrationStatusAge(status) ?? Number.POSITIVE_INFINITY
  if (age > 3 * 60_000) return { name: 'integration', verdict: 'FAIL', detail: `status last written ${Math.round(age / 60_000)} min ago — the daemon is not running` }
  if (status.socket === 'off') return { name: 'integration', verdict: 'PASS', detail: `${integrationDisabledBy() ?? 'AGENTCHAT_INTEGRATION'}=off — resident, holding no socket` }
  if (status.socket === 'ready') {
    const texts = status.texts?.source ?? 'none'
    return {
      name: 'integration',
      verdict: texts === 'none' ? 'WARN' : 'PASS',
      detail: `socket ready (acks on receipt), ${status.wakes} wake(s), ${status.runs_started} run(s) (${status.runs_ok} ok), texts ${texts === 'server' ? 'served' : texts === 'cache' ? 'from cache' : 'NOT fetched yet'}, profile ${status.profile}`,
    }
  }
  return { name: 'integration', verdict: 'WARN', detail: `socket ${status.socket}${status.last_error ? ` — ${status.last_error}` : ''}` }
}

const commands = createIdentityCommands(profile)

/** Persist a declined setup offer so the always-loaded AGENTS.md does not nag. */
export function runNotNow(): number {
  const home = identityHome()
  recordOfferDeclined(home)
  try {
    writeAnchor(anchorFile(), renderDeclinedBlock({ invoke: invocation(), label: LABEL }))
  } catch (err) {
    console.error(`Recorded, but could not update ${path.basename(anchorFile())}: ${String(err)}`)
    return 1
  }
  console.log([`Noted — ${LABEL} will not ask about AgentChat again.`, `Changed your mind? ${invocation()} register --email <email> --handle <handle>`].join('\n'))
  return 0
}

export const { runRegister, runLogin, runRecover, runLogout } = commands

/** The shared status, then the placement checks and the hosted-MCP probe. */
export async function runStatus(opts: { json?: boolean }): Promise<number> {
  const code = await commands.runStatus(opts)
  if (opts.json) return code
  const identity = await currentPlacementIdentityWithLine()
  console.log('Placement:')
  for (const c of checkPlacement(identity)) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`)
  if (identity) {
    const reach = await hostedMcpReachCheck()
    console.log(`  ${reach.verdict === 'PASS' ? '✓' : '✗'} hosted MCP: ${reach.detail}`)
  }
  return code
}

export async function runDoctor(opts: DoctorOpts = {}): Promise<number> {
  const base = await commands.runDoctor(opts)
  const reach = await hostedMcpReachCheck()
  console.log(`${reach.verdict.padEnd(4)} ${reach.name}: ${reach.detail}`)
  return base !== 0 || reach.verdict === 'FAIL' ? 1 : 0
}

export type { RegisterOpts, DoctorOpts } from '@agentchatme/agent-core'
