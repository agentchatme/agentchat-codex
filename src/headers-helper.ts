import * as fs from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile, spawnCommandSync } from '@agentchatme/agent-core'

// ─── The headers helper: the key, read from `credentials` on each connection ─
//
// Codex 0.154.0 (the oldest this integration accepts) takes, for a
// streamable-HTTP MCP server, `http_headers_helper`: "Local-only shell command
// that prints a JSON object of dynamic HTTP headers. The command may be
// visible to local process inspection; do not embed credentials."
// (codex-rs/config/src/mcp_types.rs). Codex runs it with `sh -c` (`cmd /Q /D
// /C` on Windows), stdin closed, the environment cleared to the MCP subprocess
// defaults, a 10 s budget; it uses the headers for every request to that
// server and runs the helper again after a 401/403. An `Authorization` header
// from it is used when the server has no explicit bearer token
// (codex-rs/rmcp-client/src/http_headers.rs, `run_helper`,
// `with_http_headers_helper`).
//
// Ours is a fixed script in the identity home that prints the Authorization
// header from the `credentials` file beside it. So the key is in no file but
// `credentials` — not in `$CODEX_HOME/.env`, which Codex loads into its own
// environment and so hands to every command a session runs — and on no command
// line: the helper command is two quoted paths. Claude Code's integration
// writes the same script for its `headersHelper`.

/** Where the helper lives for an identity home: its `bin/`, beside the durable daemon bundle. */
export function headersHelperPathFor(identityHome: string): string {
  return path.join(identityHome, 'bin', 'mcp-headers.mjs')
}

/**
 * The helper, byte for byte. It reads the `credentials` file of the home it
 * sits in and nothing else (no environment variable: the identity is the
 * home's), prints `{"Authorization":"Bearer <key>"}`, or `{}` when there is no
 * key (the hosted tools then show the sign-up tools), and never fails.
 */
export const HEADERS_HELPER_SOURCE = [
  '// Written by @agentchatme/codex. Codex runs this on each connection to the MCP server',
  '// "agentchat" (its http_headers_helper) and sends what it prints as headers: the',
  '// Authorization header for the key in the credentials file of this identity home, or',
  '// nothing when there is none. It reads no environment variable. Do not edit: install',
  '// and doctor --fix rewrite it.',
  "import { readFileSync } from 'node:fs'",
  'let headers = {}',
  'try {',
  "  const creds = JSON.parse(readFileSync(new URL('../credentials', import.meta.url), 'utf8'))",
  "  const key = creds !== null && typeof creds.api_key === 'string' ? creds.api_key.trim() : ''",
  '  if (key.length >= 20 && !/\\s/.test(key)) headers = { Authorization: `Bearer ${key}` }',
  '} catch {}',
  'process.stdout.write(JSON.stringify(headers))',
  '',
].join('\n')

/**
 * The helper command: this Node and the helper, each quoted for the shell
 * Codex runs it in — single quotes on POSIX (`sh -c`; a `'` inside written as
 * `'\\''`), double quotes on Windows (`cmd /C`). Null when a path holds
 * what that quoting cannot carry (`"`, `%`, `$` or a backtick on Windows) or
 * a line break anywhere.
 */
export function headersHelperCommand(script: string, node: string = process.execPath, platform: NodeJS.Platform = process.platform): string | null {
  const paths = [node, script]
  if (paths.some((p) => /[\r\n]/.test(p))) return null
  if (platform === 'win32') return paths.some((p) => /["%$`]/.test(p)) ? null : paths.map((p) => `"${p}"`).join(' ')
  return paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ')
}

const POSIX_TOKEN = "'((?:[^'\\r\\n]|'\\\\'')*)'"

/** The Node and the script a helper command of ours names; null for any other command. */
export function parseHeadersHelper(command: unknown): { node: string; script: string } | null {
  if (typeof command !== 'string') return null
  const posix = new RegExp(`^${POSIX_TOKEN} ${POSIX_TOKEN}$`).exec(command)
  if (posix !== null) return { node: posix[1]!.replace(/'\\''/g, "'"), script: posix[2]!.replace(/'\\''/g, "'") }
  const win = /^"([^"\r\n]+)" "([^"\r\n]+)"$/.exec(command)
  return win === null ? null : { node: win[1]!, script: win[2]! }
}

function sourceCurrent(script: string): boolean {
  try {
    return fs.readFileSync(script, 'utf-8') === HEADERS_HELPER_SOURCE
  } catch {
    return false
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Write the helper for an identity home when it is missing or not this release's. Owner-only. */
export function writeHeadersHelper(identityHome: string): void {
  const script = headersHelperPathFor(identityHome)
  if (sourceCurrent(script)) return
  atomicWriteFile(script, HEADERS_HELPER_SOURCE, 0o600)
}

/**
 * Whether `command` is our helper for `identityHome` and works as written:
 * `current` (our script, this release's text, a Node that is there), `stale`
 * (ours, but the script or the Node is not), `missing` (no command, or
 * someone else's).
 */
export function headersHelperState(command: unknown, identityHome: string): 'current' | 'stale' | 'missing' {
  const parsed = parseHeadersHelper(command)
  if (parsed === null || path.resolve(parsed.script) !== path.resolve(headersHelperPathFor(identityHome))) return 'missing'
  return sourceCurrent(parsed.script) && isExecutable(parsed.node) ? 'current' : 'stale'
}

/**
 * Run the helper the way Codex does (its Node, its script) and say whether it
 * yields `apiKey`. Null when it does; else why not, in words that never
 * contain a key.
 */
export function headersHelperProblem(command: unknown, apiKey: string, identityHome: string): string | null {
  const parsed = parseHeadersHelper(command)
  if (parsed === null) return 'there is no headers helper of this integration'
  const result = spawnCommandSync(parsed.node, [parsed.script], { encoding: 'utf-8', timeout: 10_000, windowsHide: true, cwd: identityHome })
  if (result.error) return `its headers helper could not run (${result.error.message})`
  if (result.status !== 0) return `its headers helper exited ${result.status}`
  let headers: unknown
  try {
    headers = JSON.parse(String(result.stdout ?? ''))
  } catch {
    return 'its headers helper printed something other than a JSON object'
  }
  const auth = headers !== null && typeof headers === 'object' ? (headers as Record<string, unknown>)['Authorization'] : undefined
  if (auth === undefined) return `its headers helper finds no key in ${path.join(identityHome, 'credentials')}`
  return auth === `Bearer ${apiKey}` ? null : "its headers helper yields a key other than this agent's credentials"
}
