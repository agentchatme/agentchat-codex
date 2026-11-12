import * as path from 'node:path'
import {
  alwaysOnOptedOut,
  alwaysOnState,
  createIdentityCommands,
  fetchServedTexts,
  integrationDisabledBy,
  INTEGRATION_ENV,
  integrationStatusAge,
  probeHostedMcp,
  readCredentials,
  readIntegrationStatus,
  recordOfferDeclined,
  renderAnchorBlock,
  renderDeclinedBlock,
  resolveIdentity,
  resolveRunProfile,
  runProfileWarning,
  workdirExposesHome,
  writeAnchor,
  type DoctorCheck,
  type DoctorContext,
  type DoctorOpts,
  type HostProfile,
  type ServedManual,
  type StatusContext,
} from '@agentchatme/agent-core'
import { codexAnswerFallbackWorkdir } from '@agentchatme/agent-core/presets'
import { CLIENT, identityHome, anchorFile, codexHome, invocation, LABEL, resolveRunWorkdir, runWorkdirFor } from './host.js'
import { checkPlacement, placeAll, placementMark, skillPresent, unplaceIdentity, type PlacementIdentity } from './placement.js'
import { CodexRunner, codexIsLoggedIn, inspectCodexRuntime, profileNote } from './runner.js'
import { listenerServiceCurrent, ensureListenerService } from './service.js'
import { VERSION } from './version.js'

// ─── This agent, described once ─────────────────────────────────────────────
//
// register / login / recover / status / logout / doctor are a contract with the
// AgentChat server, so the flows live in @agentchatme/agent-core and this file
// only says which agent they act on and how to PLACE for it: every time the key
// changes, `.env` gets the new key, the MCP block is refreshed, the manual is
// brought to the version the served texts announce and the identity line
// rewritten.

/** What the served texts say for the identity block: the line for this agent and the template an unmarked block is recognised by. */
export interface ServedIdentityTexts {
  readonly identityLine: string | null
  readonly identityLineTemplate: string | null
}

const NO_IDENTITY_TEXTS: ServedIdentityTexts = { identityLine: null, identityLineTemplate: null }

export function currentPlacementIdentity(texts: ServedIdentityTexts = NO_IDENTITY_TEXTS): PlacementIdentity | null {
  const identity = resolveIdentity(identityHome())
  if (identity === null || identity.handle === null) return null
  return { handle: identity.handle, apiKey: identity.apiKey, apiBase: identity.apiBase, identityLine: texts.identityLine, identityLineTemplate: texts.identityLineTemplate }
}

/**
 * The identity plus what the served texts say for it — the identity line and
 * the manual they announce — fetched now, else from the identity-home cache,
 * else null. Without an identity nothing is fetched (the texts need a key):
 * the manual is then unannounced, so an existing skill is kept as it is.
 */
export async function currentServedPlacement(): Promise<{ identity: PlacementIdentity | null; manual: ServedManual | null }> {
  const identity = currentPlacementIdentity()
  if (identity === null) return { identity: null, manual: null }
  const loaded = await fetchServedTexts({ home: identityHome(), apiKey: identity.apiKey, apiBase: identity.apiBase, client: CLIENT })
  return {
    identity: { ...identity, identityLine: loaded?.texts.identity_line ?? null, identityLineTemplate: loaded?.texts.identity_line_template ?? null },
    manual: loaded?.texts.manual ?? null,
  }
}

