import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as engine from '@agentchatme/agent-core'
import { manualPointer, PEER_RUN_WARNING, RUN_PROFILES, type RunProfile } from '@agentchatme/agent-core'
import * as presets from '@agentchatme/agent-core/presets'
import { codexRunArgs } from '@agentchatme/agent-core/presets'
import { CodexRunner, OWN_PROFILE_LINE, OWN_PROFILE_WARNING, guardsHomeWorkdir, profileNote, profileSummary, runPointer } from '../src/runner.js'
import { headersHelperCommand, headersHelperPathFor } from '../src/headers-helper.js'
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

/**
 * Whether the engine this build runs on has the `own` profile. The pin moves to
 * that engine at the release step; until then the tests that need it skip,
 * and pass with the new engine linked in.
 */
const ENGINE_HAS_OWN = (RUN_PROFILES as readonly string[]).includes('own')
const OWN = 'own' as RunProfile
const OTHER_KEY = 'ac_live_' + 'o'.repeat(40)
/** `-c mcp_servers.agentchat.http_headers_helper=<the identity home's helper>`, as every run of this integration carries it. */
const HELPER_PIN = (): string[] => ['-c', `mcp_servers.agentchat.http_headers_helper=${JSON.stringify(headersHelperCommand(headersHelperPathFor(identityHome))!)}`]
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
    expect(listing!.argv).toEqual(['mcp', 'list', '--json', ...ANSWER_FLAGS, ...HELPER_PIN()])
    expect(fs.realpathSync(listing!.cwd)).toBe(fs.realpathSync(workdir))

    const runs = readRuns(fake)
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    // Only agentchat is listed: nothing to switch off, the argv is the answer argv with the identity home's helper pinned.
    expect(run.argv).toEqual([...codexRunArgs('answer', { workdir }).slice(0, -1), ...HELPER_PIN(), '-'])
    // The whole multi-line prompt arrives on stdin, byte for byte — on Windows
    // an argument would be cut at the first line break by cmd.exe.
    expect(run.stdin).toBe(prompts.wake)
    expect(prompts.wake).toContain('\n')
    expect(run.argv.join(' ')).not.toContain('woken by AgentChat')
    expect(run.stdin!.startsWith(SERVED_WAKE)).toBe(true)
    expect(run.stdin).not.toMatch(/gate step/i)
    expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(workdir))
    expect(run.env['CODEX_HOME']).toBe(codexHome)
    // No key in a run's environment: the hosted server's Authorization comes from the helper, which reads the identity file.
    expect(run.env['AGENTCHAT_API_KEY']).toBeUndefined()
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
      ...HELPER_PIN(),
      '-c',
      'mcp_servers.github.enabled=false',
      '-c',
      'mcp_servers.computer-use.enabled=false',
      '-',
    ])
    expect(run.argv.join(' ')).not.toContain('mcp_servers.agentchat.enabled')
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
    expect(run.argv).toEqual([...codexRunArgs('work', { workdir }).slice(0, -1), ...HELPER_PIN(), '-'])
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

