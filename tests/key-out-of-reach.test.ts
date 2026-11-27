import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import * as core from '@agentchatme/agent-core'
import { MANUAL, manualVersion } from '@agentchatme/agent-core'
import { installFakeCodex, type FakeCodex } from './helpers/fake-codex.js'

// ─── The key is in no file but `credentials`, and no exported key replaces it ─
//
// Found in testing: the key sat in `$CODEX_HOME/.env`, which Codex loads into its
// own environment, so every command a Codex session ran inherited it; and with
// another agent's key exported, `doctor --fix` wrote THAT key into `.env`, after
// which Codex's answer runs authenticated as the other agent. The
// block in config.toml now names a headers helper that reads `credentials`.

const exec = promisify(execFile)
const BIN = path.join(__dirname, '..', 'dist', 'index.js')
const KEY = 'ac_live_' + 'c'.repeat(40)
const OTHER = 'ac_live_' + 'o'.repeat(40)
const BUNDLED = manualVersion(MANUAL)!

let sandbox: string
let fake: FakeCodex

const codexDir = (): string => path.join(sandbox, '.codex')
const home = (): string => path.join(codexDir(), 'agentchat')
const creds = (): string => path.join(home(), 'credentials')
const dotEnv = (): string => path.join(codexDir(), '.env')
const configToml = (): string => path.join(codexDir(), 'config.toml')

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-key-'))
  fake = installFakeCodex(sandbox)
  fs.mkdirSync(home(), { recursive: true })
  fs.writeFileSync(creds(), JSON.stringify({ api_key: KEY, handle: 'codex-agent', api_base: 'http://127.0.0.1:9' }), { mode: 0o600 })
  fs.writeFileSync(
    path.join(home(), 'texts.json'),
    JSON.stringify({
      version: 1,
      fetched_at: new Date().toISOString(),
      runtime: 'codex',
      texts: {
        version: '1',
        manual: { url: 'https://agentchat.me/skill.md', version: BUNDLED },
        wake_instruction: 'SERVED WAKE INSTRUCTION',
        invite_prompt: 'SERVED INVITE PROMPT',
        identity_line: 'I am @codex-agent on AgentChat (api.agentchat.me). Served for the test.',
        identity_line_template: 'I am @<handle> on AgentChat (api.agentchat.me). Served for the test.',
      },
    }),
  )
})
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

