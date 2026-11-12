import * as fs from 'node:fs'
import * as path from 'node:path'

export interface FakeCodex {
  binDir: string
  /** JSON lines, one per `codex exec` run: argv, cwd, selected env, whether stdin is a TTY, and stdin's text when the prompt is `-`. */
  recordPath: string
  /** JSON lines, one per `codex mcp list` call: argv, cwd, and whether the key was in its environment. */
  listRecordPath: string
}

/**
 * A deterministic `codex` for tests. Models exactly the surfaces the
 * integration's listener uses — `--version`, `login status`, and `exec`
 * headless runs — so nothing here reaches a developer's real Codex
 * installation or sign-in.
 *
 * Env knobs read by the fake at run time:
 *   FAKE_CODEX_LOGGED_OUT=1          `login status` exits 1
 *   FAKE_CODEX_RUN=ok|fail|nostart|signedout|hang   how an `exec` run ends (default ok)
 *   FAKE_CODEX_RECORD=<file>         where `exec` runs append their record
 *   FAKE_CODEX_MCP_LIST=<json>       what `mcp list --json` prints (default: the agentchat server only).
 *                                    The answer profile lists the servers before every run it has no
 *                                    cached listing for, and switches off each one but agentchat.
 *   FAKE_CODEX_MCP_LIST_MODE=fail|garbage   `mcp list` exits 1 with a complaint / prints something not JSON
 *   FAKE_CODEX_MCP_LIST_RECORD=<file>        where `mcp list` appends its argv and cwd
 */
export function installFakeCodex(root: string, version = '0.154.0'): FakeCodex {
  const binDir = path.join(root, 'fake-bin')
  const recordPath = path.join(root, 'fake-codex-runs.jsonl')
  fs.mkdirSync(binDir, { recursive: true })
  const script = path.join(binDir, 'codex')
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      'const args = process.argv.slice(2)',
      `if (args[0] === '--version') { console.log(${JSON.stringify(`codex-cli ${version}`)}); process.exit(0) }`,
      "if (args[0] === 'login' && args[1] === 'status') { if (process.env.FAKE_CODEX_LOGGED_OUT === '1') { console.error('Not logged in'); process.exit(1) } console.log('Logged in using ChatGPT'); process.exit(0) }",
      "if (args[0] === 'mcp' && args[1] === 'list') {",
      "  if (process.env.FAKE_CODEX_MCP_LIST_RECORD) fs.appendFileSync(process.env.FAKE_CODEX_MCP_LIST_RECORD, JSON.stringify({ argv: args, cwd: process.cwd(), keyInEnv: process.env.AGENTCHAT_API_KEY !== undefined }) + '\\n')",
      "  if (process.env.FAKE_CODEX_MCP_LIST_MODE === 'fail') { console.error('Error: unknown feature flag in the fake'); process.exit(1) }",
      "  if (process.env.FAKE_CODEX_MCP_LIST_MODE === 'garbage') { console.log('not json'); process.exit(0) }",
      "  console.log(process.env.FAKE_CODEX_MCP_LIST || JSON.stringify([{ name: 'agentchat', enabled: true }]))",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'exec') {",
      "  const stdin = args[args.length - 1] === '-' ? fs.readFileSync(0, 'utf8') : null",
      "  const record = { argv: args, cwd: process.cwd(), env: { CODEX_HOME: process.env.CODEX_HOME, AGENTCHAT_API_KEY: process.env.AGENTCHAT_API_KEY }, stdinIsTTY: process.stdin.isTTY === true, stdin }",
      "  if (process.env.FAKE_CODEX_RECORD) fs.appendFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify(record) + '\\n')",
      "  const mode = process.env.FAKE_CODEX_RUN || 'ok'",
      "  if (mode === 'nostart') process.exit(2)",
      "  if (mode === 'signedout') { process.stderr.write('Not logged in. Run codex login.\\n'); process.exit(1) }",
      "  if (mode === 'fail') { process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\\n'); process.stderr.write('error: the fake runtime failed\\n'); process.exit(1) }",
      "  if (mode === 'hang') { process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\\n'); setInterval(() => {}, 1000); return }",
      "  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\\n')",
      "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Peer text echoed by the model — must be discarded' } }) + '\\n')",
      '  process.exit(0)',
      '}',
      "console.error('unsupported fake codex command: ' + args.join(' '))",
      'process.exit(2)',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  // Windows resolves bare commands through PATHEXT rather than shebangs.
  fs.writeFileSync(path.join(binDir, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex" %*\r\n')
  return { binDir, recordPath, listRecordPath: path.join(root, 'fake-codex-mcp-lists.jsonl') }
}

export function readListings(fake: FakeCodex): Array<{ argv: string[]; cwd: string; keyInEnv: boolean }> {
  if (!fs.existsSync(fake.listRecordPath)) return []
  return fs
    .readFileSync(fake.listRecordPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; keyInEnv: boolean })
}

export function readRuns(fake: FakeCodex): Array<{ argv: string[]; cwd: string; env: Record<string, string | undefined>; stdinIsTTY: boolean; stdin: string | null }> {
  if (!fs.existsSync(fake.recordPath)) return []
  return fs
    .readFileSync(fake.recordPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; env: Record<string, string | undefined>; stdinIsTTY: boolean; stdin: string | null })
}