describe('the integration\'s runs keep the config.toml hosted server, and no key rides in their environment', () => {
  // `agentchat listen --preset codex` overrides `[mcp_servers.agentchat]` per run
  // (`-c mcp_servers.agentchat.*`, its own key variable). This integration's runs
  // use the entry the installer placed in config.toml, with the identity home's
  // headers helper pinned: the key reaches the hosted server from the identity
  // file, never through the run's environment, where Codex's own `.env` load
  // would overwrite it (a foreign key there made runs another agent) and every command a work or full
  // run starts would inherit it. (An answer run's
  // `-c mcp_servers.<other>.enabled=false` switches OTHER servers off.)
  it('every profile pins the helper and nothing else of the table; no key in the environment, even one the daemon inherited', () => {
    for (const profile of ['answer', 'work', 'full'] as const) {
      const r = runner(profile, { AGENTCHAT_API_KEY: OTHER_KEY })
      expect(r.args().filter((a) => a.startsWith('mcp_servers.agentchat'))).toEqual([HELPER_PIN()[1]])
      expect(r.args().at(-1)).toBe('-')
      const childEnv = r.env()
      expect(childEnv['AGENTCHAT_API_KEY']).toBeUndefined()
      expect(childEnv['AGENTCHAT_LISTENER_API_KEY']).toBeUndefined()
      expect(Object.values(childEnv)).not.toContain(KEY)
      expect(Object.values(childEnv)).not.toContain(OTHER_KEY)
    }
  })

  it('the pinned helper yields the identity file’s key, whatever the environment or .env say', async () => {
    fs.writeFileSync(path.join(codexHome, '.env'), `AGENTCHAT_API_KEY=${OTHER_KEY}\n`)
    const r = runner('answer', { AGENTCHAT_API_KEY: OTHER_KEY })
    fs.mkdirSync(workdir, { recursive: true })
    expect(await r.preflight()).toEqual({ ok: true }) // writes the helper when it is missing
    const command = JSON.parse(HELPER_PIN()[1]!.slice('mcp_servers.agentchat.http_headers_helper='.length)) as string
    const out = spawnSync(command, { shell: true, encoding: 'utf-8', env: { ...process.env, AGENTCHAT_API_KEY: OTHER_KEY } })
    expect(out.status, out.stderr).toBe(0)
    expect(JSON.parse(out.stdout)).toEqual({ Authorization: `Bearer ${KEY}` })
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
      expect(args.slice(-5)).toEqual(['-c', `mcp_servers.agentchat.url=${JSON.stringify(url)}`, ...HELPER_PIN(), '-'])
      expect(args.filter((a) => a.startsWith('mcp_servers.agentchat.'))).toEqual([`mcp_servers.agentchat.url=${JSON.stringify(url)}`, HELPER_PIN()[1]])
    }
    // The answer run's listing carries the pin too (Codex lists what the run would load), and so does the run.
    fs.mkdirSync(workdir, { recursive: true })
    await new CodexRunner({ codexHome, identityHome, workdir, profile: 'answer', pinMcpUrl: url, env: env() }).start({ kind: 'wake', prompt: 'P', runId: 'p1', budgetMs: 10_000 })
    expect(readListings(fake)[0]!.argv).toContain(`mcp_servers.agentchat.url=${JSON.stringify(url)}`)
    expect(readRuns(fake)[0]!.argv.slice(-5)).toEqual(['-c', `mcp_servers.agentchat.url=${JSON.stringify(url)}`, ...HELPER_PIN(), '-'])
  })
})

describe('the prompt’s last line and the profile words', () => {
  it('an answer run’s prompt carries no pointer to a skill it cannot open; work and full get it', () => {
    const skill = path.join(codexHome, 'skills', 'agentchat', 'SKILL.md')
    expect(runPointer('answer', skill)).toBe('')
    for (const profile of ['work', 'full'] as const) expect(runPointer(profile, skill)).toBe(manualPointer(`at ${skill}`))
  })

  it('an own run’s prompt gets the pointer (Codex’s sandboxes never restrict reads)', () => {
    const skill = path.join(codexHome, 'skills', 'agentchat', 'SKILL.md')
    expect(runPointer(OWN, skill)).toBe(manualPointer(`at ${skill}`))
  })

  it('every profile is said plainly: own in one line with the honest sentence, work and full with the engine’s warning', () => {
    expect(OWN_PROFILE_LINE).toBe('reply runs use your own Codex permission settings, with anything that would ask refused')
    expect(profileSummary('own')).toBe(`${OWN_PROFILE_LINE}; runs started by peers' messages act with those permissions`)
    expect(profileNote('own')).toBe(` — ${profileSummary('own')}`)
    expect(profileSummary('answer')).toBe('the AgentChat tools only — no shell, no web, no file tool, no other MCP server')
    for (const profile of ['work', 'full']) expect(profileNote(profile)).toContain(PEER_RUN_WARNING)
    expect(guardsHomeWorkdir('own')).toBe(true)
    expect(guardsHomeWorkdir('answer')).toBe(true)
    expect(guardsHomeWorkdir('full')).toBe(false)
  })

  it.skipIf(!ENGINE_HAS_OWN)('the own words are the engine’s', () => {
    const words = engine as unknown as { ownProfileLine: (label: string) => string; OWN_RUN_WARNING: string }
    expect(OWN_PROFILE_LINE).toBe(words.ownProfileLine('Codex'))
    expect(OWN_PROFILE_WARNING).toBe(words.OWN_RUN_WARNING)
  })
})

