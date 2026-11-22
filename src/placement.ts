import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  atomicWriteFile,
  checkManual,
  clientHeadersOf,
  describeManualSync,
  hostedMcpUrl,
  log,
  offerDeclined,
  placeAnchorAt,
  readCachedTexts,
  removeAnchorAt,
  renderAnchorBlock,
  renderDeclinedBlock,
  renderUnregisteredBlock,
  syncManual,
  writeAnchor,
  writeOfferAt,
  type ManualSyncResult,
  type ServedManual,
} from '@agentchatme/agent-core'
import { API_KEY_ENV, CLIENT, MCP_SERVER_NAME, anchorFile, anchorLoadNote, configPath, dotEnvPath, hooksPath, hostCopy, identityHome, invocation, skillDir, skillPath } from './host.js'
import { headersHelperCommand, headersHelperPathFor, headersHelperProblem, headersHelperState, writeHeadersHelper } from './headers-helper.js'

// ─── Placement: the four texts, where Codex loads them ──────────────────────
//
// 1. **The key** — in the identity home's `credentials` (0600) only. Codex
//    gets it on each connection from the headers helper (headers-helper.ts):
//    `http_headers_helper` names two quoted paths, Node and
//    `<identity home>/bin/mcp-headers.mjs`, which prints the Authorization
//    header from `credentials`. Releases up to 0.5.2 wrote
//    `AGENTCHAT_API_KEY=<key>` into `$CODEX_HOME/.env`; Codex loads that file
//    into its own environment at startup (codex-rs/arg0 `load_dotenv`), and a
//    session's commands inherit Codex's environment (`shell_environment_policy`
//    defaults to `inherit = "all"` with the KEY/SECRET/TOKEN excludes off,
//    codex-rs/config/src/shell_environment_policy.rs), so every command a
//    session ran had the key. Placement now takes that line out — when it holds
//    this agent's key; any other value is not this integration's to delete,
//    and is said instead.
// 2. **The tools** — `[mcp_servers.agentchat]` in `$CODEX_HOME/config.toml`:
//    `url = "https://api.agentchat.me/mcp"` and `http_headers_helper` (the
//    streamable-HTTP transport fields in codex-rs/config/src/mcp_types.rs).
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
// Legacy cleanup on upgrade: the four lifecycle hooks the hook-based releases wrote
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

/**
 * Drop every line that sets `name` (to `value` only, when given); every other
 * line is kept byte for byte, its line endings included. Pure.
 */
export function removeDotEnvLine(content: string, name: string, value?: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const next = content.split(/\r?\n/).filter((line) => !lineSetsVariable(line, name) || (value !== undefined && valueOfLine(line) !== value))
  return next.join(eol)
}

/** The value a `NAME=value` (or `export NAME=value`) line sets, unquoted. */
function valueOfLine(line: string): string {
  return stripQuotes(line.slice(line.indexOf('=') + 1).trim())
}

