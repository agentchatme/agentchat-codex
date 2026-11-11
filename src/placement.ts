import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  atomicWriteFile,
  checkManual,
  describeManualSync,
  hostedMcpUrl,
  log,
  offerDeclined,
  readAnchorHandleAt,
  anchorIsCurrentAt,
  removeAnchorAt,
  renderAnchorBlock,
  renderDeclinedBlock,
  renderUnregisteredBlock,
  syncManual,
  writeAnchor,
  type ManualSyncResult,
  type ServedManual,
} from '@agentchatme/agent-core'
import { API_KEY_ENV, MCP_SERVER_NAME, anchorFile, configPath, dotEnvPath, hooksPath, hostCopy, identityHome, skillDir, skillPath } from './host.js'

// ─── Placement: the four texts, where Codex loads them ──────────────────────
//
// 1. **The key** — `AGENTCHAT_API_KEY=<key>` in `$CODEX_HOME/.env` (mode 0600).
//    Codex loads that file at startup (codex-rs/arg0 `load_dotenv`; only
//    `CODEX_*` names are refused), so the variable exists in every Codex
//    process without touching the user's shell.
// 2. **The tools** — `[mcp_servers.agentchat]` in `$CODEX_HOME/config.toml`:
//    `url = "https://api.agentchat.me/mcp"` and
//    `bearer_token_env_var = "AGENTCHAT_API_KEY"` (the streamable-HTTP transport
//    fields in codex-rs/config/src/mcp_types.rs; the same two things
//    `codex mcp add <name> --url <url> --bearer-token-env-var <var>` writes).
//    Written as a fenced block (`# agentchat:start` / `# agentchat:end`) so an
//    upgrade replaces it and uninstall strips it, byte-preserving outside the
//    fence; a hand-written `[mcp_servers.agentchat]` outside the fence is never
//    touched.
// 3. **The identity line** — the shared AgentChat identity block (the SDK
//    kit's shape, through agent-core: the fences, a handle line
//    `<!-- agentchat:handle <handle> -->`, the served identity line) in
//    `$CODEX_HOME/AGENTS.md` (loaded into every Codex session). A block any
//    earlier release wrote is replaced where it stands, the rest of the file
//    is kept byte for byte, and the file is written atomically.
// 4. **The manual** — the served one (the address and version `GET /v1/texts`
//    announce; https://agentchat.me/skill.md today) as the skill
//    `$CODEX_HOME/skills/agentchat/SKILL.md` (codex-rs/skills: `CODEX_HOME/skills`,
//    `SKILL.md`), loaded on demand. agent-core's `syncManual` downloads it when
//    the file's version is not the announced one and keeps the file on any
//    failure; the daemon keeps it current from then on. The copy bundled in
//    agent-core is written only when there is no file and nothing verified can
//    be had.
//
// Legacy cleanup on upgrade: the four lifecycle hooks the previous release wrote
// into `hooks.json`, the stable CLI bundle under the identity home, and the old
// on-disk manual at `<home>/SKILL.md`. Receiving no longer needs hooks.

/**
 * `warned`: done as far as it can be and nothing broken, but not current — a
 * manual left at its version (or the bundled copy) because the announced one
 * could not be downloaded. Printed as a warning; never fails an install.
 */
export type PlacementStatus = 'ok' | 'changed' | 'warned' | 'skipped' | 'failed'

export interface PlacementStep {
  readonly name: 'key' | 'mcp' | 'identity' | 'manual' | 'legacy'
  readonly status: PlacementStatus
  readonly detail: string
}

export interface PlacementIdentity {
  readonly handle: string
  readonly apiKey: string
  readonly apiBase: string
  /** The served identity line for this agent (`GET /v1/texts`, or the identity-home cache); null when neither could be had. */
  readonly identityLine: string | null
  /**
   * The served `identity_line_template` from the same texts. What the checks
   * recognise an unmarked block (one an earlier release wrote, with no handle
   * line) by, in the words served today. Null when no texts are in hand, and
   * on the write-only path (`place`): writing does not need it, because the
   * block is found by its fences.
   */
  readonly identityLineTemplate: string | null
}

export const TOML_START = '# agentchat:start'
export const TOML_END = '# agentchat:end'
const LEGACY_BUNDLE = path.join('bin', 'agentchat.mjs')
const LEGACY_MANUAL = 'SKILL.md'

// ─── the key: $CODEX_HOME/.env ──────────────────────────────────────────────