describe.skipIf(!ENGINE_HAS_OWN)('own: the agent itself, under the user’s own config.toml', () => {
  it('the default when AGENTCHAT_RUN_PROFILE is unset; an unknown value is answer', () => {
    expect(engine.resolveRunProfile({})).toBe(OWN)
    expect(engine.resolveRunProfile({ AGENTCHAT_RUN_PROFILE: 'yolo' })).toBe('answer')
  })

  it('a run: no sandbox, approval, feature or permission-profile flag; only the URL and the helper pinned; no listing; no key in its environment', async () => {
    const url = 'https://api.agentchat.test/mcp'
    const r = new CodexRunner({ codexHome, identityHome, workdir, profile: OWN, pinMcpUrl: url, env: env({ AGENTCHAT_API_KEY: OTHER_KEY }) })
    expect(r.args()).toEqual(['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', workdir, '-c', `mcp_servers.agentchat.url=${JSON.stringify(url)}`, ...HELPER_PIN(), '-'])
    expect(await r.preflight()).toEqual({ ok: true })
    expect((await r.start({ kind: 'wake', prompt: 'P', runId: 'own-1', budgetMs: 10_000 })).state).toBe('ok')
    expect(readListings(fake)).toEqual([])
    const [run] = readRuns(fake)
    expect(run!.argv).toEqual(r.args())
    expect(run!.stdin).toBe('P')
    // What the spawned run was given, not only what the runner would give.
    expect(run!.env.AGENTCHAT_API_KEY).toBeUndefined()
    expect(run!.env.CODEX_HOME).toBe(codexHome)
    expect(Object.values(r.env())).not.toContain(OTHER_KEY)
  })

  it('a home-folder working root: own runs work in the empty folder answer runs use', () => {
    expect(runner(OWN as 'answer', {}, fakeHome).workdir()).toBe(path.join(codexHome, 'agentchat-answer-workdir'))
  })
})

/**
 * The runtime check (could not process) comes from the engine's Codex preset:
 * the runner here inherits it, with this integration's environment. Until the
 * pin moves to that engine the test skips, and passes with it linked in.
 */
type RuntimeCheck = (options?: { signal?: AbortSignal }) => Promise<{ ok: boolean; detail?: string }>
const ENGINE_HAS_RUNTIME_CHECK = typeof (CodexRunner.prototype as unknown as { checkRuntime?: unknown }).checkRuntime === 'function'

describe.skipIf(!ENGINE_HAS_RUNTIME_CHECK)('the runtime check (could not process): the engine’s, as this integration’s runner inherits it', () => {
  it('one `codex exec` with the fixed prompt: read-only, ephemeral, the AgentChat server switched off, no headers helper and no key, in an empty folder of its own; ok when the model answers, not ok when it fails', async () => {
    const url = 'https://api.agentchat.test/mcp'
    const r = new CodexRunner({ codexHome, identityHome, workdir, profile: OWN, pinMcpUrl: url, env: env({ AGENTCHAT_API_KEY: OTHER_KEY }) })
    const check = (r as unknown as { checkRuntime: RuntimeCheck }).checkRuntime.bind(r)
    expect(await check()).toEqual({ ok: true })
    const runs = readRuns(fake)
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.stdin).toBe((presets as unknown as { RUNTIME_CHECK_PROMPT: string }).RUNTIME_CHECK_PROMPT)
    expect(run.stdin).toBe('Reply with the single word OK.')
    const dir = path.join(codexHome, 'agentchat-runtime-check')
    expect(run.argv).toEqual(['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', dir, '--sandbox', 'read-only', '-c', `mcp_servers.agentchat.url=${JSON.stringify(url)}`, '-c', 'mcp_servers.agentchat.enabled=false', '-'])
    // The run's headers helper is not pinned for it: the AgentChat server is off, and the check needs no key.
    expect(run.argv.join(' ')).not.toContain('http_headers_helper')
    expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(dir))
    expect(run.env.AGENTCHAT_API_KEY).toBeUndefined()
    expect(run.env.CODEX_HOME).toBe(codexHome)
    expect(JSON.stringify(run)).not.toContain(KEY)
    expect(JSON.stringify(run)).not.toContain(OTHER_KEY)

    // A provider error (some output, exit 1) is not ok.
    const failing = new CodexRunner({ codexHome, identityHome, workdir, profile: OWN, pinMcpUrl: url, env: env({ FAKE_CODEX_RUN: 'fail' }) })
    expect(await (failing as unknown as { checkRuntime: RuntimeCheck }).checkRuntime()).toMatchObject({ ok: false, detail: expect.stringContaining('codex runtime check failed') })
  })
})
