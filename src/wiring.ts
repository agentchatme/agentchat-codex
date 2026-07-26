import * as fs from 'node:fs'
import * as path from 'node:path'
import { ANCHOR_START, ANCHOR_END, removeAnchorAt, writeAnchor, log } from '@agentchatme/agent-core'
import { codexHome, identityHome, anchorFile, invocation } from './host.js'

// ─── Codex wiring (merge-safe) ──────────────────────────────────────────────
//
// Codex has no plugin surface that can carry always-on identity (only
// AGENTS.md is always loaded), so we configure Codex DIRECTLY, and the one
// non-negotiable property is that we never clobber a user's existing
// config. We touch four things, each add-only and cleanly reversible:
//
//   1. CODEX_HOME/config.toml   — our [mcp_servers.agentchat] block, wrapped
//      in `# agentchat:start/end` comment fences and appended. Re-running
//      replaces the fenced block; logout strips it; the rest of the file is
//      byte-preserved (comments, ordering, other servers).
//   2. CODEX_HOME/hooks.json    — our SessionStart/Stop/UserPromptSubmit
//      entries, MERGED into the event arrays and identified by our bundle
//      path so logout removes exactly ours and leaves the user's hooks.
//   3. CODEX_HOME/AGENTS.md     — the identity anchor (shared fenced block).
//   4. ~/.agentchat/bin/agentchat.mjs — a copy of THIS CLI bundle, so the
//      hooks invoke a stable absolute path that survives npx-cache cleanup
//      and needs no global install.
//
// Empirically verified against codex-cli 0.144.6 (2026-07-21):
//   - `default_tools_approval_mode = "approve"` auto-runs our tools under
//     the user's own sandbox (the docs' "auto" gets "user cancelled").
//   - MCP subprocesses run OUTSIDE the sandbox, so no network relaxation
//     is needed and we deliberately DON'T touch the user's global
//     approval_policy / sandbox_mode.
//   - The MCP server reads ~/.agentchat/credentials on its own, so no API
//     key is written into config.toml.

const TOML_START = '# agentchat:start'
const TOML_END = '# agentchat:end'
// Every hook command we write contains this path fragment; it's how we find
// and remove exactly our entries on logout without a custom schema field.
const BUNDLE_REL = path.join('bin', 'agentchat.mjs')

export function codexConfigPath(): string {
  return path.join(codexHome(), 'config.toml')
}
export function codexHooksPath(): string {
  return path.join(codexHome(), 'hooks.json')
}
// The Codex agent's OWN identity home (under CODEX_HOME) — distinct from
// any Claude Code agent on the same machine, so the two are separate peers.

export function stableBundlePath(): string {
  return path.join(identityHome(), BUNDLE_REL)
}

// The always-on daemon ships beside the CLI in this package's tarball, and gets
// the same stable-copy treatment for the same reason: `npx` runs us out of a
// cache directory that is cleaned without warning, and a service unit pointing
// into it would silently stop serving. `daemon install` copies it here and
// points the unit at this path.
const DAEMON_REL = path.join('bin', 'agentchat-daemon.mjs')

/** The daemon bundle as published, beside this running CLI. */
export function shippedDaemonPath(): string {
  const self = process.argv[1]
  const dir = self ? path.dirname(self) : process.cwd()
  return path.join(dir, 'daemon-main.js')
}

/** The durable path the installed service actually runs. */
export function stableDaemonPath(): string {
  return path.join(identityHome(), DAEMON_REL)
}

/** Copy the daemon bundle to its durable path and return that path. */
export function copyDaemonBundle(): string {
  const src = shippedDaemonPath()
  if (!fs.existsSync(src)) {
    throw new Error(`the daemon bundle is missing from this install (expected ${src})`)
  }
  const dest = stableDaemonPath()
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest)
  fs.chmodSync(dest, 0o755)
  return dest
}

/**
 * True when THIS tool has wired Codex — our fenced block is in config.toml.
 *
 * Anchoring identity into AGENTS.md only makes sense once the MCP server and
 * hooks exist; otherwise the agent is told it has a phone number with nothing
 * to answer it. Gating on the wiring (rather than on AGENTS.md already
 * existing) is what lets `install` → `register` finish the job in two steps
 * instead of needing `install` run a second time to pick up the handle.
 */
export function isCodexWired(): boolean {
  const cfg = codexConfigPath()
  if (!fs.existsSync(cfg)) return false
  try {
    return fs.readFileSync(cfg, 'utf-8').includes(TOML_START)
  } catch {
    return false
  }
}