function lineSetsVariable(line: string, name: string): boolean {
  const trimmed = line.trim()
  if (trimmed.startsWith('#')) return false
  const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
  return body.startsWith(`${name}=`)
}

/** Upsert one `NAME=value` line; every other line is kept byte for byte. Pure. */
export function upsertDotEnvLine(content: string, name: string, value: string): string {
  const line = `${name}=${value}`
  const lines = content.length > 0 ? content.split(/\r?\n/) : []
  let replaced = false
  const out = lines.map((existing) => {
    if (!replaced && lineSetsVariable(existing, name)) {
      replaced = true
      return line
    }
    return existing
  })
  if (!replaced) {
    if (out.length > 0 && out[out.length - 1] === '') out.splice(out.length - 1, 0, line)
    else out.push(line)
  }
  let next = out.join('\n')
  if (!next.endsWith('\n')) next += '\n'
  return next
}

export function removeDotEnvLine(content: string, name: string): string {
  const next = content.split(/\r?\n/).filter((line) => !lineSetsVariable(line, name))
  return next.join('\n')
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1)
  return value
}

/** The value `.env` holds for the key, if any. */
export function readKeyFromDotEnv(): string | undefined {
  try {
    for (const line of fs.readFileSync(dotEnvPath(), 'utf-8').split(/\r?\n/)) {
      if (!lineSetsVariable(line, API_KEY_ENV)) continue
      return stripQuotes(line.slice(line.indexOf('=') + 1).trim()) || undefined
    }
  } catch {
    /* absent */
  }
  return undefined
}

