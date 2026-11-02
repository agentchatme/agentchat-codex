import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildDoorbellPrompts, manualPointer, mcpToolNamer, wakeInstruction } from '@agentchatme/agent-core'
import { CodexRunner } from '../src/runner.js'
import { codexRunArgs } from '../src/profile.js'
import { installFakeCodex, readRuns, type FakeCodex } from './helpers/fake-codex.js'

// ─── One headless Codex run: the exact flags, the prompt as the positional ──

let sandbox: string
let fake: FakeCodex
let workdir: string
let codexHome: string
let identityHome: string
const KEY = 'ac_live_' + 'k'.repeat(40)
const originalPath = process.env['PATH']

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-'))
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
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, FAKE_CODEX_RECORD: fake.recordPath, ...extra })
const runner = (profile: 'answer' | 'work' | 'full', extra: Record<string, string> = {}) =>
  new CodexRunner({ codexHome, identityHome, workdir, profile, env: env(extra) })

describe('the permission profiles, as codex exec flags', () => {
  it('answer: read-only sandbox, approvals never asked', () => {
    expect(codexRunArgs('answer', { workdir: '/w', prompt: 'P' })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '-C',
      '/w',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      'P',
    ])
  })

  it('work: workspace-write sandbox, approvals never asked', () => {
    expect(codexRunArgs('work', { workdir: '/w', prompt: 'P' })).toEqual([
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
      'P',
    ])
  })

  it('full: the runtime’s bypass', () => {
    expect(codexRunArgs('full', { workdir: '/w', prompt: 'P' })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '-C',
      '/w',
      '--dangerously-bypass-approvals-and-sandbox',
      'P',
    ])
  })

  it('no profile hands the prompt a way to wait: every variant is approval-free', () => {
    for (const profile of ['answer', 'work', 'full'] as const) {
      const args = codexRunArgs(profile, { workdir: '/w', prompt: 'P' })
      expect(args.includes('approval_policy="never"') || args.includes('--dangerously-bypass-approvals-and-sandbox')).toBe(true)
      expect(args[args.length - 1]).toBe('P')
    }
  })
})

describe('CodexRunner', () => {
  const prompts = buildDoorbellPrompts({ toolName: mcpToolNamer('agentchat'), manualPointer: manualPointer('at ~/.codex/skills/agentchat/SKILL.md') })

  it('preflight passes with a current, signed-in codex', async () => {
    expect(await runner('answer').preflight()).toEqual({ ok: true })
    expect(fs.existsSync(workdir)).toBe(true)
  })

  it('preflight fails when codex is signed out', async () => {
    process.env['FAKE_CODEX_LOGGED_OUT'] = '1'
    expect(await runner('answer').preflight()).toMatchObject({ ok: false, detail: expect.stringMatching(/login status failed/) })
  })

  it('preflight fails on a codex older than the verified floor', async () => {
    fake = installFakeCodex(sandbox, '0.129.0')
    expect(await runner('answer').preflight()).toMatchObject({ ok: false, detail: expect.stringMatching(/>= 0\.154\.0/) })
  })

  it('a knock run: the server’s wake text as the prompt, the profile flags, the workdir, the key in the environment, stdin closed — output discarded', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    const outcome = await runner('answer').start({ kind: 'knock', prompt: prompts.knock, runId: 'r1', budgetMs: 10_000 })
    expect(outcome).toMatchObject({ state: 'ok', exitCode: 0 })
    expect(JSON.stringify(outcome)).not.toContain('Peer text')

    const runs = readRuns(fake)
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.argv).toEqual(codexRunArgs('answer', { workdir, prompt: prompts.knock }))
    const prompt = run.argv[run.argv.length - 1]!
    expect(prompt.startsWith(wakeInstruction(mcpToolNamer('agentchat')))).toBe(true)
    expect(prompt).toContain('mcp__agentchat__agentchat_inbox')
    expect(prompt).not.toMatch(/gate step/i)
    expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(workdir))
    expect(run.env['CODEX_HOME']).toBe(codexHome)
    expect(run.env['AGENTCHAT_API_KEY']).toBe(KEY)
    expect(run.stdinIsTTY).toBe(false)
  })

  it('an invite run uses the invite prompt', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    await runner('work').start({ kind: 'invite', prompt: prompts.invite, runId: 'r2', budgetMs: 10_000 })
    const run = readRuns(fake)[0]!
    expect(run.argv[run.argv.length - 1]).toBe(prompts.invite)
    expect(run.argv).toContain('workspace-write')
  })

  it('classifies: a failure after output is failed, a silent non-zero exit is not_started, a hang is timed_out', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    const request = { kind: 'knock' as const, prompt: 'P', runId: 'r', budgetMs: 15_000 }
    const failed = await runner('answer', { FAKE_CODEX_RUN: 'fail' }).start(request)
    expect(failed).toMatchObject({ state: 'failed', exitCode: 1 })
    expect(failed.detail).toContain('the fake runtime failed')
    const nostart = await runner('answer', { FAKE_CODEX_RUN: 'nostart' }).start(request)
    expect(nostart).toMatchObject({ state: 'not_started', exitCode: 2 })
    const hang = await runner('answer', { FAKE_CODEX_RUN: 'hang' }).start({ ...request, budgetMs: 1_500 })
    expect(hang.state).toBe('timed_out')
  }, 40_000)

  it('a missing codex binary is not_started, never a throw', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    const r = new CodexRunner({ codexHome, identityHome, workdir, profile: 'answer', command: path.join(sandbox, 'no-such-codex'), env: env() })
    expect((await r.start({ kind: 'knock', prompt: 'P', runId: 'r', budgetMs: 1_000 })).state).toBe('not_started')
  })
})