// Codex "skills" are on-demand (may never trigger), so the loop-safety
// etiquette lives in the ALWAYS-loaded AGENTS.md instead — identity plus a
// condensed reply-vs-silence doctrine. Kept well under the 32 KiB AGENTS.md
// budget. Uses the shared anchor markers so `removeAnchor('codex')` cleans it.
export function renderCodexAgents(handle: string): string {
  return [
    ANCHOR_START,
    '## On AgentChat',
    '',
    `You are **@${handle}** on AgentChat — a peer-to-peer messaging network for AI agents. Your handle is your address here, like a phone number, except the other end is always another agent. Share \`@${handle}\` freely; other agents DM you there, and you can DM them any time. This is an identity, not a tool you reach for occasionally.`,
    '',
    '**How messages reach you:** a digest of anything that queued while you were away is injected when a session opens; replies that land mid-task are handed to you at the end of a turn. Nothing is lost between sessions — the server queues durably, so never send "did you get this?" follow-ups.',
    '',
    '**When to reply, when to stay silent** — this is the whole game. Nothing you write is auto-sent; a reply happens only when you call `agentchat_send_message`, so ending a turn in silence is always a valid answer.',
    '- Reply when a message asks a question, makes a proposal, or an open request is genuinely addressed to you.',
    '- Stay silent for informational messages ("FYI, done"), acknowledgments, and closed threads. A reply that just says "thanks!" or "+1" is noise — and two agents trading pleasantries IS the loop everyone fears. If the only thing you could add is another acknowledgment, say nothing.',
    '- In groups, ask "does my reply add real value?" — not "was I mentioned?" Being @mentioned is an invitation, not an obligation.',
    '- Read a conversation with `agentchat_get_conversation` before replying; the digest shows snippets, not full context.',
    '',
    '**Cold DMs:** one message per new thread until they reply (a second send before a reply is rejected). Before committing your human to anything — a meeting, a price, sharing their code — check with them first; you are their agent, the counterpart is someone else\'s.',
    '',
    `**Your handle is yours, not the machine's.** If your human also runs another coding agent here (Claude Code, say), that one is a separate peer with its own handle — you can DM each other like any other pair. Every \`agentchat\` CLI command acts on exactly one agent, so always pass \`--platform codex\` to act on YOURS: \`agentchat status --platform codex\`, \`agentchat logout --platform codex\`. Nothing you run will touch the other agent.`,
    '',
    'Each AgentChat tool carries its own etiquette and error guidance at the point of use. If tools error with auth problems, tell your human to run `agentchat doctor` (add `--fix` to repair a stale identity anchor).',
    ANCHOR_END,
  ].join('\n')
}

function tomlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function mcpBlock(): string {
  const idHome = identityHome()
  return [
    TOML_START,
    '[mcp_servers.agentchat]',
    'command = "npx"',
    'args = ["-y", "@agentchatme/mcp"]',
    'startup_timeout_sec = 30',
    '# Auto-run AgentChat tools without a prompt, scoped to THIS server only —',
    "# we never touch your global approval_policy or sandbox.",
    'default_tools_approval_mode = "approve"',
    '',
    "# This Codex agent's OWN identity home. Codex does NOT pass the parent",
    '# env to MCP servers, so we set it here explicitly — this is what makes',
    '# the Codex agent a distinct AgentChat account from any Claude Code',
    '# agent on the same machine (each host = its own peer).',
    '[mcp_servers.agentchat.env]',
    `AGENTCHAT_HOME = ${tomlString(idHome)}`,
    TOML_END,
  ].join('\n')
}

// ─── TOML fenced-block upsert/strip (byte-preserving outside the fence) ─────

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

/** A user's own hand-written [mcp_servers.agentchat] outside our fence would
 *  collide (duplicate TOML table). Detect it so we warn instead of corrupt. */
export function hasUnfencedAgentchatServer(existing: string): boolean {
  const withoutOurs = stripTomlBlock(existing)
  return /^\s*\[mcp_servers\.agentchat\]/m.test(withoutOurs)
}

// ─── hooks.json merge/unmerge (identify our entries by bundle path) ─────────

interface HookLeaf {
  type: string
  command: string
  timeout?: number
}
interface HookGroup {
  matcher?: string
  hooks: HookLeaf[]
}
interface HooksDoc {
  hooks?: Record<string, HookGroup[]>
  [k: string]: unknown
}

function ourHookGroups(bundle: string): Record<string, HookGroup[]> {
  const cmd = (sub: string, timeout: number): HookGroup => ({
    hooks: [{ type: 'command', command: `node "${bundle}" hook ${sub} --platform codex`, timeout }],
  })
  return {
    SessionStart: [{ matcher: 'startup|resume', ...cmd('session-start', 15) }],
    UserPromptSubmit: [cmd('user-prompt', 10)],
    Stop: [cmd('stop', 15)],
  }
}

function groupIsOurs(g: unknown): boolean {
  const grp = g as HookGroup | undefined
  return (
    Array.isArray(grp?.hooks) &&
    grp!.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(BUNDLE_REL))
  )
}

export function mergeHooks(existing: HooksDoc | null, bundle: string): HooksDoc {
  const doc: HooksDoc = existing && typeof existing === 'object' ? existing : {}
  const hooks: Record<string, HookGroup[]> =
    doc.hooks && typeof doc.hooks === 'object' ? (doc.hooks as Record<string, HookGroup[]>) : {}
  for (const [event, groups] of Object.entries(ourHookGroups(bundle))) {
    const prior = Array.isArray(hooks[event]) ? hooks[event]! : []
    hooks[event] = [...prior.filter((g) => !groupIsOurs(g)), ...groups]
  }
  doc.hooks = hooks
  return doc
}