const profile: HostProfile = {
  label: LABEL,
  id: 'codex',
  client: CLIENT,
  home: identityHome,
  anchorFile,
  invocation,
  renderAnchor: renderAnchorBlock,
  isWired: skillPresent,
  // agent-core fetches the served texts (cache fallback) once and hands over
  // the identity line and the manual they announce. Placing needs no
  // template: the block is found by its fences and replaced in place.
  place: async (handle, apiKey, identityLine, manual) => {
    const identity = resolveIdentity(identityHome())
    const steps = await placeAll({ handle, apiKey, apiBase: identity?.apiBase ?? 'https://api.agentchat.me', identityLine, identityLineTemplate: null }, manual)
    return steps.map((s) => `  ${s.status === 'failed' ? 'FAILED' : s.name}: ${s.detail}`)
  },
  unplace: () => unplaceIdentity().map((s) => `  ${s.name}: ${s.detail}`),
  logoutHints: () => [`To remove the integration too, run \`${invocation()} uninstall\`.`],
  extraDoctorChecks: async (ctx: DoctorContext): Promise<DoctorCheck[]> => {
    const runtime = await runtimeChecks()
    return [
      ...runtime,
      ...(await placementChecks(ctx.fix === true, ctx, ctx.manual)),
      serviceCheck(ctx.fix === true),
      workdirCheck(),
      profileCheck(),
      // The runner's own gate needs a working, signed-in Codex first; the checks above say when it is not.
      ...(runtime.every((c) => c.verdict === 'PASS') ? [await preflightCheck()] : []),
      integrationCheck(),
    ]
  },
  // The shared status already fetched the served texts once; the placement
  // checks reuse the identity line, its template and the announced manual
  // rather than fetching `/v1/texts` again.
  extraStatus: async (ctx: StatusContext): Promise<string[]> => {
    const identity = currentPlacementIdentity(ctx)
    const lines = ['Placement:', ...checkPlacement(identity, ctx.manual).map((c) => `  ${placementMark(c)} ${c.name}: ${c.detail}`)]
    if (identity) {
      const reach = await hostedMcpReachCheck()
      lines.push(`  ${reach.verdict === 'PASS' ? '✓' : '✗'} hosted MCP: ${reach.detail}`)
    }
    return lines
  },
}

function concise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180)
}

async function runtimeChecks(): Promise<DoctorCheck[]> {
  const runtime = await inspectCodexRuntime(codexHome())
  if (!runtime.ok) {
    return [
      { name: 'codex-cli', verdict: 'FAIL', detail: runtime.detail },
      { name: 'codex-auth', verdict: 'FAIL', detail: 'cannot check until the Codex CLI works' },
    ]
  }
  const auth = await codexIsLoggedIn(codexHome())
  return [
    { name: 'codex-cli', verdict: 'PASS', detail: concise(runtime.detail) },
    { name: 'codex-auth', verdict: auth.ok ? 'PASS' : 'FAIL', detail: auth.ok ? 'Codex is signed in; headless runs can start' : concise(auth.detail) },
  ]
}