/** Every value `.env` sets the key variable to, in order. */
export function keysInDotEnv(): string[] {
  try {
    return fs
      .readFileSync(dotEnvPath(), 'utf-8')
      .split(/\r?\n/)
      .filter((line) => lineSetsVariable(line, API_KEY_ENV))
      .map(valueOfLine)
      .filter((v) => v.length > 0)
  } catch {
    return []
  }
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

/**
 * Take this agent's key out of `$CODEX_HOME/.env`, where releases up to 0.5.2
 * put it: only the lines that hold exactly this key (every other line is kept
 * byte for byte; a file left empty is removed). Any other value is left where
 * it is and said: it may be the only copy of someone's key.
 */
export function clearDotEnvKey(apiKey: string): PlacementStep {
  const file = dotEnvPath()
  const key = apiKey.trim()
  try {
    const held = keysInDotEnv()
    if (held.length === 0) return { name: 'key', status: 'ok', detail: `the key is in ${path.join(identityHome(), 'credentials')} only (none in ${file})` }
    const others = held.some((v) => v !== key)
    if (held.includes(key)) {
      const existing = fs.readFileSync(file, 'utf-8')
      const next = removeDotEnvLine(existing, API_KEY_ENV, key)
      if (next.trim().length === 0) fs.rmSync(file, { force: true })
      else atomicWriteFile(file, next, fs.statSync(file).mode & 0o777)
    }
    if (others) {
      return {
        name: 'key',
        status: 'warned',
        detail: `${file} sets ${API_KEY_ENV} to a key that is not this agent's: Codex exports it to every command a session runs, and it no longer reaches the AgentChat tools — remove that line unless something else of yours needs it`,
      }
    }
    return {
      name: 'key',
      status: 'changed',
      detail: `${API_KEY_ENV} taken out of ${file} (an earlier release kept the key there, so Codex exported it to every command a session ran; a Codex already running keeps it until it restarts)`,
    }
  } catch (err) {
    return { name: 'key', status: 'failed', detail: `could not update ${file}: ${String(err)}` }
  }
}

/**
 * For a `[mcp_servers.agentchat]` written by hand that reads its bearer token
 * from `AGENTCHAT_API_KEY`: keep that variable in `.env` at this agent's key,
 * as releases up to 0.5.2 did, so the entry keeps working across a new key.
 * Said as a warning: Codex exports it to every command a session runs.
 */
export function keepDotEnvKeyForHandWritten(apiKey: string): PlacementStep {
  const trimmed = apiKey.trim()
  const warning = `your own [mcp_servers.${MCP_SERVER_NAME}] reads ${API_KEY_ENV}, so this agent's key is kept in ${dotEnvPath()} — Codex exports it to every command a session runs; remove that entry (the installer then writes one that reads the key from ${path.join(identityHome(), 'credentials')}) to keep it out`
  if (!trimmed || /[\r\n#"'\s]/.test(trimmed)) return { name: 'key', status: 'failed', detail: 'the key is empty or contains characters a .env line cannot carry' }
  try {
    const file = dotEnvPath()
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
    const next = upsertDotEnvLine(existing, API_KEY_ENV, trimmed)
    if (next !== existing) atomicWriteFile(file, next, 0o600)
    return { name: 'key', status: 'warned', detail: warning }
  } catch (err) {
    return { name: 'key', status: 'failed', detail: `could not write ${API_KEY_ENV} to ${dotEnvPath()}: ${String(err)}` }
  }
}

/** Whether a hand-written `[mcp_servers.agentchat]` names `AGENTCHAT_API_KEY` (its bearer variable). */
export function handWrittenReadsKeyVariable(): boolean {
  const text = handWrittenAgentchatServer(readConfigText())
  return text !== null && new RegExp(`\\b${API_KEY_ENV}\\b`).test(text)
}

/**
 * Logout and uninstall: the `.env` lines that hold this agent's key (`apiKey`)
 * go. Without the key in hand nothing is removed, and any other value is left
 * and said: it may be the only copy of someone's key.
 */
export function removeKey(apiKey: string | null): PlacementStep {
  const file = dotEnvPath()
  try {
    const held = keysInDotEnv()
    if (held.length === 0) return { name: 'key', status: 'ok', detail: `no ${API_KEY_ENV} in ${file}` }
    const key = apiKey?.trim() ?? null
    const ours = key !== null && held.includes(key)
    if (ours) {
      const existing = fs.readFileSync(file, 'utf-8')
      const next = removeDotEnvLine(existing, API_KEY_ENV, key)
      if (next.trim().length === 0) fs.rmSync(file, { force: true })
      else atomicWriteFile(file, next, fs.statSync(file).mode & 0o777)
    }
    if (held.some((v) => v !== key)) {
      return { name: 'key', status: 'warned', detail: `${file} sets ${API_KEY_ENV} to a key that is not this agent's; left as it is — remove that line unless something else of yours needs it` }
    }
    return { name: 'key', status: 'changed', detail: `${API_KEY_ENV} removed from ${file}` }
  } catch (err) {
    return { name: 'key', status: 'failed', detail: `could not update ${file}: ${String(err)}` }
  }
}

// ─── the tools: [mcp_servers.agentchat] in config.toml ──────────────────────

function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `"${escaped}"`
}

/** The header the hosted tool server reads the client's name from (core `client-context.ts`). */
export const CLIENT_HEADER = 'X-AgentChat-Client'

/**
 * `http_headers = { "X-AgentChat-Client" = "codex", "X-AgentChat-Client-Version" = "<this version>" }`:
 * the client identity (agent-core's `clientHeadersOf`, the names the server
 * reads) on every request Codex makes to the hosted tools. It is how the
 * server knows this agent is on Codex, woken by its listener, and so shows
 * it no wake-webhook tools and spells the tool names the way Codex exposes
 * them. Codex reads `http_headers` for a streamable-HTTP server since before
 * the oldest version this integration accepts (`MIN_CODEX_VERSION`, 0.154.0:
 * codex-rs `config/src/mcp_types.rs`, `rmcp-client/src/utils.rs`).
 */
export function mcpHttpHeadersLine(): string {
  const pairs = Object.entries(clientHeadersOf(CLIENT)).map(([name, value]) => `${tomlBasicString(name)} = ${tomlBasicString(value)}`)
  return `http_headers = { ${pairs.join(', ')} }`
}

/** The helper command this release writes for the identity home (null: a path no shell quoting can carry). */
export function currentHeadersHelperCommand(): string | null {
  return headersHelperCommand(headersHelperPathFor(identityHome()))
}

export function mcpBlock(apiBase: string, helper: string): string {
  return [
    TOML_START,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `url = "${hostedMcpUrl(apiBase)}"`,
    '# The key: Codex runs this on each connection and sends the Authorization header it prints, read from agentchat/credentials. No key in this file or in .env.',
    `http_headers_helper = ${tomlBasicString(helper)}`,
    '# Names this runtime to the hosted tools: no wake-webhook tools for an agent the listener wakes.',
    mcpHttpHeadersLine(),
    'startup_timeout_sec = 30',
    '# Auto-run the AgentChat tools without a prompt, scoped to THIS server only.',
    'default_tools_approval_mode = "approve"',
    TOML_END,
  ].join('\n')
}

/** The `http_headers_helper` value inside our fence, or undefined. */
export function fencedHelperCommand(config: string): string | undefined {
  const start = config.indexOf(TOML_START)
  const end = config.indexOf(TOML_END)
  if (start < 0 || end <= start) return undefined
  const line = /^http_headers_helper = ("(?:[^"\\]|\\.)*")\s*$/m.exec(config.slice(start, end))
  if (line === null) return undefined
  try {
    return JSON.parse(line[1]!) as string
  } catch {
    return undefined
  }
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

/**
 * The text of a hand-written `[mcp_servers.agentchat]` outside our fence: its
 * table and any `[mcp_servers.agentchat.*]` sub-table (`http_headers` may be
 * written either way), or null when there is none. Read only for a hint;
 * the entry is the user's and is never edited.
 */
export function handWrittenAgentchatServer(existing: string): string | null {
  const lines: string[] = []
  let inside = false
  let found = false
  for (const line of stripTomlBlock(existing).split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line)
    if (header && !line.trimStart().startsWith('[[')) {
      const name = header[1]!.replace(/\s+/g, '')
      inside = name === `mcp_servers.${MCP_SERVER_NAME}` || name.startsWith(`mcp_servers.${MCP_SERVER_NAME}.`)
      found ||= inside
    }
    if (inside) lines.push(line)
  }
  return found ? lines.join('\n') : null
}

/** Whether a hand-written entry sends the client header (case-insensitive, as HTTP header names are). */
export function handWrittenSendsClientHeader(existing: string): boolean {
  const text = handWrittenAgentchatServer(existing)
  return text !== null && new RegExp(CLIENT_HEADER, 'i').test(text)
}

/** A hand-written `[mcp_servers.agentchat]` outside our fence would collide (duplicate TOML table). */
export function hasUnfencedAgentchatServer(existing: string): boolean {
  return new RegExp(`^\\s*\\[mcp_servers\\.${MCP_SERVER_NAME}\\]`, 'm').test(stripTomlBlock(existing))
}

export type McpBlockState = 'current' | 'stale' | 'missing' | 'foreign'

function readConfigText(): string {
  try {
    return fs.readFileSync(configPath(), 'utf-8')
  } catch {
    return ''
  }
}

/**
 * `current`: our block, in this release's words, with a helper that works as
 * written (our script, a Node that is there — not necessarily the Node this
 * command runs on, so switching Node versions does not churn the file).
 */
export function inspectMcpBlock(apiBase: string): McpBlockState {
  let config = ''
  try {
    config = fs.readFileSync(configPath(), 'utf-8')
  } catch {
    return 'missing'
  }
  if (hasUnfencedAgentchatServer(config)) return 'foreign'
  const helper = fencedHelperCommand(config)
  if (helper !== undefined && headersHelperState(helper, identityHome()) === 'current' && config.includes(mcpBlock(apiBase, helper))) return 'current'
  return config.includes(TOML_START) ? 'stale' : 'missing'
}

export function placeMcp(apiBase: string, apiKey?: string): PlacementStep {
  const file = configPath()
  const state = inspectMcpBlock(apiBase)
  if (state === 'foreign') {
    return { name: 'mcp', status: 'skipped', detail: `${file} already defines [mcp_servers.${MCP_SERVER_NAME}] outside the agentchat block — left untouched; remove it and re-run if it is not yours` }
  }
  try {
    writeHeadersHelper(identityHome())
  } catch (err) {
    return { name: 'mcp', status: 'failed', detail: `could not write the headers helper ${headersHelperPathFor(identityHome())}: ${String(err)}` }
  }
  const keyNote = `the key stays in ${path.join(identityHome(), 'credentials')}; Codex asks ${headersHelperPathFor(identityHome())} for it`
  if (state === 'current') return { name: 'mcp', status: 'ok', detail: `[mcp_servers.${MCP_SERVER_NAME}] → ${hostedMcpUrl(apiBase)} (${keyNote}) in ${file}` }
  const helper = currentHeadersHelperCommand()
  if (helper === null) {
    return { name: 'mcp', status: 'failed', detail: `the path of Node (${process.execPath}) or of ${headersHelperPathFor(identityHome())} holds a character a shell command cannot carry quoted; move it, then re-run` }
  }
  // Before the old block is replaced: the helper, run as Codex runs it, yields this agent's key.
  const problem = apiKey !== undefined ? headersHelperProblem(helper, apiKey, identityHome()) : null
  if (problem !== null) return { name: 'mcp', status: 'failed', detail: `[mcp_servers.${MCP_SERVER_NAME}] left as it was: ${problem}` }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
    let mode = 0o600
    try {
      mode = fs.statSync(file).mode & 0o777
    } catch {
      /* new file: private */
    }
    atomicWriteFile(file, upsertTomlBlock(existing, mcpBlock(apiBase, helper)), mode)
  } catch (err) {
    return { name: 'mcp', status: 'failed', detail: `could not write ${file}: ${String(err)}` }
  }
  return {
    name: 'mcp',
    status: 'changed',
    detail: `[mcp_servers.${MCP_SERVER_NAME}] → ${hostedMcpUrl(apiBase)} (${keyNote}) in ${file}${state === 'stale' ? ' (the previous entry was replaced)' : ''}`,
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
  // The hook-based releases kept the manual at <home>/SKILL.md, outside any
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

export function placeIdentityLine(handle: string, identityLine: string | null, mode: 'setup' | 'repair' = 'setup', template: string | null = null): PlacementStep {
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
    // One policy for every integration (agent-core's `placeAnchorAt`, on the
    // kit's `decide`): this agent's block is updated (or placed where there is
    // none), in place and atomically; a block edited by hand, or several, is
    // left with the remedy; another agent's is replaced at setup and said,
    // refused by `doctor --fix`.
    const placed = placeAnchorAt(anchorFile(), { handle, identityLine, template, mode, fix: `${invocation()} doctor --fix` })
    // Placed; but Codex reads a non-empty AGENTS.override.md instead, whose block is what counts (never written here).
    const loads = anchorLoadNote(handle, { identityLine, template })
    const note = loads !== null ? `; ${loads.note}` : ''
    switch (placed.outcome) {
      case 'unchanged':
      case 'placed':
      case 'updated': {
        const detail = `identity line for @${handle} in ${anchorFile()}${note}`
        if (loads !== null && !loads.ok) return { name: 'identity', status: 'warned', detail }
        return { name: 'identity', status: placed.outcome === 'unchanged' ? 'ok' : 'changed', detail }
      }
      case 'replaced_other':
        return { name: 'identity', status: loads !== null && !loads.ok ? 'warned' : 'changed', detail: `${placed.detail}${note}` }
      case 'failed':
        return { name: 'identity', status: 'failed', detail: placed.detail }
      default:
        return { name: 'identity', status: 'warned', detail: placed.detail }
    }
  } catch (err) {
    return { name: 'identity', status: 'failed', detail: `could not write the identity line to ${anchorFile()}: ${String(err)}` }
  }
}

/**
 * No identity yet: the wizard's offer (or the silent variant after
 * --not-now), never over a block that is not itself an offer (`writeOfferAt`):
 * a block the user wrote, or one a logout left, stays as it is.
 */
export function placeOffer(): PlacementStep {
  try {
    const declined = offerDeclined(identityHome())
    const written = writeOfferAt(anchorFile(), declined ? renderDeclinedBlock(hostCopy()) : renderUnregisteredBlock(hostCopy()))
    if (written.action === 'kept') return { name: 'identity', status: 'warned', detail: written.detail }
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

/** Strip the hook-based releases' hooks and stable CLI bundle. Idempotent. */
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
/**
 * Every placement for an identity (or the setup offer without one). `identityMode`:
 * `setup` for install, register, login and recover; `repair` for `doctor --fix`
 * (another agent's identity block is refused, not replaced).
 */
export async function placeAll(identity: PlacementIdentity | null, manual: ServedManual | null, identityMode: 'setup' | 'repair' = 'setup'): Promise<PlacementStep[]> {
  const steps: PlacementStep[] = []
  const legacy = removeLegacyWiring()
  if (legacy) steps.push(legacy)
  steps.push(await placeSkill(manual, identity?.apiBase ?? null))
  if (identity) {
    // The tools first: the key leaves .env only once our block, with the
    // helper, serves it. A block written by hand that reads AGENTCHAT_API_KEY
    // keeps it there, as before.
    const mcp = placeMcp(identity.apiBase, identity.apiKey)
    steps.push(mcp)
    if (mcp.status === 'ok' || mcp.status === 'changed') steps.push(clearDotEnvKey(identity.apiKey))
    else if (mcp.status === 'skipped' && handWrittenReadsKeyVariable()) steps.push(keepDotEnvKeyForHandWritten(identity.apiKey))
    steps.push(placeIdentityLine(identity.handle, identity.identityLine, identityMode, identity.identityLineTemplate))
  } else {
    steps.push(placeOffer())
  }
  return steps
}

/**
 * Logout: the credential is gone, so the helper yields no key; an
 * `AGENTCHAT_API_KEY` line an earlier release left in `.env` goes too. The
 * MCP block, the manual and the skill stay.
 */
export function unplaceIdentity(apiKey: string | null): PlacementStep[] {
  // A block logout left (not this agent's) also keeps the offer out; logout's
  // own line already says what was left, so the offer step says nothing then.
  const offer = placeOffer()
  return offer.status === 'warned' ? [removeKey(apiKey)] : [removeKey(apiKey), offer]
}

/**
 * Uninstall: everything this integration placed, the identity line included —
 * this agent's (`handle`) identity block only, or the setup offer; a block the
 * user wrote, or another agent's, is left and said.
 */
export function removePlacement(apiKey: string | null, handle: string | null = null): PlacementStep[] {
  const steps: PlacementStep[] = []
  const legacy = removeLegacyWiring()
  if (legacy) steps.push(legacy)
  steps.push(removeKey(apiKey))
  steps.push(removeMcp())
  try {
    // The helper holds no key; with the block gone nothing runs it.
    fs.rmSync(headersHelperPathFor(identityHome()), { force: true })
  } catch {
    /* a locked file stays inert */
  }
  steps.push(removeSkill())
  try {
    const cached = readCachedTexts(identityHome(), CLIENT.runtime)
    const removed = removeAnchorAt(anchorFile(), { handle, identityLine: cached?.texts.identity_line ?? null, template: cached?.texts.identity_line_template ?? null })
    steps.push(
      removed.action === 'kept'
        ? { name: 'identity', status: 'warned', detail: removed.detail }
        : { name: 'identity', status: removed.action === 'removed' ? 'changed' : 'ok', detail: removed.action === 'removed' ? `${path.basename(anchorFile())} AgentChat block removed` : `no AgentChat block in ${path.basename(anchorFile())}` },
    )
  } catch (err) {
    steps.push({ name: 'identity', status: 'failed', detail: `could not remove the AgentChat block from ${anchorFile()}: ${err instanceof Error ? err.message : String(err)} — remove it by hand` })
  }
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
    // The identity line is not one of these: agent-core's `status` header and
    // `doctor` (`identity-line`) read it with the daemon's own rules and say
    // it once (with what Codex loads from AGENTS.override.md, `anchorLoadNote`).
    const inDotEnv = keysInDotEnv()
    const handWritten = inspectMcpBlock(identity.apiBase) === 'foreign' && handWrittenReadsKeyVariable()
    checks.push(
      handWritten
        ? {
            name: 'key',
            ok: inDotEnv.length > 0 && inDotEnv.every((v) => v === identity.apiKey),
            verdict: inDotEnv.length > 0 && inDotEnv.every((v) => v === identity.apiKey) ? 'WARN' : 'FAIL',
            detail:
              inDotEnv.length > 0 && inDotEnv.every((v) => v === identity.apiKey)
                ? `in ${dotEnvPath()} for your own [mcp_servers.${MCP_SERVER_NAME}], which reads ${API_KEY_ENV}: Codex exports it to every command a session runs`
                : `your own [mcp_servers.${MCP_SERVER_NAME}] reads ${API_KEY_ENV}, and ${dotEnvPath()} does not hold this agent's key there`,
          }
        : {
            name: 'key',
            ok: inDotEnv.length === 0,
            ...(inDotEnv.some((v) => v !== identity.apiKey) ? { verdict: 'WARN' as const } : {}),
            detail:
              inDotEnv.length === 0
                ? `in ${path.join(identityHome(), 'credentials')} only`
                : inDotEnv.some((v) => v !== identity.apiKey)
                  ? `${dotEnvPath()} sets ${API_KEY_ENV} to a key that is not this agent's: Codex exports it to every command a session runs, and it no longer reaches the AgentChat tools — remove that line unless something else of yours needs it`
                  : `${dotEnvPath()} still holds this agent's key (an earlier release put it there), so Codex exports it to every command a session runs — install or \`doctor --fix\` takes it out`,
          },
    )
  }
  const skill = checkManual({ path: skillPath(), served: manual, apiBase: identity?.apiBase ?? null })
  // `unchecked` (nothing announced: no account yet, or offline with nothing
  // cached) is a WARN with no repair to suggest; `stale` and `missing` are
  // what `doctor --fix` repairs.
  checks.push({ name: 'manual', ok: skill.state === 'current' || skill.state === 'unchecked', verdict: skill.verdict, detail: skill.detail })
  const mcp = inspectMcpBlock(identity?.apiBase ?? process.env['AGENTCHAT_API_BASE']?.trim() ?? 'https://api.agentchat.me')
  const handWrittenNamesClient = mcp === 'foreign' && handWrittenSendsClientHeader(readConfigText())
  // Only for a block that is otherwise right: run its helper the way Codex will.
  const helperProblem = mcp === 'current' && identity ? headersHelperProblem(fencedHelperCommand(readConfigText()), identity.apiKey, identityHome()) : null
  checks.push({
    name: 'mcp',
    // A hand-written entry is the user's: nothing for this integration to
    // repair (ok), but said — a WARN — when it does not name this runtime to
    // the hosted tools: they then show it the wake-webhook tools, a second
    // way of being woken it does not need.
    ok: (mcp === 'current' && helperProblem === null) || mcp === 'foreign',
    ...(mcp === 'foreign' && !handWrittenNamesClient ? { verdict: 'WARN' as const } : {}),
    detail:
      mcp === 'current'
        ? helperProblem !== null
          ? `[mcp_servers.${MCP_SERVER_NAME}]: ${helperProblem}`
          : `[mcp_servers.${MCP_SERVER_NAME}] → hosted tools, the key from ${headersHelperPathFor(identityHome())} (it reads ${path.join(identityHome(), 'credentials')}), named as Codex ${CLIENT.version}`
        : mcp === 'foreign'
          ? handWrittenNamesClient
            ? `[mcp_servers.${MCP_SERVER_NAME}] is managed by hand in ${configPath()}`
            : `[mcp_servers.${MCP_SERVER_NAME}] is managed by hand in ${configPath()} and does not send ${CLIENT_HEADER}, so the hosted tools take this agent for an unknown client and show it the wake-webhook tools — add \`${mcpHttpHeadersLine()}\` to it`
          : mcp === 'stale'
            ? `the agentchat block in ${configPath()} is from an older release, or its headers helper (${headersHelperPathFor(identityHome())}) or its Node is gone`
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