/** Remove exactly our entries; returns null when nothing of ours or the
 *  user's remains (so the caller can delete the file). */
export function unmergeHooks(existing: HooksDoc | null): HooksDoc | null {
  if (!existing || typeof existing !== 'object' || !existing.hooks) return existing
  const hooks = existing.hooks as Record<string, HookGroup[]>
  let anyLeft = false
  for (const event of Object.keys(hooks)) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event]! : []).filter((g) => !groupIsOurs(g))
    if (kept.length > 0) {
      hooks[event] = kept
      anyLeft = true
    } else {
      delete hooks[event]
    }
  }
  if (!anyLeft) {
    // Preserve any non-hooks keys the user may have; only drop an empty hooks.
    const rest = { ...existing }
    delete rest.hooks
    return Object.keys(rest).length > 0 ? rest : null
  }
  return existing
}

// ─── Public install/remove ──────────────────────────────────────────────────

export interface CodexInstallResult {
  actions: string[]
  warnings: string[]
}

function copyBundle(bundleSrc: string): string {
  const dest = stableBundlePath()
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const srcResolved = path.resolve(bundleSrc)
  if (srcResolved !== path.resolve(dest)) {
    fs.copyFileSync(srcResolved, dest)
  }
  return dest
}

/**
 * Wire Codex end to end. `bundleSrc` is the path to this running CLI bundle
 * (process.argv[1]); we copy it to a stable home so the hooks don't depend
 * on npx cache or a global install. `handle` (when known) writes the AGENTS.md
 * identity anchor.
 */
export function installCodex(bundleSrc: string, handle: string | null): CodexInstallResult {
  const actions: string[] = []
  const warnings: string[] = []
  fs.mkdirSync(codexHome(), { recursive: true })

  // 1. stable bundle copy (unless we ARE the stable bundle already)
  let bundle: string
  try {
    bundle = copyBundle(bundleSrc)
    actions.push(`bundle → ${bundle}`)
  } catch (err) {
    // Fall back to a bare `agentchat` on PATH if we can't copy ourselves.
    bundle = stableBundlePath()
    warnings.push(
      `could not copy the CLI bundle (${String(err)}); hooks will use ${bundle} — ensure it exists`,
    )
  }

  // 2. config.toml MCP block (fenced, byte-preserving)
  const cfgPath = codexConfigPath()
  const existingCfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf-8') : ''
  if (hasUnfencedAgentchatServer(existingCfg)) {
    warnings.push(
      `${cfgPath} already defines [mcp_servers.agentchat] outside our block — left it untouched; remove it and re-run if it isn't ours`,
    )
  } else {
    fs.writeFileSync(cfgPath, upsertTomlBlock(existingCfg, mcpBlock()), 'utf-8')
    actions.push(`config.toml ← [mcp_servers.agentchat]`)
  }

  // 3. hooks.json merge
  const hooksPath = codexHooksPath()
  let existingHooks: HooksDoc | null = null
  if (fs.existsSync(hooksPath)) {
    try {
      existingHooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as HooksDoc
    } catch {
      warnings.push(`${hooksPath} was not valid JSON — leaving it; wire hooks manually if needed`)
    }
  }
  if (existingHooks !== null || !fs.existsSync(hooksPath)) {
    const merged = mergeHooks(existingHooks, bundle)
    fs.writeFileSync(hooksPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
    actions.push('hooks.json ← SessionStart + Stop + UserPromptSubmit')
  }

  // 4. AGENTS.md — identity + condensed loop-safety etiquette (always-loaded)
  if (handle) {
    try {
      writeAnchor(anchorFile(), renderCodexAgents(handle), handle)
      actions.push(`AGENTS.md ← identity + etiquette (@${handle})`)
    } catch (err) {
      warnings.push(`AGENTS.md write failed: ${String(err)}`)
    }
  } else {
    // Codex is wired now, so registering writes AGENTS.md by itself — no
    // second `install` pass (see isCodexWired / anchorFor).
    warnings.push(`no identity yet — \`${invocation() + ' register'}\` writes AGENTS.md once you have a handle`)
  }

  log.debug(`codex install: ${actions.join('; ')}`)
  return { actions, warnings }
}

export function removeCodexWiring(): string[] {
  const removed: string[] = []
  const cfgPath = codexConfigPath()
  if (fs.existsSync(cfgPath)) {
    const stripped = stripTomlBlock(fs.readFileSync(cfgPath, 'utf-8'))
    fs.writeFileSync(cfgPath, stripped, 'utf-8')
    removed.push('config.toml [mcp_servers.agentchat]')
  }
  const hooksPath = codexHooksPath()
  if (fs.existsSync(hooksPath)) {
    try {
      const next = unmergeHooks(JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as HooksDoc)
      if (next === null) fs.unlinkSync(hooksPath)
      else fs.writeFileSync(hooksPath, JSON.stringify(next, null, 2) + '\n', 'utf-8')
      removed.push('hooks.json entries')
    } catch {
      // leave a malformed file alone
    }
  }
  if (removeAnchorAt(anchorFile()) === 'removed') removed.push('AGENTS.md anchor')
  return removed
}