async function placementChecks(fix: boolean, texts: ServedIdentityTexts, manual: ServedManual | null): Promise<DoctorCheck[]> {
  const identity = currentPlacementIdentity(texts)
  if (fix) await placeAll(identity, manual)
  return checkPlacement(identity, manual)
    .filter((c) => c.name !== 'identity') // the shared doctor already reports the identity line
    .map((c) => ({
      name: c.name === 'mcp' ? 'hosted-mcp' : c.name,
      verdict: c.verdict ?? (c.ok ? 'PASS' : c.name === 'legacy' ? 'WARN' : identity ? 'FAIL' : 'WARN'),
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
  if (fix && !listenerServiceCurrent()) {
    const repaired = ensureListenerService()
    if (!repaired.ok) return { name: 'service', verdict: 'FAIL', detail: `repair failed: ${repaired.detail ?? 'unknown error'}` }
  }
  if (!listenerServiceCurrent()) return { name: 'service', verdict: 'WARN', detail: `service, durable daemon bundle or version marker is missing/stale — run \`${invocation()} doctor --fix\`` }
  const state = alwaysOnState(home)
  return { name: 'service', verdict: state === 'down' ? 'FAIL' : 'PASS', detail: `${state}; service definition and daemon bundle match ${VERSION}` }
}

/**
 * The runner the daemon builds for this config, from the same switches the
 * service captures (this shell's: install, `daemon install` and `doctor --fix`
 * write the service from it).
 */
function daemonRunner(): CodexRunner {
  return new CodexRunner({ codexHome: codexHome(), identityHome: identityHome(), workdir: resolveRunWorkdir(identityHome()), profile: resolveRunProfile() })
}

/**
 * The run's working root. One that is the home folder or contains it is no
 * answer run's (those work in an empty folder of their own), and `work`/`full`
 * runs there would see the whole home.
 */
export function workdirCheck(): DoctorCheck {
  const workdir = resolveRunWorkdir(identityHome())
  if (!workdirExposesHome(workdir)) return { name: 'run-workdir', verdict: 'PASS', detail: workdir }
  return {
    name: 'run-workdir',
    verdict: 'WARN',
    detail: `${workdir} is your home folder or contains it — ${
      resolveRunProfile() === 'answer'
        ? `answer runs work in ${codexAnswerFallbackWorkdir(codexHome())} instead`
        : "a run started by a peer's message there can see everything under it"
    }; point AGENTCHAT_RUN_CWD at a folder of its own (or unset it for ${runWorkdirFor(identityHome())}), then \`${invocation()} daemon install\``,
  }
}

/**
 * What a run started by a peer's message may do. `answer`: the AgentChat tools
 * and nothing else. `work` and `full` are the operator's opt-in, said with the
 * engine's own warning (`runProfileWarning`).
 */
export function profileCheck(): DoctorCheck {
  const profile = resolveRunProfile()
  const warning = runProfileWarning(profile)
  if (warning !== null) return { name: 'run-profile', verdict: 'WARN', detail: `${profile}: ${warning} (AGENTCHAT_RUN_PROFILE; answer is the default)` }
  return {
    name: 'run-profile',
    verdict: 'PASS',
    detail: `answer: the AgentChat tools only — no shell, no web, no file tool (apply_patch reads ${daemonRunner().workdir()} alone and writes nothing), no other MCP server, no project AGENTS.md; ${anchorFile()} is still in its context`,
  }
}

/**
 * The runner's own preflight: the gate the daemon applies before it holds the
 * socket, in its exact words. For an answer run that includes the listing of
 * Codex's MCP servers (`codex mcp list --json` with the answer flags, from the
 * run's working root): a server no `-c` key can switch off (a `.` in its name)
 * stops answer runs. Like the daemon, it creates the working root when there
 * is none.
 */
export async function preflightCheck(): Promise<DoctorCheck> {
  const pre = await daemonRunner().preflight()
  return pre.ok
    ? { name: 'run-preflight', verdict: 'PASS', detail: 'the daemon can start a run (the runner\'s preflight passes)' }
    : { name: 'run-preflight', verdict: 'FAIL', detail: `no run starts: ${pre.detail ?? 'the runner\'s preflight failed'}` }
}

function integrationCheck(): DoctorCheck {
  const home = identityHome()
  if (readCredentials(home) === null) return { name: 'integration', verdict: 'PASS', detail: 'no identity — the daemon idles by design' }
  const status = readIntegrationStatus(home)
  if (status === null) return { name: 'integration', verdict: 'WARN', detail: 'no status written yet — the daemon has not run, or is still starting' }
  const age = integrationStatusAge(status) ?? Number.POSITIVE_INFINITY
  if (age > 3 * 60_000) return { name: 'integration', verdict: 'FAIL', detail: `status last written ${Math.round(age / 60_000)} min ago — the daemon is not running` }
  if (status.socket === 'off') return { name: 'integration', verdict: 'PASS', detail: `${integrationDisabledBy() ?? INTEGRATION_ENV}=off — resident, holding no socket` }
  // One agent, one listener: another daemon (the CLI listener, say) serves this agent from its own home.
  const standby = status.standby ?? null
  if (standby !== null) {
    return {
      name: 'integration',
      verdict: 'WARN',
      detail: `standing by — ${standby.home ?? 'another identity home'}${standby.pid !== null ? ` (pid ${standby.pid})` : ''} serves this agent; this daemon holds no socket and starts no run while it does, and takes over when it stops`,
    }
  }
  if (status.socket === 'ready') {
    const texts = status.texts?.source ?? 'none'
    // The daemon's own recheck after runs that did not get done (the `runs` check above is its FAIL).
    const failing = status.runs_failing ?? null
    if (failing !== null) {
      return { name: 'integration', verdict: 'WARN', detail: `socket ready, but runs are failing: ${failing.reason} (since ${failing.since}, ${failing.runs_missed} run(s) missed)` }
    }
    return {
      name: 'integration',
      verdict: texts === 'none' ? 'WARN' : 'PASS',
      detail: `socket ready (acks on receipt), ${status.wakes} wake(s), ${status.runs_started} run(s) (${status.runs_ok} ok), texts ${texts === 'server' ? 'served' : texts === 'cache' ? 'from cache' : 'NOT fetched yet'}, profile ${status.profile}${profileNote(status.profile)}`,
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

/** `status` prints the shared lines, then this host's placement checks and the hosted-MCP probe (`extraStatus`, one texts fetch for both). */
export const { runRegister, runLogin, runRecover, runLogout, runStatus } = commands

export async function runDoctor(opts: DoctorOpts = {}): Promise<number> {
  const base = await commands.runDoctor(opts)
  const reach = await hostedMcpReachCheck()
  console.log(`${reach.verdict.padEnd(4)} ${reach.name}: ${reach.detail}`)
  return base !== 0 || reach.verdict === 'FAIL' ? 1 : 0
}

export type { RegisterOpts, DoctorOpts } from '@agentchatme/agent-core'