async function run(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        PATH: `${fake.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        HOME: sandbox,
        USERPROFILE: sandbox,
        CODEX_HOME: codexDir(),
        AGENTCHAT_API_KEY: '',
        AGENTCHAT_API_BASE: 'http://127.0.0.1:9',
        AGENTCHAT_LOG_LEVEL: 'silent',
        AGENTCHAT_SERVICE_DRY_RUN: '1',
        ...extraEnv,
      },
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** The block's `http_headers_helper`, run the way Codex runs it: through a shell, with an environment of its own. */
function runHelper(env: NodeJS.ProcessEnv = {}): Record<string, unknown> {
  const line = /^http_headers_helper = (".*")$/m.exec(fs.readFileSync(configToml(), 'utf-8'))
  expect(line).not.toBeNull()
  const command = JSON.parse(line![1]!) as string
  const result = spawnSync(command, { shell: true, encoding: 'utf-8', env: { PATH: process.env['PATH'], ...env } })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as Record<string, unknown>
}

describe('the key stays in credentials', () => {
  it('install: config.toml names the helper and holds no key; .env holds none; the helper yields the key and reads no environment', { timeout: 30_000 }, async () => {
    const out = await run([])
    expect(out.code, out.stdout + out.stderr).toBe(0)
    const config = fs.readFileSync(configToml(), 'utf-8')
    expect(config).toContain('http_headers_helper = ')
    expect(config).not.toContain('bearer_token_env_var')
    expect(config).not.toContain(KEY)
    expect(fs.existsSync(dotEnv())).toBe(false)
    expect(runHelper()).toEqual({ Authorization: `Bearer ${KEY}` })
    expect(runHelper({ AGENTCHAT_API_KEY: OTHER })).toEqual({ Authorization: `Bearer ${KEY}` })
    if (process.platform !== 'win32') expect(fs.statSync(path.join(home(), 'bin', 'mcp-headers.mjs')).mode & 0o777).toBe(0o600)
    expect(out.stdout + out.stderr).not.toContain(KEY)
  })

  it('signed out, the helper yields no header (the hosted tools show the sign-up tools)', { timeout: 30_000 }, async () => {
    expect((await run([])).code).toBe(0)
    expect((await run(['logout'])).code).toBe(0)
    expect(runHelper()).toEqual({})
  })
})

describe('an install from 0.5.2 or earlier (the key in .env)', () => {
  const OLD_BLOCK = [
    '# agentchat:start',
    '[mcp_servers.agentchat]',
    'url = "http://127.0.0.1:9/mcp"',
    'bearer_token_env_var = "AGENTCHAT_API_KEY"',
    'startup_timeout_sec = 30',
    'default_tools_approval_mode = "approve"',
    '# agentchat:end',
  ].join('\n')

  it('status says the key is in .env; install takes this agent’s line out, keeps every other line, and moves the block to the helper', { timeout: 30_000 }, async () => {
    fs.writeFileSync(configToml(), `model = "o4"\n\n${OLD_BLOCK}\n`)
    fs.writeFileSync(dotEnv(), `OPENAI_API_KEY=user-secret\nAGENTCHAT_API_KEY=${KEY}\nOTHER=1\n`, { mode: 0o600 })

    expect((await run(['status'])).stdout).toContain(`${dotEnv()} still holds this agent's key`)
    const out = await run([])
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toContain(`AGENTCHAT_API_KEY taken out of ${dotEnv()}`)
    expect(fs.readFileSync(dotEnv(), 'utf-8')).toBe('OPENAI_API_KEY=user-secret\nOTHER=1\n')
    const config = fs.readFileSync(configToml(), 'utf-8')
    expect(config.startsWith('model = "o4"\n')).toBe(true)
    expect(config).not.toContain('bearer_token_env_var')
    expect(runHelper()).toEqual({ Authorization: `Bearer ${KEY}` })
    expect((await run(['status'])).stdout).toContain(`✓ key: in ${creds()} only`)
  })

  it('a .env with CRLF line endings keeps them, and an `export` line is recognised', { timeout: 30_000 }, async () => {
    fs.writeFileSync(configToml(), `${OLD_BLOCK}\n`)
    fs.writeFileSync(dotEnv(), `OPENAI_API_KEY=user-secret\r\nexport AGENTCHAT_API_KEY="${KEY}"\r\nOTHER=1\r\n`, { mode: 0o600 })
    expect((await run([])).code).toBe(0)
    expect(fs.readFileSync(dotEnv(), 'utf-8')).toBe('OPENAI_API_KEY=user-secret\r\nOTHER=1\r\n')
  })

  it('a .env key that is not this agent’s is never deleted: said, and left', { timeout: 30_000 }, async () => {
    fs.writeFileSync(configToml(), `${OLD_BLOCK}\n`)
    fs.writeFileSync(dotEnv(), `AGENTCHAT_API_KEY=${OTHER}\n`, { mode: 0o600 })
    const out = await run(['doctor', '--fix'])
    expect(out.stdout).toMatch(/WARN key: .* sets AGENTCHAT_API_KEY to a key that is not this agent's/)
    expect(fs.readFileSync(dotEnv(), 'utf-8')).toBe(`AGENTCHAT_API_KEY=${OTHER}\n`)
    // It no longer reaches the tools: the block names the helper, not the variable.
    expect(fs.readFileSync(configToml(), 'utf-8')).not.toContain('bearer_token_env_var')
    expect(runHelper()).toEqual({ Authorization: `Bearer ${KEY}` })
    expect(out.stdout + out.stderr).not.toContain(OTHER)
  })
})

