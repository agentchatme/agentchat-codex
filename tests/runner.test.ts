import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { manualPointer, PEER_RUN_WARNING } from '@agentchatme/agent-core'
import { codexRunArgs } from '@agentchatme/agent-core/presets'
import { CodexRunner, profileNote, runPointer } from '../src/runner.js'
import { installFakeCodex, readListings, readRuns, type FakeCodex } from './helpers/fake-codex.js'

// ─── One headless Codex run: the exact flags, the prompt on stdin ───────────
//
// HOME is a sandbox for every test here: the runner decides by the home folder
// where an answer run may work, and nothing may reach a developer's real
// `~/.codex`.

let sandbox: string
let fakeHome: string
let fake: FakeCodex
let workdir: string
let codexHome: string
let identityHome: string
const KEY = 'ac_live_' + 'k'.repeat(40)
const originalPath = process.env['PATH']
/** What the runner reads from the process environment, cleared for each test and put back after. */
const SCRUBBED = ['HOME', 'USERPROFILE', 'AGENTCHAT_API_KEY', 'AGENTCHAT_API_BASE', 'CODEX_HOME', 'AGENTCHAT_RUN_PROFILE', 'AGENTCHAT_RUN_CWD'] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-')))
  fakeHome = path.join(sandbox, 'home')
  fs.mkdirSync(fakeHome, { recursive: true })
  saved = Object.fromEntries(SCRUBBED.map((key) => [key, process.env[key]]))
  for (const key of SCRUBBED) delete process.env[key]
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
  fake = installFakeCodex(sandbox)
  workdir = path.join(sandbox, 'workdir')
  codexHome = path.join(sandbox, '.codex')
  identityHome = path.join(codexHome, 'agentchat')
  fs.mkdirSync(identityHome, { recursive: true })
  fs.writeFileSync(path.join(identityHome, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe' }))
  process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
})
afterEach(() => {
  process.env['PATH'] = originalPath
  delete process.env['FAKE_CODEX_LOGGED_OUT']
  for (const key of SCRUBBED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  FAKE_CODEX_RECORD: fake.recordPath,
  FAKE_CODEX_MCP_LIST_RECORD: fake.listRecordPath,
  ...extra,
})
const runner = (profile: 'answer' | 'work' | 'full', extra: Record<string, string> = {}, dir: string = workdir) =>
  new CodexRunner({ codexHome, identityHome, workdir: dir, profile, env: env(extra) })

/** The answer flags after `-C <workdir>`, as Codex 0.154.0 reads them (agent-core's Codex preset). */
const ANSWER_FLAGS = [
  '-c',
  'approval_policy="never"',
  '-c',
  'default_permissions="agentchat_answer"',
  '-c',
  'permissions.agentchat_answer.filesystem={ ":workspace_roots" = "read" }',
  '-c',
  'web_search="disabled"',
  '-c',
  'project_doc_max_bytes=0',
  '--disable',
  'shell_tool',
  '--disable',
  'view_image',
  '--disable',
  'image_generation',
  '--disable',
  'plugins',
  '--disable',
  'apps',
  '--disable',
  'memories',
  '--disable',
  'browser_use',
  '--disable',
  'browser_use_external',
  '--disable',
  'computer_use',
  '--disable',
  'in_app_browser',
]

describe('the permission profiles, as codex exec flags', () => {
  it('answer: no sandbox flag; its own permission profile reads the working root only, no shell, no file or image tool, no plugins, connectors, memories or web search, no project AGENTS.md; approvals never asked', () => {
    expect(codexRunArgs('answer', { workdir: '/w' })).toEqual(['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', '/w', ...ANSWER_FLAGS, '-'])
  })

  it('REGRESSION GUARD: an answer run never gets a sandbox that reads the whole disk, a shell, or a bypass', () => {
    const args = codexRunArgs('answer', { workdir: '/w' })
    expect(args).not.toContain('--sandbox')
    expect(args).not.toContain('read-only')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    const disabled = args.flatMap((arg, i) => (args[i - 1] === '--disable' ? [arg] : []))
    for (const feature of ['shell_tool', 'view_image', 'plugins', 'apps', 'memories']) expect(disabled).toContain(feature)
    expect(args).toContain('project_doc_max_bytes=0')
    expect(args).toContain('web_search="disabled"')
  })

  it('work: workspace-write sandbox, approvals never asked', () => {
    expect(codexRunArgs('work', { workdir: '/w' })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '-C',
      '/w',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-',
    ])
  })

  it('full: the runtime’s bypass', () => {
    expect(codexRunArgs('full', { workdir: '/w' })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '-C',
      '/w',
      '--dangerously-bypass-approvals-and-sandbox',
      '-',
    ])
  })

  it('no profile hands the prompt a way to wait: every variant is approval-free', () => {
    for (const profile of ['answer', 'work', 'full'] as const) {
      const args = codexRunArgs(profile, { workdir: '/w' })
      expect(args.includes('approval_policy="never"') || args.includes('--dangerously-bypass-approvals-and-sandbox')).toBe(true)
      expect(args[args.length - 1]).toBe('-')
    }
  })
})

