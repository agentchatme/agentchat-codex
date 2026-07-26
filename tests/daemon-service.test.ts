import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ─── The always-on service runs something that can actually serve ───────────
//
// This file exists because of a shipped defect that every green check missed.
//
// `daemon install` wrote a launchd/systemd unit whose command was
// `<cli> start --home <home>`, but no `start` command existed — the CLI printed
// usage and exited 1. Under `KeepAlive` / `Restart=on-failure` that unit
// restart-looped forever while `daemon status` reported "always-on is ON".
// The daemon runtime was not even in the CLI bundle: the adapter was
// unreferenced and tree-shaken away.
//
// CI was green throughout, because the only check on the daemon was that a
// FILE EXISTED. So the rule here is: never assert a path exists — RUN it, and
// assert it got far enough to prove it is the daemon.

const DIST = path.join(__dirname, '..', 'dist')
const DAEMON = path.join(DIST, 'daemon-main.js')
const CLI = path.join(DIST, 'index.js')

let sandbox: string

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-daemon-'))
})
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

/** Run a script to completion, capturing everything. Never throws. */
function run(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // Close stdin. The hook subcommands read a JSON payload from it, so a child
    // left with an open pipe waits forever — which is also exactly what a host
    // does NOT do: it writes the payload and closes.
    const child = execFile(
      process.execPath,
      [script, ...args],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: sandbox,
          CODEX_HOME: path.join(sandbox, '.codex'),
          // HOME sandboxes where a unit FILE lands, but launchctl/systemctl
          // always address the REAL user's domain. Without this, running these
          // tests registers actual services on the developer's machine pointed
          // at a temp dir that is about to be deleted. It did exactly that.
          AGENTCHAT_SERVICE_DRY_RUN: '1',
          ...env,
        },
        timeout: 20_000,
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
        resolve({
          code: typeof e?.code === 'number' ? e.code : e ? 1 : 0,
          out: `${stdout}${stderr}`,
        })
      },
    )
    child.stdin?.end()
  })
}

describe('the daemon bundle ships in the tarball', () => {
  it('is built beside the CLI', () => {
    expect(fs.existsSync(DAEMON)).toBe(true)
  })

  it('is a different artifact from the CLI — the CLI must never carry the socket layer', () => {
    // `ws` is CommonJS and reaches for `require` at runtime; bundled into the
    // CLI it kills `install`, `register` and both hooks at startup.
    expect(fs.readFileSync(DAEMON, 'utf-8')).toContain('holding the wire')
    expect(fs.readFileSync(CLI, 'utf-8')).not.toContain('holding the wire')
  })
})

describe('the daemon entry actually runs', () => {
  it('starts, parses --home, and reaches identity resolution', async () => {
    const home = path.join(sandbox, 'empty-home')
    fs.mkdirSync(home, { recursive: true })

    const { code, out } = await run(DAEMON, ['--home', home])

    // Reaching "no identity" proves it got through module load, argument
    // parsing and into runDaemon. The regression printed usage instead.
    expect(out).toMatch(/no AgentChat identity/i)
    expect(out).not.toMatch(/Unknown option|Usage:/i)
    // And specifically NOT the failure mode of bundling `ws` into ESM.
    expect(out).not.toMatch(/Dynamic require/i)
    expect(code).toBe(1)
  })

  it('carries its whole runtime — it runs straight out of an npx cache', async () => {
    const home = path.join(sandbox, 'empty-home-2')
    fs.mkdirSync(home, { recursive: true })
    const { out } = await run(DAEMON, ['--home', home])
    expect(out).not.toMatch(/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/i)
  })

  it('acts on the home it is GIVEN, not one it picks', async () => {
    const a = path.join(sandbox, 'home-a')
    const b = path.join(sandbox, 'home-b')
    fs.mkdirSync(a, { recursive: true })
    fs.mkdirSync(b, { recursive: true })

    const ra = await run(DAEMON, ['--home', a])
    expect(ra.out).toContain(a)
    expect(ra.out).not.toContain(b)
  })
})

