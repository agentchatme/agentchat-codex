import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { installFakeCodex, type FakeCodex } from './helpers/fake-codex.js'

// ─── The service runs something that can actually serve ─────────────────────
//
// A shipped defect once wired the unit to a command that did not exist; it
// restart-looped forever behind a green pipeline because the only check on the
// daemon was that a FILE EXISTED. So: never assert a path exists — RUN it.

const DIST = path.join(__dirname, '..', 'dist')
const DAEMON = path.join(DIST, 'daemon-main.js')
const CLI = path.join(DIST, 'index.js')

let sandbox: string
let fake: FakeCodex

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-daemon-'))
  fake = installFakeCodex(sandbox)
})
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

const baseEnv = (): Record<string, string> => ({
  PATH: `${fake.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
  HOME: sandbox,
  USERPROFILE: sandbox,
  CODEX_HOME: path.join(sandbox, '.codex'),
  AGENTCHAT_SERVICE_DRY_RUN: '1',
})

function run(script: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { env: { ...baseEnv(), ...env }, timeout: 20_000 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
      resolve({ code: typeof e?.code === 'number' ? e.code : e ? 1 : 0, out: `${stdout}${stderr}` })
    })
    child.stdin?.end()
  })
}

function runFor(script: string, args: string[], ms: number, env: Record<string, string> = {}): Promise<{ out: string; alive: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...baseEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let exited = false
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', () => (exited = true))
    setTimeout(() => {
      const alive = !exited
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      setTimeout(() => resolve({ out, alive }), 150)
    }, ms)
  })
}

describe('the daemon bundle ships in the tarball', () => {
  it('is built beside the CLI', () => {
    expect(fs.existsSync(DAEMON)).toBe(true)
  })

  it('is a different artifact from the CLI — the CLI must never carry the socket layer', () => {
    expect(fs.readFileSync(DAEMON, 'utf-8')).toContain('doorbell socket hello.ok')
    expect(fs.readFileSync(CLI, 'utf-8')).not.toContain('doorbell socket hello.ok')
  })
})

describe('the daemon is RESIDENT — it idles rather than exiting', () => {
  it('stays alive with no identity instead of exiting and being restarted forever', async () => {
    const home = path.join(sandbox, 'empty-home')
    fs.mkdirSync(home, { recursive: true })
    const { out, alive } = await runFor(DAEMON, ['--home', home], 1500)
    expect(alive, `the daemon exited instead of idling:\n${out}`).toBe(true)
    expect(out).toMatch(/doorbell resident/i)
    expect(out).not.toMatch(/Unknown option|Usage:|Dynamic require|Cannot find (module|package)/i)
    expect(fs.existsSync(path.join(home, 'doorbell.status.json'))).toBe(true)
  }, 20_000)

  it('acts on the home it is GIVEN, not one it picks', async () => {
    const a = path.join(sandbox, 'home-a')
    const b = path.join(sandbox, 'home-b')
    fs.mkdirSync(a, { recursive: true })
    fs.mkdirSync(b, { recursive: true })
    const { out } = await runFor(DAEMON, ['--home', a], 1200)
    expect(out).toContain(a)
    expect(out).not.toContain(b)
  }, 20_000)

  it('AGENTCHAT_DOORBELL=off holds no socket and says so', async () => {
    const home = path.join(sandbox, 'off-home')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'codex-agent', api_base: 'http://127.0.0.1:9' }))
    const { out, alive } = await runFor(DAEMON, ['--home', home], 1500, { AGENTCHAT_DOORBELL: 'off' })
    expect(alive).toBe(true)
    expect(out).toContain('AGENTCHAT_DOORBELL=off')
    expect((JSON.parse(fs.readFileSync(path.join(home, 'doorbell.status.json'), 'utf-8')) as { socket: string }).socket).toBe('off')
  }, 20_000)
})

describe('daemon install points the service at the daemon, not the CLI', () => {
  it('registers the service with NO identity — install and sign-in are separate', async () => {
    const { out } = await run(CLI, ['daemon', 'install'])
    expect(out).not.toMatch(/register first/i)
    expect(out).toMatch(/Doorbell daemon is ON/i)
  })

  it('finds the daemon when invoked through a bin shim, as npx does', async () => {
    const home = path.join(sandbox, '.codex', 'agentchat')
    const binDir = path.join(sandbox, 'elsewhere', 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    const shim = path.join(binDir, 'agentchat')
    fs.symlinkSync(CLI, shim)
    const { out } = await run(shim, ['daemon', 'install'])
    expect(out).not.toMatch(/daemon bundle is missing/i)
    expect(fs.existsSync(path.join(home, 'bin', 'agentchat-daemon.mjs'))).toBe(true)
  })

  it('copies the daemon to a durable path outside the npx cache', async () => {
    const home = path.join(sandbox, '.codex', 'agentchat')
    await run(CLI, ['daemon', 'install'])
    const stable = path.join(home, 'bin', 'agentchat-daemon.mjs')
    expect(fs.readFileSync(stable, 'utf-8')).toBe(fs.readFileSync(DAEMON, 'utf-8'))
  })

  it('daemon status reports the service and the doorbell status file', async () => {
    await run(CLI, ['daemon', 'install'])
    const { out } = await run(CLI, ['daemon', 'status'])
    expect(out).toMatch(/daemon: (idle|starting|off|connected|NOT running)/)
    expect(out).toContain('Doorbell:')
  })

  it('the retired hook subcommands are gone — receiving needs no hooks', async () => {
    const { code, out } = await run(CLI, ['hook', 'session-start'])
    expect(code).toBe(1)
    expect(out).toContain('Unknown command: hook')
  })
})