describe('what is not this integration’s to delete', () => {
  it('a hand-written [mcp_servers.agentchat] that reads AGENTCHAT_API_KEY keeps it in .env, at this agent’s key, said as a warning', { timeout: 30_000 }, async () => {
    const hand = '[mcp_servers.agentchat]\nurl = "http://127.0.0.1:9/mcp"\nbearer_token_env_var = "AGENTCHAT_API_KEY"\n'
    fs.writeFileSync(configToml(), hand)
    fs.writeFileSync(dotEnv(), `AGENTCHAT_API_KEY=${KEY}\nOTHER=1\n`, { mode: 0o600 })
    const out = await run([])
    expect(out.stdout).toContain('left untouched')
    expect(out.stdout).toMatch(/– key: your own \[mcp_servers\.agentchat\] reads AGENTCHAT_API_KEY/)
    expect(fs.readFileSync(dotEnv(), 'utf-8')).toBe(`AGENTCHAT_API_KEY=${KEY}\nOTHER=1\n`)
    expect(fs.readFileSync(configToml(), 'utf-8')).toBe(hand)
    // A new key reaches that entry, as before.
    const rotated = 'ac_live_' + 'r'.repeat(40)
    fs.writeFileSync(creds(), JSON.stringify({ api_key: rotated, handle: 'codex-agent', api_base: 'http://127.0.0.1:9' }), { mode: 0o600 })
    await run(['doctor', '--fix'])
    expect(fs.readFileSync(dotEnv(), 'utf-8')).toBe(`AGENTCHAT_API_KEY=${rotated}\nOTHER=1\n`)
  })

  it('logout and uninstall take out this agent’s key only; another value in .env stays, said', { timeout: 30_000 }, async () => {
    expect((await run([])).code).toBe(0)
    fs.writeFileSync(dotEnv(), `AGENTCHAT_API_KEY=${OTHER}\nOTHER=1\n`, { mode: 0o600 })
    const logout = await run(['logout'])
    expect(logout.stdout).toContain('not this agent\'s; left as it is')
    expect(fs.readFileSync(dotEnv(), 'utf-8')).toBe(`AGENTCHAT_API_KEY=${OTHER}\nOTHER=1\n`)
    fs.writeFileSync(creds(), JSON.stringify({ api_key: KEY, handle: 'codex-agent', api_base: 'http://127.0.0.1:9' }), { mode: 0o600 })
    fs.writeFileSync(dotEnv(), `AGENTCHAT_API_KEY=${KEY}\nAGENTCHAT_API_KEY=${OTHER}\n`, { mode: 0o600 })
    expect((await run(['uninstall'])).code).toBe(0)
    expect(fs.readFileSync(dotEnv(), 'utf-8')).toBe(`AGENTCHAT_API_KEY=${OTHER}\n`)
  })
})

describe('another agent’s key exported in the shell', () => {
  it('doctor --fix writes nothing of it: not into .env, not into config.toml; the helper still yields this home’s key', { timeout: 30_000 }, async () => {
    const out = await run(['doctor', '--fix'], { AGENTCHAT_API_KEY: OTHER })
    expect(fs.existsSync(dotEnv()) ? fs.readFileSync(dotEnv(), 'utf-8') : '').not.toContain(OTHER)
    expect(fs.readFileSync(configToml(), 'utf-8')).not.toContain(OTHER)
    expect(runHelper()).toEqual({ Authorization: `Bearer ${KEY}` })
    expect(out.stdout + out.stderr).not.toContain(OTHER)
  })

  it('install with it exported places this home’s agent', { timeout: 30_000 }, async () => {
    const out = await run([], { AGENTCHAT_API_KEY: OTHER })
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toMatch(/^Setup: /m)
    expect(fs.existsSync(dotEnv())).toBe(false)
    expect(runHelper()).toEqual({ Authorization: `Bearer ${KEY}` })
  })
})

// The engine's refusals in words come with the agent-core release after 0.5.2.
// These run once the pin moves there, and stop a release on an engine that
// lacks them.
const ENGINE_REFUSES = 'envKeyConflict' in core

describe.skipIf(!ENGINE_REFUSES)('the engine refuses another agent’s exported key in words', () => {
  it('login without --api-key does not adopt it; status refuses; doctor fails env-key; nothing of it is written', { timeout: 30_000 }, async () => {
    expect((await run([])).code).toBe(0)
    const login = await run(['login'], { AGENTCHAT_API_KEY: OTHER })
    expect(login.code).toBe(1)
    expect(login.stderr).toContain('AGENTCHAT_API_KEY is exported')
    const status = await run(['status'], { AGENTCHAT_API_KEY: OTHER })
    expect(status.code).toBe(1)
    expect((await run(['doctor', '--fix'], { AGENTCHAT_API_KEY: OTHER })).stdout).toMatch(/FAIL env-key:/)
    expect(JSON.parse(fs.readFileSync(creds(), 'utf-8'))).toMatchObject({ api_key: KEY })
    expect(fs.existsSync(dotEnv()) ? fs.readFileSync(dotEnv(), 'utf-8') : '').not.toContain(OTHER)
  })
})

describe('no printed step puts a key on a command line', () => {
  it('--help names login with a prompt or stdin, never a key argument or AGENTCHAT_API_KEY=…', async () => {
    const out = (await run(['--help'])).stdout
    expect(out).toContain('login --api-key - < <file>')
    expect(out).not.toMatch(/--api-key <ac_|AGENTCHAT_API_KEY=/)
  })
})