describe('CodexRunner', () => {
  // The served wake instruction (GET /v1/texts?runtime=codex), as the daemon builds the prompt for an answer run.
  const SERVED_WAKE = 'You were woken by AgentChat. SERVED WAKE INSTRUCTION for codex: call mcp__agentchat__agentchat_inbox first.'
  const prompts = { wake: `${SERVED_WAKE}\n\n${manualPointer('at ~/.codex/skills/agentchat/SKILL.md')}`, invite: 'SERVED INVITE PROMPT' }

  it('preflight passes with a current, signed-in codex (and, for answer, a listing it can act on)', async () => {
    expect(await runner('answer').preflight()).toEqual({ ok: true })
    expect(fs.existsSync(workdir)).toBe(true)
    expect(readListings(fake)).toHaveLength(1)
  })

  it('preflight fails when codex is signed out', async () => {
    process.env['FAKE_CODEX_LOGGED_OUT'] = '1'
    expect(await runner('answer').preflight()).toMatchObject({ ok: false, detail: expect.stringMatching(/login status failed/) })
  })

  it('preflight fails on a codex older than the verified floor', async () => {
    fake = installFakeCodex(sandbox, '0.129.0')
    expect(await runner('answer').preflight()).toMatchObject({ ok: false, detail: expect.stringMatching(/>= 0\.154\.0/) })
  })

  it('an answer wake run: Codex’s MCP servers listed with the run’s own flags from its working root, the answer flags, the prompt on stdin, the key in the environment — output discarded', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    const outcome = await runner('answer', { CODEX_SANDBOX: 'seatbelt', CLAUDECODE: '1' }).start({ kind: 'wake', prompt: prompts.wake, runId: 'r1', budgetMs: 10_000 })
    expect(outcome).toMatchObject({ state: 'ok', exitCode: 0 })
    expect(JSON.stringify(outcome)).not.toContain('Peer text')

    const [listing] = readListings(fake)
    expect(listing!.argv).toEqual(['mcp', 'list', '--json', ...ANSWER_FLAGS])
    expect(fs.realpathSync(listing!.cwd)).toBe(fs.realpathSync(workdir))

    const runs = readRuns(fake)
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    // Only agentchat is listed: nothing to switch off, the argv is the answer argv as it stands.
    expect(run.argv).toEqual(codexRunArgs('answer', { workdir }))
    // The whole multi-line prompt arrives on stdin, byte for byte — on Windows
    // an argument would be cut at the first line break by cmd.exe.
    expect(run.stdin).toBe(prompts.wake)
    expect(prompts.wake).toContain('\n')
    expect(run.argv.join(' ')).not.toContain('woken by AgentChat')
    expect(run.stdin!.startsWith(SERVED_WAKE)).toBe(true)
    expect(run.stdin).not.toMatch(/gate step/i)
    expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(workdir))
    expect(run.env['CODEX_HOME']).toBe(codexHome)
    // config.toml's [mcp_servers.agentchat] reads its bearer token from here; with no shell the model cannot print it.
    expect(run.env['AGENTCHAT_API_KEY']).toBe(KEY)
    expect(run.env['CODEX_SANDBOX']).toBeUndefined() // a parent Codex session's marker is not the run's
    expect(run.stdinIsTTY).toBe(false)
  })

  it('every other MCP server Codex lists is switched off for an answer run; a disabled one is left as it is', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    const listed = JSON.stringify([
      { name: 'agentchat', enabled: true },
      { name: 'github', enabled: true },
      { name: 'computer-use', enabled: true },
      { name: 'off-already', enabled: false },
    ])
    await runner('answer', { FAKE_CODEX_MCP_LIST: listed }).start({ kind: 'wake', prompt: 'P', runId: 'r2', budgetMs: 10_000 })
    const run = readRuns(fake)[0]!
    expect(run.argv).toEqual([
      ...codexRunArgs('answer', { workdir }).slice(0, -1),
      '-c',
      'mcp_servers.github.enabled=false',
      '-c',
      'mcp_servers.computer-use.enabled=false',
      '-',
    ])
    expect(run.argv.join(' ')).not.toContain('mcp_servers.agentchat')
    expect(run.argv.join(' ')).not.toContain('off-already')
  })

  it('a server no -c key can address (a "." in its name) stops answer runs: preflight says why, and no run starts', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    const r = runner('answer', { FAKE_CODEX_MCP_LIST: JSON.stringify([{ name: 'agentchat', enabled: true }, { name: 'my.notes', enabled: true }]) })
    const pre = await r.preflight()
    expect(pre.ok).toBe(false)
    expect(pre.detail).toContain('"my.notes" cannot be switched off')
    expect(await r.start({ kind: 'wake', prompt: 'P', runId: 'r3', budgetMs: 10_000 })).toMatchObject({ state: 'not_started', detail: expect.stringContaining('my.notes') })
    expect(readRuns(fake)).toEqual([])
    // work and full do not list at all: their runs load what Codex loads.
    expect(await runner('work', { FAKE_CODEX_MCP_LIST: JSON.stringify([{ name: 'my.notes', enabled: true }]) }).preflight()).toEqual({ ok: true })
  })

  it('a listing that fails or is not the list means no answer run (fail closed), with Codex’s own complaint', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    const failed = await runner('answer', { FAKE_CODEX_MCP_LIST_MODE: 'fail' }).start({ kind: 'wake', prompt: 'P', runId: 'r4', budgetMs: 10_000 })
    expect(failed).toMatchObject({ state: 'not_started', detail: expect.stringMatching(/could not list Codex's MCP servers .*exited 1: Error: unknown feature flag/) })
    const garbage = await runner('answer', { FAKE_CODEX_MCP_LIST_MODE: 'garbage' }).start({ kind: 'wake', prompt: 'P', runId: 'r5', budgetMs: 10_000 })
    expect(garbage).toMatchObject({ state: 'not_started', detail: expect.stringContaining('not JSON') })
    expect(readRuns(fake)).toEqual([])
  })

  it('a good listing is reused until a config file Codex reads changes: a stranger’s message does not cost a listing per run', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    const r = runner('answer')
    await r.start({ kind: 'wake', prompt: 'P', runId: 'c1', budgetMs: 10_000 })
    await r.start({ kind: 'wake', prompt: 'P', runId: 'c2', budgetMs: 10_000 })
    expect(readListings(fake)).toHaveLength(1)
    fs.mkdirSync(codexHome, { recursive: true })
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.notes]\nurl = "http://127.0.0.1:9/mcp"\n')
    await r.start({ kind: 'wake', prompt: 'P', runId: 'c3', budgetMs: 10_000 })
    expect(readListings(fake)).toHaveLength(2)
    expect(readRuns(fake)).toHaveLength(3)
  })

  it('a working root that is the home folder: answer runs work in their own empty folder under CODEX_HOME; work keeps the operator’s choice', async () => {
    const answer = runner('answer', {}, fakeHome)
    expect(answer.workdir()).toBe(path.join(codexHome, 'agentchat-answer-workdir'))
    expect(await answer.preflight()).toEqual({ ok: true })
    await answer.start({ kind: 'wake', prompt: 'P', runId: 'h1', budgetMs: 10_000 })
    const run = readRuns(fake)[0]!
    expect(run.argv[run.argv.indexOf('-C') + 1]).toBe(path.join(codexHome, 'agentchat-answer-workdir'))
    expect(runner('work', {}, fakeHome).workdir()).toBe(fakeHome)
  })

  it('an invite run uses the invite prompt; work lists no MCP servers', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    await runner('work').start({ kind: 'invite', prompt: prompts.invite, runId: 'r6', budgetMs: 10_000 })
    const run = readRuns(fake)[0]!
    expect(run.stdin).toBe(prompts.invite)
    expect(run.argv).toEqual(codexRunArgs('work', { workdir }))
    expect(readListings(fake)).toEqual([])
  })

  it('classifies: a failure after output is failed, a silent non-zero exit is not_started, a hang is timed_out', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    const request = { kind: 'wake' as const, prompt: 'P', runId: 'r', budgetMs: 15_000 }
    const failed = await runner('answer', { FAKE_CODEX_RUN: 'fail' }).start(request)
    expect(failed).toMatchObject({ state: 'failed', exitCode: 1 })
    expect(failed.detail).toContain('the fake runtime failed')
    const nostart = await runner('answer', { FAKE_CODEX_RUN: 'nostart' }).start(request)
    expect(nostart).toMatchObject({ state: 'not_started', exitCode: 2 })

    // README § Verify step 8: a signed-out Codex complains on stderr and exits — `run not_started`, complaint attached.
    const signedOut = await runner('answer', { FAKE_CODEX_RUN: 'signedout' }).start(request)
    expect(signedOut).toMatchObject({ state: 'not_started', exitCode: 1 })
    expect(signedOut.detail).toMatch(/nothing on stdout: Not logged in/)
    const hang = await runner('answer', { FAKE_CODEX_RUN: 'hang' }).start({ ...request, budgetMs: 1_500 })
    expect(hang.state).toBe('timed_out')
  }, 40_000)

  it('a missing codex binary is not_started, never a throw', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    const r = new CodexRunner({ codexHome, identityHome, workdir, profile: 'answer', command: path.join(sandbox, 'no-such-codex'), env: env() })
    expect((await r.start({ kind: 'wake', prompt: 'P', runId: 'r', budgetMs: 1_000 })).state).toBe('not_started')
  })
})

