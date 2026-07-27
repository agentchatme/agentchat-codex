import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ─── A fresh install must be discoverable without a hook ────────────────────
//
// Codex requires every command hook to be reviewed and trusted before it runs,
// and treats new or CHANGED hooks as untrusted. So on a fresh install all three
// of ours are SKIPPED — including the session-start hook that would have
// offered to set up a handle. The user saw an install that appeared to do
// nothing, with no way to learn AgentChat was even there.
//
// AGENTS.md is always loaded and needs no approval, so discovery lives there.
// The risk of moving it is the opposite failure: static text has no memory, so
// a declined offer would be re-read and re-raised every session. These pin both
// ends — it must appear, and it must be able to stop.

const CLI = path.join(__dirname, '..', 'dist', 'index.js')

let sandbox: string
const codexHome = (): string => path.join(sandbox, '.codex')
const agentsMd = (): string => path.join(codexHome(), 'AGENTS.md')

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-'))
})
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: sandbox,
          CODEX_HOME: codexHome(),
          AGENTCHAT_SERVICE_DRY_RUN: '1',
          AGENTCHAT_API_BASE: 'http://127.0.0.1:9',
          AGENTCHAT_LOG_LEVEL: 'silent',
        },
        timeout: 20_000,
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
        resolve({ code: typeof e?.code === 'number' ? e.code : e ? 1 : 0, out: `${stdout}${stderr}` })
      },
    )
    child.stdin?.end()
  })
}

describe('installing writes a discovery block, with no identity and no hook', () => {
  it('writes AGENTS.md immediately — the old build wrote nothing until registration', async () => {
    await run([])
    expect(fs.existsSync(agentsMd()), 'AGENTS.md should exist right after install').toBe(true)
    const md = fs.readFileSync(agentsMd(), 'utf-8')
    expect(md).toContain('no handle yet')
    expect(md).toMatch(/register --email/)
  })

  it('tells the agent how to stop being asked', async () => {
    await run([])
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toContain('--not-now')
  })

  it('names the /hooks approval step, since hooks are inert until then', async () => {
    const { out } = await run([])
    expect(out).toContain('/hooks')
  })
})

describe('declining is remembered — static text cannot remember on its own', () => {
  it('--not-now replaces the offer with a block that instructs nothing', async () => {
    await run([])
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toContain('Offer this ONCE')

    const { code, out } = await run(['register', '--not-now'])
    expect(code).toBe(0)
    expect(out).toMatch(/will not ask/i)

    const md = fs.readFileSync(agentsMd(), 'utf-8')
    // The fact survives so the agent can still answer "am I on AgentChat?"…
    expect(md).toContain('AgentChat')
    // …but every instruction to raise it is gone.
    expect(md).not.toContain('Offer this ONCE')
    expect(md).toContain('Do not offer')
  })

  it('survives a re-install — an upgrade must not resurrect the nag', async () => {
    await run([])
    await run(['register', '--not-now'])
    await run([]) // re-run the installer, as an upgrade would
    const md = fs.readFileSync(agentsMd(), 'utf-8')
    expect(md).not.toContain('Offer this ONCE')
    expect(md).toContain('Do not offer')
  })

  it('leaves exactly ONE anchor block however many times it is rewritten', async () => {
    await run([])
    await run([])
    await run(['register', '--not-now'])
    await run([])
    const md = fs.readFileSync(agentsMd(), 'utf-8')
    const starts = (md.match(/<!-- agentchat:start -->/g) ?? []).length
    const ends = (md.match(/<!-- agentchat:end -->/g) ?? []).length
    expect(starts, 'the block must never accumulate').toBe(1)
    expect(ends).toBe(1)
  })

  it('logout removes the block entirely', async () => {
    await run([])
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toContain('agentchat:start')
    await run(['logout'])
    const md = fs.existsSync(agentsMd()) ? fs.readFileSync(agentsMd(), 'utf-8') : ''
    expect(md).not.toContain('agentchat:start')
  })

  it('preserves the user’s own AGENTS.md content throughout', async () => {
    fs.mkdirSync(codexHome(), { recursive: true })
    fs.writeFileSync(agentsMd(), '# My notes\n\nAlways use tabs.\n')

    await run([])
    await run(['register', '--not-now'])
    await run(['logout'])

    const md = fs.readFileSync(agentsMd(), 'utf-8')
    expect(md).toContain('# My notes')
    expect(md).toContain('Always use tabs.')
  })
})

describe('doctor reports whether Codex will actually run the hooks', () => {
  it('warns when no trust entry exists — the silent-failure case', async () => {
    await run([])
    const { out } = await run(['doctor'])
    expect(out).toContain('hook-trust')
    expect(out).toMatch(/not trusted/i)
    expect(out).toContain('/hooks')
  })

  it('passes once config.toml records trust for all three events', async () => {
    await run([])
    const hooksPath = path.join(codexHome(), 'hooks.json')
    const cfgPath = path.join(codexHome(), 'config.toml')
    const trust = ['session_start', 'user_prompt_submit', 'stop']
      .map((e, i) => `\n[hooks.state."${hooksPath}:${e}:0:0"]\ntrusted_hash = "sha256:deadbeef${i}"\n`)
      .join('')
    fs.appendFileSync(cfgPath, trust)

    const { out } = await run(['doctor'])
    expect(out).toMatch(/PASS hook-trust|hook-trust: Codex has trusted/)
  })
})
