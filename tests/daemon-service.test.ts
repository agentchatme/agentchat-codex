import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DEFAULT_RUN_PROFILE, INTEGRATION_ENV, INTEGRATION_ENV_LEGACY, INTEGRATION_ENV_LEGACY_REMOVAL, RUN_PROFILES } from '@agentchatme/agent-core'

/** Whether the engine this build runs on has the `own` profile (the pin moves to it at the release step). */
const ENGINE_HAS_OWN = (RUN_PROFILES as readonly string[]).includes('own')
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
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const baseEnv = (): Record<string, string> => ({
  PATH: `${fake.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
  HOME: sandbox,
  USERPROFILE: sandbox,
  CODEX_HOME: path.join(sandbox, '.codex'),
  AGENTCHAT_SERVICE_DRY_RUN: '1',
  // This test file's own agent-lock folder (tests/setup/isolated-locks.ts), never the user's.
  AGENTCHAT_LOCK_DIR: process.env['AGENTCHAT_LOCK_DIR'] ?? path.join(sandbox, 'locks'),
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
    const gone = new Promise<void>((done) => {
      child.on('exit', () => {
        exited = true
        done()
      })
    })
    setTimeout(() => {
      const alive = !exited
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      // Resolve once the daemon has really exited: it writes its status files
      // into the home on the way out, and the sandbox is removed right after.
      const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
      void gone.then(() => {
        clearTimeout(force)
        resolve({ out, alive })
      })
    }, ms)
  })
}

describe('the daemon bundle ships in the tarball', () => {
  it('is built beside the CLI', () => {
    expect(fs.existsSync(DAEMON)).toBe(true)
  })

  it('is a different artifact from the CLI — the CLI must never carry the socket layer', () => {
    expect(fs.readFileSync(DAEMON, 'utf-8')).toContain('integration resident')
    expect(fs.readFileSync(CLI, 'utf-8')).not.toContain('integration resident')
  })
})

describe('the daemon is RESIDENT — it idles rather than exiting', () => {
  it('stays alive with no identity instead of exiting and being restarted forever', async () => {
    const home = path.join(sandbox, 'empty-home')
    fs.mkdirSync(home, { recursive: true })
    const { out, alive } = await runFor(DAEMON, ['--home', home], 1500)
    expect(alive, `the daemon exited instead of idling:\n${out}`).toBe(true)
    expect(out).toMatch(/integration resident/i)
    expect(out).not.toMatch(/Unknown option|Usage:|Dynamic require|Cannot find (module|package)/i)
    expect(fs.existsSync(path.join(home, 'integration.status.json'))).toBe(true)
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

  it(`${INTEGRATION_ENV}=off holds no socket and says so`, async () => {
    const home = path.join(sandbox, 'off-home')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'codex-agent', api_base: 'http://127.0.0.1:9' }))
    const { out, alive } = await runFor(DAEMON, ['--home', home], 1500, { [INTEGRATION_ENV]: 'off' })
    expect(alive).toBe(true)
    expect(out).toContain(`${INTEGRATION_ENV}=off`)
    expect((JSON.parse(fs.readFileSync(path.join(home, 'integration.status.json'), 'utf-8')) as { socket: string }).socket).toBe('off')
  }, 20_000)

  // Compatibility check: the switch's previous name is still read until
  // INTEGRATION_ENV_LEGACY_REMOVAL (agent contract v1, section 7), so a
  // service unit captured with it keeps meaning what its operator set. Named
  // through agent-core's constant: the day agent-core drops the reader, this
  // test fails and is deleted with it (src/host.ts stops compiling).
  it(`the previous switch name (${INTEGRATION_ENV_LEGACY}=off) still holds no socket until ${INTEGRATION_ENV_LEGACY_REMOVAL}`, async () => {
    const home = path.join(sandbox, 'off-home')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'codex-agent', api_base: 'http://127.0.0.1:9' }))
    const { out, alive } = await runFor(DAEMON, ['--home', home], 1500, { [INTEGRATION_ENV_LEGACY]: 'off' })
    expect(alive).toBe(true)
    expect(out).toContain(`${INTEGRATION_ENV_LEGACY}=off`)
    expect((JSON.parse(fs.readFileSync(path.join(home, 'integration.status.json'), 'utf-8')) as { socket: string }).socket).toBe('off')
  }, 20_000)
})

describe('the shipped daemon’s answer runner', () => {
  const signIn = (home: string, handle: string): void => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle, api_base: 'http://127.0.0.1:9' }))
  }

  it('lists Codex’s MCP servers before it holds the socket, and comes up when it can switch every other one off', async () => {
    const home = path.join(sandbox, '.codex', 'agentchat')
    signIn(home, 'codex-answer-ok')
    const lists = path.join(sandbox, 'lists.jsonl')
    const { out, alive } = await runFor(DAEMON, ['--home', home], 6000, { FAKE_CODEX_MCP_LIST_RECORD: lists, AGENTCHAT_RUN_PROFILE: 'answer' })
    expect(alive, out).toBe(true)
    expect(out).toMatch(/integration up as @codex-answer-ok via codex \(codex [^)]+\), profile answer/)
    expect(fs.readFileSync(lists, 'utf-8')).toContain('"--disable","shell_tool"')
    // The hosted server's URL is pinned to the served identity's API base on every run (and its listing).
    expect(fs.readFileSync(lists, 'utf-8')).toContain(JSON.stringify(`mcp_servers.agentchat.url=${JSON.stringify('http://127.0.0.1:9/mcp')}`))
  }, 30_000)

  it('a server no -c key can switch off stops answer runs: the daemon holds no socket and says why', async () => {
    const home = path.join(sandbox, '.codex', 'agentchat')
    signIn(home, 'codex-answer-refused')
    const { out, alive } = await runFor(DAEMON, ['--home', home], 6000, { FAKE_CODEX_MCP_LIST: JSON.stringify([{ name: 'agentchat', enabled: true }, { name: 'my.notes', enabled: true }]), AGENTCHAT_RUN_PROFILE: 'answer' })
    expect(alive, out).toBe(true)
    expect(out).toContain('not connecting yet: runtime (codex) not ready: could not list Codex\'s MCP servers')
    expect(out).toContain('"my.notes" cannot be switched off')
    expect(out).not.toMatch(/integration up as/)
  }, 30_000)

  it.skipIf(!ENGINE_HAS_OWN)('with no profile set, the shipped daemon serves own: no MCP listing, and its status names the profile and the runtime', async () => {
    const home = path.join(sandbox, '.codex', 'agentchat')
    signIn(home, 'codex-own-ok')
    const lists = path.join(sandbox, 'own-lists.jsonl')
    // A server no -c key can address stops answer runs only: an own run keeps the user's servers.
    const { out, alive } = await runFor(DAEMON, ['--home', home], 6000, { FAKE_CODEX_MCP_LIST_RECORD: lists, FAKE_CODEX_MCP_LIST: JSON.stringify([{ name: 'agentchat', enabled: true }, { name: 'my.notes', enabled: true }]) })
    expect(alive, out).toBe(true)
    expect(out).toMatch(/integration up as @codex-own-ok via codex \(codex [^)]+\), profile own/)
    expect(fs.existsSync(lists)).toBe(false)
    const status = JSON.parse(fs.readFileSync(path.join(home, 'integration.status.json'), 'utf-8')) as { profile: string; runtime_label?: string }
    expect(status.profile).toBe('own')
    expect(status.runtime_label).toBe('Codex')
  }, 30_000)
})

// ─── The identity line in AGENTS.md follows the served texts ────────────────
//
// For Codex the block in `$CODEX_HOME/AGENTS.md` is the only way the identity
// line reaches a run (Codex loads the file into every run; the preset hands a
// run no identity line of its own), so the daemon keeps it at the served line.
// No server is reachable here (api_base 127.0.0.1:9): the copy kept in the
// identity home is the texts the daemon has, and it follows them at start.
describe('the identity line in AGENTS.md follows the served texts', () => {
  const signIn = (home: string, handle: string): void => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle, api_base: 'http://127.0.0.1:9' }))
  }
  const keepTexts = (home: string, line: string): void => {
    const texts = {
      version: '7',
      manual: { url: 'https://manual.example.test/skill.md', version: '9.9.9' },
      wake_instruction: 'SERVED WAKE INSTRUCTION: call mcp__agentchat__agentchat_inbox first.',
      invite_prompt: 'SERVED INVITE PROMPT.',
      identity_line: line,
      identity_line_template: line.replace('@codex-agent', '@<handle>'),
    }
    fs.writeFileSync(path.join(home, 'texts.json'), JSON.stringify({ version: 1, runtime: 'codex', fetched_at: new Date().toISOString(), texts }))
  }
  const block = (handle: string, line: string): string => ['<!-- agentchat:start -->', `<!-- agentchat:handle ${handle} -->`, line, '<!-- agentchat:end -->'].join('\n')
  const OLD_LINE = 'I am @codex-agent on AgentChat (api.agentchat.me). The line install placed.'
  const NEW_LINE = 'I am @codex-agent on AgentChat (api.agentchat.me). The line served now.'
  const USER = '# My Codex instructions\n\nRun the linter before every commit.'

  it('the shipped daemon brings this agent\'s AGENTS.md block to the served identity line, keeping the user\'s text, and says so', async () => {
    const codexHome = path.join(sandbox, '.codex')
    const home = path.join(codexHome, 'agentchat')
    signIn(home, 'codex-agent')
    keepTexts(home, NEW_LINE)
    const agentsMd = path.join(codexHome, 'AGENTS.md')
    fs.writeFileSync(agentsMd, `${USER}\n\n${block('codex-agent', OLD_LINE)}\n`)
    const { out, alive } = await runFor(DAEMON, ['--home', home], 6000)
    expect(alive, out).toBe(true)
    expect(fs.readFileSync(agentsMd, 'utf-8'), out).toBe(`${USER}\n\n${block('codex-agent', NEW_LINE)}\n`)
    expect(out).toMatch(/identity line: updated — the identity line for @codex-agent in .*AGENTS\.md now is the served one/)
    const status = JSON.parse(fs.readFileSync(path.join(home, 'integration.status.json'), 'utf-8')) as { identity_line?: { outcome: string; path: string; texts_version: string } }
    expect(status.identity_line).toMatchObject({ outcome: 'updated', path: agentsMd, texts_version: '7' })
  }, 30_000)

  it('it follows a relocated CODEX_HOME: that AGENTS.md is the one brought to the served line, the default one is not written', async () => {
    const relocated = path.join(sandbox, 'relocated-codex')
    const home = path.join(relocated, 'agentchat')
    signIn(home, 'codex-agent')
    keepTexts(home, NEW_LINE)
    const relocatedMd = path.join(relocated, 'AGENTS.md')
    fs.writeFileSync(relocatedMd, `${USER}\n\n${block('codex-agent', OLD_LINE)}\n`)
    const defaultMd = path.join(sandbox, '.codex', 'AGENTS.md')
    fs.mkdirSync(path.dirname(defaultMd), { recursive: true })
    fs.writeFileSync(defaultMd, `${USER}\n\n${block('codex-agent', OLD_LINE)}\n`)
    const { out, alive } = await runFor(DAEMON, ['--home', home], 6000, { CODEX_HOME: relocated })
    expect(alive, out).toBe(true)
    expect(fs.readFileSync(relocatedMd, 'utf-8'), out).toBe(`${USER}\n\n${block('codex-agent', NEW_LINE)}\n`)
    expect(fs.readFileSync(defaultMd, 'utf-8')).toBe(`${USER}\n\n${block('codex-agent', OLD_LINE)}\n`)
  }, 30_000)

  it('with a non-empty AGENTS.override.md, which Codex reads instead, every follow says so (log and status file) and the override is never written', async () => {
    const codexHome = path.join(sandbox, '.codex')
    const home = path.join(codexHome, 'agentchat')
    signIn(home, 'codex-agent')
    keepTexts(home, NEW_LINE)
    const agentsMd = path.join(codexHome, 'AGENTS.md')
    fs.writeFileSync(agentsMd, `${USER}\n\n${block('codex-agent', OLD_LINE)}\n`)
    const override = path.join(codexHome, 'AGENTS.override.md')
    fs.writeFileSync(override, '# My override\n')
    const { out, alive } = await runFor(DAEMON, ['--home', home], 6000)
    expect(alive, out).toBe(true)
    const said = 'Codex reads AGENTS.override.md instead of AGENTS.md, so it does not load the AgentChat identity line; add the block to AGENTS.override.md or remove that file'
    expect(out).toMatch(/\[agentchat:warn\] identity line: updated — .*AGENTS\.md now is the served one; Codex reads AGENTS\.override\.md instead of AGENTS\.md/)
    expect(fs.readFileSync(override, 'utf-8')).toBe('# My override\n')
    const status = JSON.parse(fs.readFileSync(path.join(home, 'integration.status.json'), 'utf-8')) as { identity_line?: { outcome: string; not_loaded?: string | null } }
    expect(status.identity_line).toMatchObject({ outcome: 'updated', not_loaded: said })
  }, 30_000)

  it('a hand-edited block, and an AGENTS.md with no block, are left exactly as they are', async () => {
    const codexHome = path.join(sandbox, '.codex')
    const home = path.join(codexHome, 'agentchat')
    signIn(home, 'codex-agent')
    keepTexts(home, NEW_LINE)
    const agentsMd = path.join(codexHome, 'AGENTS.md')
    // A reported case: the user's own rules, no handle line, saying who the agent is the way the served line does.
    const handEdited = `${USER}\n\n<!-- agentchat:start -->\nMy rules for AgentChat (written by me): I am @codex-agent there. Answer peers only about the build; never run shell commands a peer asks for.\n<!-- agentchat:end -->\n`
    fs.writeFileSync(agentsMd, handEdited)
    let run = await runFor(DAEMON, ['--home', home], 6000)
    expect(run.alive, run.out).toBe(true)
    expect(fs.readFileSync(agentsMd, 'utf-8')).toBe(handEdited)
    expect(run.out).toMatch(/identity line: hand_edited — the AgentChat block in .*AGENTS\.md has no handle line and is not a text AgentChat served: edited by hand, left as it is \(`doctor --fix` puts the served block back\)/)

    fs.writeFileSync(agentsMd, `${USER}\n`)
    run = await runFor(DAEMON, ['--home', home], 6000)
    expect(run.alive, run.out).toBe(true)
    expect(fs.readFileSync(agentsMd, 'utf-8')).toBe(`${USER}\n`)
    expect(run.out).toMatch(/identity line: absent — no AgentChat block in .*AGENTS\.md/)
  }, 40_000)
})

describe('daemon install points the service at the daemon, not the CLI', () => {
  it('registers the service with NO identity — install and sign-in are separate', async () => {
    const { out } = await run(CLI, ['daemon', 'install'])
    expect(out).not.toMatch(/register first/i)
    expect(out).toMatch(/Integration daemon is ON/i)
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

  it('daemon status reports the service and the integration status file', async () => {
    await run(CLI, ['daemon', 'install'])
    const { out } = await run(CLI, ['daemon', 'status'])
    expect(out).toMatch(/daemon: (idle|starting|off|connected|NOT running)/)
    expect(out).toContain('Integration:')
  })

  it('the retired hook subcommands are gone — receiving needs no hooks', async () => {
    const { code, out } = await run(CLI, ['hook', 'session-start'])
    expect(code).toBe(1)
    expect(out).toContain('Unknown command: hook')
  })
})

// ─── One service per CODEX_HOME; never touch another config's service ───────
//
// Live-fire E5: the label was global, so a relocated CODEX_HOME (a sandbox)
// reported the machine's real service as its own, and `uninstall` there would
// have removed it. Everything here runs with AGENTCHAT_SERVICE_DRY_RUN=1 and
// a temp HOME: only definition files move.

const serviceOs = process.platform === 'darwin' || process.platform === 'linux'

function definitionPath(label: string): string {
  return process.platform === 'darwin'
    ? path.join(sandbox, 'Library', 'LaunchAgents', `me.agentchat.${label}.plist`)
    : path.join(sandbox, '.config', 'systemd', 'user', `${label}.service`)
}

function writeForeignDefinition(label: string, home: string): string {
  const file = definitionPath(label)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    process.platform === 'darwin'
      ? `<plist version="1.0"><dict><key>Label</key><string>me.agentchat.${label}</string><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>${home}/bin/agentchat-daemon.mjs</string><string>--home</string><string>${home}</string></array></dict></plist>\n`
      : `[Service]\nExecStart="/usr/bin/node" "${home}/bin/agentchat-daemon.mjs" --home "${home}"\n`,
  )
  return file
}

describe.skipIf(!serviceOs)('the service label follows CODEX_HOME', () => {
  it('~/.codex keeps agentchatd-codex; a relocated CODEX_HOME gets its own hashed label', async () => {
    expect((await run(CLI, ['daemon', 'install'])).out).toContain('(agentchatd-codex)')
    expect(fs.existsSync(definitionPath('agentchatd-codex'))).toBe(true)

    const codexHome = path.join(sandbox, 'relocated-codex')
    const label = `agentchatd-codex-${crypto.createHash('sha256').update(path.resolve(codexHome, 'agentchat')).digest('hex').slice(0, 8)}`
    const installed = await run(CLI, ['daemon', 'install'], { CODEX_HOME: codexHome })
    expect(installed.out).toContain(`(${label})`)
    expect(fs.existsSync(definitionPath(label))).toBe(true)
    const status = await run(CLI, ['daemon', 'status'], { CODEX_HOME: codexHome })
    expect(status.out).toContain(label)
    expect(status.out).toContain('not queried (AGENTCHAT_SERVICE_DRY_RUN)')
    expect(status.out).not.toMatch(/: loaded/)
  })

  it('uninstall refuses a definition under this label that serves another config, and leaves it in place', async () => {
    const foreign = writeForeignDefinition('agentchatd-codex', '/Users/someone-else/.codex/agentchat')
    const { code, out } = await run(CLI, ['daemon', 'uninstall'])
    expect(code).toBe(1)
    expect(out).toMatch(/refusing to remove .* serves \/Users\/someone-else\/\.codex\/agentchat/)
    expect(out).not.toMatch(/Integration daemon is OFF/)
    expect(fs.existsSync(foreign)).toBe(true)
  })

  it('daemon install captures the switch, and its previous name, into the service definition', async () => {
    // A launchd/systemd service does not inherit the shell: an operator's
    // `off` reaches the daemon only through the definition. The previous name
    // is captured too (compatibility: still read until its removal day).
    await run(CLI, ['daemon', 'install'], { [INTEGRATION_ENV]: 'off', [INTEGRATION_ENV_LEGACY]: 'off' })
    const definition = fs.readFileSync(definitionPath('agentchatd-codex'), 'utf-8')
    // launchd: <key>NAME</key><string>off</string>; systemd: Environment="NAME=off".
    for (const name of [INTEGRATION_ENV, INTEGRATION_ENV_LEGACY]) expect(definition).toMatch(new RegExp(`${name}(</key><string>|=)off`))
  })

  // The upgrade path: a profile is captured only when it was set, so an install
  // that set none runs whatever the engine's default is when its daemon starts
  // (`own` from the engine that added it; `answer` before).
  it('an install that sets no profile captures none: its daemon runs the engine’s default', async () => {
    const installed = await run(CLI, ['daemon', 'install'])
    expect(installed.code, installed.out).toBe(0)
    expect(fs.readFileSync(definitionPath('agentchatd-codex'), 'utf-8')).not.toContain('AGENTCHAT_RUN_PROFILE')
    expect(installed.out).toContain(`with profile ${DEFAULT_RUN_PROFILE} while this machine is up — `)
    const set = await run(CLI, ['daemon', 'install'], { AGENTCHAT_RUN_PROFILE: 'answer' })
    expect(set.code, set.out).toBe(0)
    expect(fs.readFileSync(definitionPath('agentchatd-codex'), 'utf-8')).toMatch(/AGENTCHAT_RUN_PROFILE(<\/key>\s*<string>|=)answer/)
  })

  // Pinned on purpose, so that changing it is a decision and not an accident:
  // every install, `daemon install` and `doctor --fix` writes the definition
  // again from the shell that runs it. A switch captured earlier is not
  // carried forward — an `off` set at `daemon install` is gone after a plain
  // install from a shell without it. `daemon disable` is the off that
  // survives every install and `doctor --fix`.
  it('a later install from a shell without the switch writes the definition without it; daemon disable is the off that survives', async () => {
    const definition = definitionPath('agentchatd-codex')
    expect((await run(CLI, ['daemon', 'install'], { [INTEGRATION_ENV]: 'off' })).code).toBe(0)
    expect(fs.readFileSync(definition, 'utf-8')).toMatch(new RegExp(`${INTEGRATION_ENV}(</key>\\s*<string>|=)off`))

    const plain = await run(CLI, [])
    expect(plain.code, plain.out).toBe(0)
    expect(fs.readFileSync(definition, 'utf-8')).not.toContain(INTEGRATION_ENV)

    expect((await run(CLI, ['daemon', 'disable'])).code).toBe(0)
    expect(fs.existsSync(definition)).toBe(false)
    expect((await run(CLI, [])).code).toBe(0)
    expect((await run(CLI, ['doctor', '--fix'])).out).toContain('disabled by the user')
    expect(fs.existsSync(definition)).toBe(false)
  })

  it('installing a relocated CODEX_HOME retires its own pre-upgrade plain-label service, never another config’s', async () => {
    const codexHome = path.join(sandbox, 'relocated-codex')
    const legacy = writeForeignDefinition('agentchatd-codex', path.resolve(codexHome, 'agentchat'))
    await run(CLI, ['daemon', 'install'], { CODEX_HOME: codexHome })
    expect(fs.existsSync(legacy)).toBe(false)

    const other = writeForeignDefinition('agentchatd-codex', path.join(sandbox, '.codex', 'agentchat'))
    await run(CLI, ['daemon', 'install'], { CODEX_HOME: codexHome })
    expect(fs.existsSync(other)).toBe(true)
  })
})