export function placeKey(apiKey: string): PlacementStep {
  const trimmed = apiKey.trim()
  if (!trimmed || /[\r\n#"'\s]/.test(trimmed)) return { name: 'key', status: 'failed', detail: 'the key is empty or contains characters a .env line cannot carry' }
  try {
    const file = dotEnvPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
    const next = upsertDotEnvLine(existing, API_KEY_ENV, trimmed)
    if (next === existing) {
      try {
        fs.chmodSync(file, 0o600)
      } catch {
        /* best effort */
      }
      return { name: 'key', status: 'ok', detail: `${API_KEY_ENV} in ${file}` }
    }
    atomicWriteFile(file, next, 0o600)
    return { name: 'key', status: 'changed', detail: `${API_KEY_ENV} in ${file} (Codex loads it at startup; a running Codex picks it up on its next start)` }
  } catch (err) {
    return { name: 'key', status: 'failed', detail: `could not write ${API_KEY_ENV} to ${dotEnvPath()}: ${String(err)}` }
  }
}

export function removeKey(): PlacementStep {
  const file = dotEnvPath()
  try {
    if (!fs.existsSync(file)) return { name: 'key', status: 'ok', detail: `no ${API_KEY_ENV} to remove` }
    const existing = fs.readFileSync(file, 'utf-8')
    const next = removeDotEnvLine(existing, API_KEY_ENV)
    if (next === existing) return { name: 'key', status: 'ok', detail: `no ${API_KEY_ENV} in ${file}` }
    if (next.trim().length === 0) fs.rmSync(file, { force: true })
    else atomicWriteFile(file, next, 0o600)
    return { name: 'key', status: 'changed', detail: `${API_KEY_ENV} removed from ${file}` }
  } catch (err) {
    return { name: 'key', status: 'failed', detail: `could not update ${file}: ${String(err)}` }
  }
}

// ─── the tools: [mcp_servers.agentchat] in config.toml ──────────────────────

export function mcpBlock(apiBase: string): string {
  return [
    TOML_START,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `url = "${hostedMcpUrl(apiBase)}"`,
    `bearer_token_env_var = "${API_KEY_ENV}"`,
    'startup_timeout_sec = 30',
    '# Auto-run the AgentChat tools without a prompt, scoped to THIS server only.',
    'default_tools_approval_mode = "approve"',
    TOML_END,
  ].join('\n')
}

export function upsertTomlBlock(existing: string, block: string): string {
  const cleaned = stripTomlBlock(existing)
  const trimmed = cleaned.replace(/\n+$/, '')
  if (trimmed.length === 0) return block + '\n'
  return trimmed + '\n\n' + block + '\n'
}

export function stripTomlBlock(existing: string): string {
  const startIdx = existing.indexOf(TOML_START)
  const endIdx = existing.indexOf(TOML_END)
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return existing
  const before = existing.slice(0, startIdx).replace(/\n+$/, '')
  const after = existing.slice(endIdx + TOML_END.length).replace(/^\n+/, '')
  if (before.length === 0 && after.length === 0) return ''
  if (before.length === 0) return after.endsWith('\n') ? after : after + '\n'
  if (after.length === 0) return before + '\n'
  return before + '\n\n' + after + (after.endsWith('\n') ? '' : '\n')
}

/** A hand-written `[mcp_servers.agentchat]` outside our fence would collide (duplicate TOML table). */
export function hasUnfencedAgentchatServer(existing: string): boolean {
  return new RegExp(`^\\s*\\[mcp_servers\\.${MCP_SERVER_NAME}\\]`, 'm').test(stripTomlBlock(existing))
}

export type McpBlockState = 'current' | 'stale' | 'missing' | 'foreign'

export function inspectMcpBlock(apiBase: string): McpBlockState {
  let config = ''
  try {
    config = fs.readFileSync(configPath(), 'utf-8')
  } catch {
    return 'missing'
  }
  if (hasUnfencedAgentchatServer(config)) return 'foreign'
  if (config.includes(mcpBlock(apiBase))) return 'current'
  return config.includes(TOML_START) ? 'stale' : 'missing'
}

export function placeMcp(apiBase: string): PlacementStep {
  const file = configPath()
  const state = inspectMcpBlock(apiBase)
  if (state === 'foreign') {
    return { name: 'mcp', status: 'skipped', detail: `${file} already defines [mcp_servers.${MCP_SERVER_NAME}] outside the agentchat block — left untouched; remove it and re-run if it is not yours` }
  }
  if (state === 'current') return { name: 'mcp', status: 'ok', detail: `[mcp_servers.${MCP_SERVER_NAME}] → ${hostedMcpUrl(apiBase)} (bearer token from ${API_KEY_ENV}) in ${file}` }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
    let mode = 0o600
    try {
      mode = fs.statSync(file).mode & 0o777
    } catch {
      /* new file: private */
    }
    atomicWriteFile(file, upsertTomlBlock(existing, mcpBlock(apiBase)), mode)
    return {
      name: 'mcp',
      status: 'changed',
      detail: `[mcp_servers.${MCP_SERVER_NAME}] → ${hostedMcpUrl(apiBase)} (bearer token from ${API_KEY_ENV}) in ${file}${state === 'stale' ? ' (the previous entry was replaced)' : ''}`,
    }
  } catch (err) {
    return { name: 'mcp', status: 'failed', detail: `could not write ${file}: ${String(err)}` }
  }
}

export function removeMcp(): PlacementStep {
  const file = configPath()
  try {
    if (!fs.existsSync(file)) return { name: 'mcp', status: 'ok', detail: 'no config.toml' }
    const existing = fs.readFileSync(file, 'utf-8')
    const next = stripTomlBlock(existing)
    if (next === existing) return { name: 'mcp', status: 'ok', detail: `no agentchat block in ${file}` }
    const mode = fs.statSync(file).mode & 0o777
    atomicWriteFile(file, next, mode)
    return { name: 'mcp', status: 'changed', detail: `[mcp_servers.${MCP_SERVER_NAME}] removed from ${file}` }
  } catch (err) {
    return { name: 'mcp', status: 'failed', detail: `could not update ${file}: ${String(err)}` }
  }
}

// ─── the manual, as the agentchat skill ─────────────────────────────────────

/** Is there an agentchat skill at all (any version)? What `isWired` asks. */
export function skillPresent(): boolean {
  return fs.existsSync(skillPath())
}

/**
 * The installer's line for a sync. A manual not at the announced version is a
 * warning (`–`), never a failed install: the integration works with the file
 * it has (the old one, or the bundled copy), and `status` / `doctor` keep
 * saying it is stale until a later sync succeeds. Only no manual at all fails.
 */
function manualStep(result: ManualSyncResult, removedLegacy: boolean): PlacementStep {
  const status: PlacementStatus =
    result.state === 'failed' ? 'failed' : result.upToDate === false ? 'warned' : result.written || removedLegacy ? 'changed' : 'ok'
  return { name: 'manual', status, detail: `${describeManualSync(result)}${removedLegacy ? ' (old on-disk manual removed)' : ''}` }
}

/**
 * The manual the served texts announce (`manual`, null when none are in
 * hand), as the agentchat skill. `apiBase` is the API base the texts came
 * from: it decides where a download may go (none from a plain-HTTP base off
 * loopback). Never throws.
 */
export async function placeSkill(manual: ServedManual | null, apiBase: string | null): Promise<PlacementStep> {
  const result = await syncManual({ path: skillPath(), served: manual, apiBase })
  // The previous release kept the manual at <home>/SKILL.md, outside any
  // skills directory. The skill supersedes it.
  const legacy = path.join(identityHome(), LEGACY_MANUAL)
  let removedLegacy = false
  try {
    if (fs.existsSync(legacy)) {
      fs.rmSync(legacy, { force: true })
      removedLegacy = true
    }
  } catch {
    /* a locked file stays inert */
  }
  return manualStep(result, removedLegacy)
}

export function removeSkill(): PlacementStep {
  try {
    let removed = false
    if (fs.existsSync(skillPath())) {
      fs.rmSync(skillDir(), { recursive: true, force: true })
      removed = true
    }
    const legacy = path.join(identityHome(), LEGACY_MANUAL)
    if (fs.existsSync(legacy)) {
      fs.rmSync(legacy, { force: true })
      removed = true
    }
    return { name: 'manual', status: removed ? 'changed' : 'ok', detail: removed ? 'agentchat skill removed' : 'no agentchat skill to remove' }
  } catch (err) {
    return { name: 'manual', status: 'failed', detail: `could not remove the agentchat skill: ${String(err)}` }
  }
}

// ─── the identity line ──────────────────────────────────────────────────────

export function placeIdentityLine(handle: string, identityLine: string | null): PlacementStep {
  if (identityLine === null) {
    // The line is the server's. Without it (offline, nothing cached) nothing is
    // written: `doctor --fix` places it once the texts can be fetched.
    return {
      name: 'identity',
      status: 'skipped',
      detail: `identity line for @${handle} not written — the served texts (GET /v1/texts) could not be fetched and none are cached; run \`doctor --fix\` once online`,
    }
  }
  try {
    // Current = exactly this line and handle, and no second AgentChat block.
    // Otherwise the block is rewritten in place of the first one found (any
    // shape an earlier release wrote), every other one removed.
    const current = anchorIsCurrentAt(anchorFile(), identityLine, handle)
    if (!current) writeAnchor(anchorFile(), renderAnchorBlock(identityLine, handle), handle)
    return { name: 'identity', status: current ? 'ok' : 'changed', detail: `identity line for @${handle} in ${anchorFile()}` }
  } catch (err) {
    return { name: 'identity', status: 'failed', detail: `could not write the identity line to ${anchorFile()}: ${String(err)}` }
  }
}

/** No identity yet: the wizard's offer (or the silent variant after --not-now). */
export function placeOffer(): PlacementStep {
  try {
    const declined = offerDeclined(identityHome())
    writeAnchor(anchorFile(), declined ? renderDeclinedBlock(hostCopy()) : renderUnregisteredBlock(hostCopy()))
    return { name: 'identity', status: 'changed', detail: declined ? `${path.basename(anchorFile())}: AgentChat present, not asking` : `${path.basename(anchorFile())}: setup offer (no account yet)` }
  } catch (err) {
    return { name: 'identity', status: 'failed', detail: `could not write ${anchorFile()}: ${String(err)}` }
  }
}

// ─── legacy wiring from the hook-based releases before the listener ─────────

interface HookLeaf {
  command?: unknown
}
interface HookGroup {
  hooks?: HookLeaf[]
  [key: string]: unknown
}

function leafIsOurs(leaf: HookLeaf): boolean {
  return typeof leaf.command === 'string' && leaf.command.replace(/\\/g, '/').includes('agentchat/bin/agentchat.mjs')
}

/** Remove only our hook leaves; a user's co-located hooks stay. Pure. */
export function withoutLegacyHooks(doc: Record<string, unknown>): { doc: Record<string, unknown>; removed: number } {
  const hooks = doc['hooks']
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { doc, removed: 0 }
  let removed = 0
  const nextHooks: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups
      continue
    }
    const kept: HookGroup[] = []
    for (const group of groups as HookGroup[]) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group)
        continue
      }
      const leaves = group.hooks.filter((leaf) => {
        const ours = leafIsOurs(leaf)
        if (ours) removed += 1
        return !ours
      })
      if (leaves.length === 0) continue
      kept.push(leaves.length === group.hooks.length ? group : { ...group, hooks: leaves })
    }
    if (kept.length > 0) nextHooks[event] = kept
  }
  const next = { ...doc }
  if (Object.keys(nextHooks).length > 0) next['hooks'] = nextHooks
  else delete next['hooks']
  return { doc: next, removed }
}