describe('daemon install points the service at the daemon, not the CLI', () => {
  it('refuses to install without an identity rather than wiring a dead unit', async () => {
    const { code, out } = await run(CLI, ['daemon', 'install'])
    expect(out).toMatch(/register first/i)
    expect(code).toBe(1)
  })

  it('finds the daemon when invoked through a bin shim, as npx does', async () => {
    // npx does not run dist/index.js — it runs node_modules/.bin/agentchat-codex,
    // a symlink to it. That makes process.argv[1] point at .bin/, so resolving
    // the daemon relative to argv[1] looked for node_modules/.bin/daemon-main.js
    // and `daemon install` failed with "the daemon bundle is missing from this
    // install" for every user. It shipped in 0.0.12, because every test ran the
    // bundle by its real path — the one way nobody invokes it.
    const home = path.join(sandbox, '.codex', 'agentchat')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      path.join(home, 'credentials'),
      JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'codex-agent' }),
    )

    const binDir = path.join(sandbox, 'fake-node-modules', '.bin')
    fs.mkdirSync(binDir, { recursive: true })
    const shim = path.join(binDir, 'agentchat-codex')
    fs.symlinkSync(CLI, shim)

    const { out } = await run(shim, ['daemon', 'install'])
    expect(out).not.toMatch(/daemon bundle is missing/i)
    expect(fs.existsSync(path.join(home, 'bin', 'agentchat-daemon.mjs'))).toBe(true)
  })

  it('copies the daemon to a durable path outside the npx cache', async () => {
    // npx runs this package from a cache directory that is cleaned without
    // warning, so a unit naming that path silently stops serving.
    const home = path.join(sandbox, '.codex', 'agentchat')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      path.join(home, 'credentials'),
      JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'codex-agent' }),
    )

    // Not asserting on launchctl/systemctl succeeding — this box may have
    // neither. What matters is the durable copy the unit would name.
    await run(CLI, ['daemon', 'install'])

    const stable = path.join(home, 'bin', 'agentchat-daemon.mjs')
    expect(fs.existsSync(stable)).toBe(true)
    expect(fs.readFileSync(stable, 'utf-8')).toBe(fs.readFileSync(DAEMON, 'utf-8'))
  })
})

// ─── The hooks it wires must actually run ───────────────────────────────────
//
// 0.0.13 shipped with every session hook broken. The wiring wrote
// `hook <event> --platform codex`, a leftover from the shared CLI that served
// every coding agent; this binary removed that flag and rejects it. So each
// hook exited on "Unknown option '--platform'" and printed usage to stdout —
// no inbox digest, no mid-task pickup, no delivery acks.
//
// Nothing caught it because the hooks were only ever invoked BY HAND with
// arguments someone believed were right. These run the commands the installer
// actually writes into hooks.json.
describe('the hook commands it writes into hooks.json run', () => {
  it('every wired hook exits cleanly and prints no usage text', { timeout: 30_000 }, async () => {
    const codexHome = path.join(sandbox, '.codex')
    fs.mkdirSync(path.join(codexHome, 'agentchat'), { recursive: true })
    fs.writeFileSync(
      path.join(codexHome, 'agentchat', 'credentials'),
      JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'codex-agent' }),
    )

    // Wire Codex exactly as `npx @agentchatme/codex` does.
    await run(CLI, [])

    const hooksFile = path.join(codexHome, 'hooks.json')
    expect(fs.existsSync(hooksFile)).toBe(true)
    const wired = JSON.parse(fs.readFileSync(hooksFile, 'utf-8')) as Record<string, any>
    const events = (wired['hooks'] ?? wired) as Record<string, Array<Record<string, any>>>

    const commands: string[] = []
    for (const groups of Object.values(events)) {
      for (const group of groups) {
        for (const h of group['hooks'] ?? []) {
          if (typeof h?.command === 'string') commands.push(h.command)
        }
      }
    }
    // SessionStart + UserPromptSubmit + Stop
    expect(commands.length).toBe(3)

    for (const command of commands) {
      // Each is `node "<bundle>" hook <event>`; run it the way the host does.
      const m = command.match(/^node "([^"]+)" (.+)$/)
      expect(m, `unexpected hook command shape: ${command}`).not.toBeNull()
      const argv = (m![2] as string).split(/\s+/)
      const { out } = await run(m![1] as string, argv, { AGENTCHAT_HOOKS_ENABLED: '0' })
      expect(out, `hook rejected its own arguments: ${command}\n${out}`).not.toMatch(/Unknown option/i)
      expect(out, `hook printed usage instead of running: ${command}\n${out}`).not.toMatch(/^Usage:/im)
    }
  })
})