describe('the integration\'s runs keep the config.toml hosted server', () => {
  // `agentchat listen --preset codex` overrides `[mcp_servers.agentchat]` per run
  // (`-c mcp_servers.agentchat.*`, its own key variable). This integration's runs
  // must not: they use the entry the installer placed in config.toml, keyed by
  // AGENTCHAT_API_KEY, exactly as before the presets moved. (An answer run's
  // `-c mcp_servers.<other>.enabled=false` switches OTHER servers off.)
  it('no profile overrides mcp_servers.agentchat; the key rides in AGENTCHAT_API_KEY', () => {
    for (const profile of ['answer', 'work', 'full'] as const) {
      const r = runner(profile)
      expect(r.args().some((a) => a.startsWith('mcp_servers.agentchat'))).toBe(false)
      const childEnv = r.env()
      expect(childEnv['AGENTCHAT_API_KEY']).toBe(KEY)
      expect(childEnv['AGENTCHAT_LISTENER_API_KEY']).toBeUndefined()
    }
  })
})

describe('the hosted server’s URL is pinned on every run', () => {
  // The daemon passes `pinMcpUrl` (its identity's `<api base>/mcp`): no other
  // config layer — a trusted project's `.codex/config.toml` — can point the
  // agentchat server, and the key its bearer variable carries, elsewhere.
  it('every profile gets -c mcp_servers.agentchat.url=<url> before the prompt, and nothing else of the table is overridden', async () => {
    const url = 'https://api.agentchat.test/mcp'
    for (const profile of ['answer', 'work', 'full'] as const) {
      const r = new CodexRunner({ codexHome, identityHome, workdir, profile, pinMcpUrl: url, env: env() })
      const args = r.args()
      expect(args.slice(-3)).toEqual(['-c', `mcp_servers.agentchat.url=${JSON.stringify(url)}`, '-'])
      expect(args.filter((a) => a.startsWith('mcp_servers.agentchat.'))).toEqual([`mcp_servers.agentchat.url=${JSON.stringify(url)}`])
    }
    // The answer run's listing carries the pin too (Codex lists what the run would load), and so does the run.
    fs.mkdirSync(workdir, { recursive: true })
    await new CodexRunner({ codexHome, identityHome, workdir, profile: 'answer', pinMcpUrl: url, env: env() }).start({ kind: 'wake', prompt: 'P', runId: 'p1', budgetMs: 10_000 })
    expect(readListings(fake)[0]!.argv).toContain(`mcp_servers.agentchat.url=${JSON.stringify(url)}`)
    expect(readRuns(fake)[0]!.argv.slice(-3)).toEqual(['-c', `mcp_servers.agentchat.url=${JSON.stringify(url)}`, '-'])
  })
})

describe('the prompt’s last line and the profile words', () => {
  it('an answer run’s prompt carries no pointer to a skill it cannot open; work and full get it', () => {
    const skill = path.join(codexHome, 'skills', 'agentchat', 'SKILL.md')
    expect(runPointer('answer', skill)).toBe('')
    for (const profile of ['work', 'full'] as const) expect(runPointer(profile, skill)).toBe(manualPointer(`at ${skill}`))
  })

  it('work and full are named with the engine’s warning; answer with nothing', () => {
    expect(profileNote('answer')).toBe('')
    expect(profileNote('work')).toBe(` — ${PEER_RUN_WARNING}`)
    expect(profileNote('full')).toBe(` — ${PEER_RUN_WARNING}`)
  })
})