export function legacyHooksPresent(): boolean {
  try {
    return withoutLegacyHooks(JSON.parse(fs.readFileSync(hooksPath(), 'utf-8')) as Record<string, unknown>).removed > 0
  } catch {
    return false
  }
}

export function legacyBundlePresent(): boolean {
  return fs.existsSync(path.join(identityHome(), LEGACY_BUNDLE))
}

/** Strip the previous release's hooks and stable CLI bundle. Idempotent. */
export function removeLegacyWiring(): PlacementStep | null {
  const notes: string[] = []
  const file = hooksPath()
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const { doc, removed } = withoutLegacyHooks(parsed as Record<string, unknown>)
        if (removed > 0) {
          let mode = 0o600
          try {
            mode = fs.statSync(file).mode & 0o777
          } catch {
            /* keep private */
          }
          if (Object.keys(doc).length === 0) fs.unlinkSync(file)
          else atomicWriteFile(file, JSON.stringify(doc, null, 2) + '\n', mode)
          notes.push(`${removed} lifecycle hook${removed === 1 ? '' : 's'} removed from hooks.json (receiving no longer needs hooks)`)
        }
      }
    } catch (err) {
      return { name: 'legacy', status: 'failed', detail: `${file} could not be read as JSON; the old AgentChat hooks were left in place: ${String(err)}` }
    }
  }
  const bundle = path.join(identityHome(), LEGACY_BUNDLE)
  if (fs.existsSync(bundle)) {
    try {
      fs.rmSync(bundle, { force: true })
      notes.push('stable CLI bundle removed')
    } catch {
      /* a locked file stays inert */
    }
  }
  if (notes.length === 0) return null
  log.debug(`legacy cleanup: ${notes.join('; ')}`)
  return { name: 'legacy', status: 'changed', detail: notes.join('; ') }
}

