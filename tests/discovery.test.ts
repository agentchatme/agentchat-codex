import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { installFakeCodex } from './helpers/fake-codex.js'

// ─── A fresh install must be discoverable, and the offer must be able to stop ─
//
// AGENTS.md is always loaded, so the wizard's offer lives there. Static text
// has no memory, so a declined offer would be re-read and re-raised every
// session unless `--not-now` records the answer and rewrites the block.

const CLI = path.join(__dirname, '..', 'dist', 'index.js')

let sandbox: string
let fakeBin: string
const codexHome = (): string => path.join(sandbox, '.codex')
const agentsMd = (): string => path.join(codexHome(), 'AGENTS.md')

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-'))
  fakeBin = installFakeCodex(sandbox).binDir
})
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      {
        env: {
          PATH: `${fakeBin}${path.delimiter}${process.env['PATH'] ?? ''}`,
          HOME: sandbox,
          USERPROFILE: sandbox,
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
  it('writes AGENTS.md immediately, guiding Codex through email, handle, then code — one question at a time', async () => {
    const { code } = await run([])
    expect(code).toBe(0)
    const md = fs.readFileSync(agentsMd(), 'utf-8')
    expect(md).toContain('this agent has no account yet')
    const email = md.indexOf('I need an email for verification')
    const handle = md.indexOf('Now we need to choose an AgentChat username')
    const register = md.indexOf('register --email <email> --handle <handle>')
    const codeStep = md.indexOf('AgentChat sent a 6-digit code')
    expect(email).toBeGreaterThan(-1)
    expect(handle).toBeGreaterThan(email)
    expect(register).toBeGreaterThan(handle)
    expect(codeStep).toBeGreaterThan(register)
    expect(md).toContain('register --not-now')
    expect(fs.existsSync(path.join(codexHome(), 'hooks.json'))).toBe(false)
  })
})

describe('declining is remembered — static text cannot remember on its own', () => {
  it('--not-now replaces the offer with a block that instructs nothing, and a re-install does not resurrect it', async () => {
    await run([])
    const { code, out } = await run(['register', '--not-now'])
    expect(code).toBe(0)
    expect(out).toContain('will not ask about AgentChat again')
    let md = fs.readFileSync(agentsMd(), 'utf-8')
    expect(md).toContain('Do not offer to set it up')
    expect(md).not.toContain('Ask exactly')
    await run([])
    md = fs.readFileSync(agentsMd(), 'utf-8')
    expect(md).toContain('Do not offer to set it up')
    expect(md).not.toContain('no account yet')
    expect(md.split('<!-- agentchat:start -->')).toHaveLength(2)
  })

  it('preserves the user’s own AGENTS.md content throughout', async () => {
    fs.mkdirSync(codexHome(), { recursive: true })
    fs.writeFileSync(agentsMd(), '# Mine\n\nKeep this.\n')
    await run([])
    await run(['register', '--not-now'])
    await run([])
    const md = fs.readFileSync(agentsMd(), 'utf-8')
    expect(md.startsWith('# Mine\n\nKeep this.\n')).toBe(true)
  })
})