// ─── all together ───────────────────────────────────────────────────────────

/**
 * Place everything for the current identity (or the offer when there is none).
 * Never throws; each step reports. The key and the MCP block need an identity.
 * `manual` is what the served texts announce (null when none are in hand: an
 * existing skill is kept, a missing one gets the bundled copy).
 */
export async function placeAll(identity: PlacementIdentity | null, manual: ServedManual | null): Promise<PlacementStep[]> {
  const steps: PlacementStep[] = []
  const legacy = removeLegacyWiring()
  if (legacy) steps.push(legacy)
  steps.push(await placeSkill(manual, identity?.apiBase ?? null))
  if (identity) {
    steps.push(placeKey(identity.apiKey))
    steps.push(placeMcp(identity.apiBase))
    steps.push(placeIdentityLine(identity.handle, identity.identityLine))
  } else {
    steps.push(placeOffer())
  }
  return steps
}

/** Logout: the key leaves Codex; the MCP block (a template on the variable), the manual and the skill stay. */
export function unplaceIdentity(): PlacementStep[] {
  return [removeKey(), placeOffer()]
}

/** Uninstall: everything this integration placed, the identity line included. */
export function removePlacement(): PlacementStep[] {
  const steps: PlacementStep[] = []
  const legacy = removeLegacyWiring()
  if (legacy) steps.push(legacy)
  steps.push(removeKey())
  steps.push(removeMcp())
  steps.push(removeSkill())
  steps.push({ name: 'identity', status: removeAnchorAt(anchorFile()) === 'removed' ? 'changed' : 'ok', detail: `${path.basename(anchorFile())} AgentChat block removed` })
  return steps
}

export interface PlacementCheck {
  readonly name: 'key' | 'mcp' | 'identity' | 'manual' | 'legacy'
  readonly ok: boolean
  readonly detail: string
  /** The doctor verdict when it is not the default mapping of `ok`. */
  readonly verdict?: 'PASS' | 'WARN' | 'FAIL'
}

/**
 * For `status` and `doctor`: is everything where it should be? `manual` is
 * what the served texts announce (null when none are in hand), so the skill
 * reads `current (2.2.0)` or `stale (have 2.1.2, served 2.2.0)`.
 */
export function checkPlacement(identity: PlacementIdentity | null, manual: ServedManual | null): PlacementCheck[] {
  const checks: PlacementCheck[] = []
  if (identity) {
    // The template recognises a block an earlier release wrote in today's
    // served words (no handle line), so it reads as older text, not missing.
    const claimed = readAnchorHandleAt(anchorFile(), identity.identityLineTemplate)
    // null: the served texts were unavailable, so only the handle can be checked.
    const current = identity.identityLine === null ? null : anchorIsCurrentAt(anchorFile(), identity.identityLine, identity.handle)
    // This agent's block in older words (or without the handle line) still
    // tells the agent who it is: not current, nothing broken — a WARN (`–`),
    // as the shared doctor reports it. A wrong handle or no block is a FAIL.
    const older = current === false && claimed === identity.handle
    checks.push({
      name: 'identity',
      ok: current === true || (current === null && claimed === identity.handle),
      ...(older ? { verdict: 'WARN' as const } : {}),
      detail: current === true
        ? `identity line for @${identity.handle} in ${anchorFile()}`
        : current === null && claimed === identity.handle
          ? `identity line for @${identity.handle} in ${anchorFile()} (served texts unavailable — currency not checked)`
        : claimed === null
          ? `identity line missing from ${anchorFile()}`
          : claimed !== identity.handle
            ? `${anchorFile()} says @${claimed} but this agent is @${identity.handle}`
            : `${anchorFile()} carries an older identity text`,
    })
    const inDotEnv = readKeyFromDotEnv()
    checks.push({
      name: 'key',
      ok: inDotEnv === identity.apiKey,
      detail:
        inDotEnv === identity.apiKey
          ? `${API_KEY_ENV} in ${dotEnvPath()} matches this agent's credentials`
          : inDotEnv === undefined
            ? `${API_KEY_ENV} is not in ${dotEnvPath()} — the hosted tools cannot authenticate`
            : `${API_KEY_ENV} in ${dotEnvPath()} differs from this agent's credentials`,
    })
  }
  const skill = checkManual({ path: skillPath(), served: manual, apiBase: identity?.apiBase ?? null })
  // `unchecked` (nothing announced: no account yet, or offline with nothing
  // cached) is a WARN with no repair to suggest; `stale` and `missing` are
  // what `doctor --fix` repairs.
  checks.push({ name: 'manual', ok: skill.state === 'current' || skill.state === 'unchecked', verdict: skill.verdict, detail: skill.detail })
  const mcp = inspectMcpBlock(identity?.apiBase ?? process.env['AGENTCHAT_API_BASE']?.trim() ?? 'https://api.agentchat.me')
  checks.push({
    name: 'mcp',
    ok: mcp === 'current' || mcp === 'foreign',
    detail:
      mcp === 'current'
        ? `[mcp_servers.${MCP_SERVER_NAME}] → hosted tools, bearer token from ${API_KEY_ENV}`
        : mcp === 'foreign'
          ? `[mcp_servers.${MCP_SERVER_NAME}] is managed by hand in ${configPath()}`
          : mcp === 'stale'
            ? `the agentchat block in ${configPath()} is from an older release`
            : `no [mcp_servers.${MCP_SERVER_NAME}] in ${configPath()} — the agent has no AgentChat tools`,
  })
  const leftovers = [legacyHooksPresent() ? 'hooks in hooks.json' : null, legacyBundlePresent() ? 'stable CLI bundle' : null].filter((v): v is string => v !== null)
  checks.push({ name: 'legacy', ok: leftovers.length === 0, detail: leftovers.length === 0 ? 'no pre-0.1.0 wiring left' : `pre-0.1.0 wiring still present: ${leftovers.join(', ')}` })
  return checks
}

/** ✓ done / current, – not done but nothing broken (a stale manual, an unchecked one), ✗ failed / missing. */
export function placementMark(step: PlacementStep | PlacementCheck): string {
  if ('status' in step) return step.status === 'failed' ? '✗' : step.status === 'skipped' || step.status === 'warned' ? '–' : '✓'
  if (step.verdict !== undefined) return step.verdict === 'PASS' ? '✓' : step.verdict === 'WARN' ? '–' : '✗'
  return step.ok ? '✓' : '✗'
}

export function formatPlacement(steps: readonly (PlacementStep | PlacementCheck)[]): string[] {
  return steps.map((step) => `  ${placementMark(step)} ${step.name}: ${step.detail}`)
}
