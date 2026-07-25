import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const exec = promisify(execFile)
const BIN = path.join(__dirname, '..', 'dist', 'index.js')

// ─── This binary can only act on Codex ──────────────────────────────────────
//
// The property is structural, not defensive. The host is a compile-time fact
// of this package: there is no `--platform` option to parse, no host
// detection, and no branch that could resolve a different agent's home.
//
// Its predecessor was one CLI serving every coding agent, whose commands had
// to choose a host. They chose wrong: registering one agent rewrote another's
// instruction file, and logout deleted both agents' credentials. Those bugs
// are not fixed here — they are unwritable.

let sandbox: string

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-integration-'))
  fs.mkdirSync(path.join(sandbox, '.codex'), { recursive: true })
  // A fully set-up Claude Code agent sharing the machine.
  fs.mkdirSync(path.join(sandbox, '.claude', 'agentchat'), { recursive: true })
  fs.writeFileSync(
    path.join(sandbox, '.claude', 'agentchat', 'credentials'),
    JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'claude-agent' }),
  )
  fs.writeFileSync(
    path.join(sandbox, '.claude', 'CLAUDE.md'),
    '# My notes\n\n<!-- agentchat:start -->\nYou are **@claude-agent** on AgentChat.\n<!-- agentchat:end -->\n',
  )
})

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else out[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    }
  }
  walk(dir)
  return out
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        HOME: sandbox,
        USERPROFILE: sandbox,
        CODEX_HOME: path.join(sandbox, '.codex'),
        AGENTCHAT_API_KEY: '',
        // Unroutable: nothing in these tests should reach the network.
        AGENTCHAT_API_BASE: 'http://127.0.0.1:9',
        AGENTCHAT_LOG_LEVEL: 'silent',
      },
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

const claudeDir = (): string => path.join(sandbox, '.claude')

describe('wiring Codex', () => {
  it('a bare invocation wires Codex and leaves Claude Code byte-identical', async () => {
    const before = snapshot(claudeDir())
    const out = await run([])

    expect(out.code).toBe(0)
    expect(out.stdout).toContain('Codex: wired')
    expect(fs.existsSync(path.join(sandbox, '.codex', 'config.toml'))).toBe(true)
    expect(fs.existsSync(path.join(sandbox, '.codex', 'hooks.json'))).toBe(true)
    expect(snapshot(claudeDir())).toEqual(before)
  })

  it('honours CODEX_HOME rather than assuming ~/.codex', async () => {
    const elsewhere = path.join(sandbox, 'relocated')
    await exec(process.execPath, [BIN], {
      env: { ...process.env, HOME: sandbox, CODEX_HOME: elsewhere, AGENTCHAT_API_KEY: '' },
    })
    expect(fs.existsSync(path.join(elsewhere, 'config.toml'))).toBe(true)
    // …and did NOT also write the default location.
    expect(fs.existsSync(path.join(sandbox, '.codex', 'config.toml'))).toBe(false)
  })

  it('is idempotent — re-running converges instead of duplicating', async () => {
    await run([])
    const once = fs.readFileSync(path.join(sandbox, '.codex', 'config.toml'), 'utf-8')
    await run([])
    const twice = fs.readFileSync(path.join(sandbox, '.codex', 'config.toml'), 'utf-8')
    expect(twice).toBe(once)
    expect(twice.split('[mcp_servers.agentchat]')).toHaveLength(2) // exactly one block
  })

  it('preserves a user’s own config.toml content byte-for-byte', async () => {
    const cfg = path.join(sandbox, '.codex', 'config.toml')
    fs.writeFileSync(cfg, '[model]\nname = "o4"\n\n[mcp_servers.mine]\ncommand = "my-server"\n')
    await run([])
    const after = fs.readFileSync(cfg, 'utf-8')
    expect(after).toContain('[model]')
    expect(after).toContain('[mcp_servers.mine]')
    expect(after).toContain('[mcp_servers.agentchat]')
  })
})

describe('there is no way to address another agent', () => {
  it('--platform is not a recognised option at all', async () => {
    const out = await run(['status', '--platform', 'claude-code'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain("Unknown option '--platform'")
  })

  it('logout removes only this agent’s footprint', async () => {
    await run([])
    fs.writeFileSync(
      path.join(sandbox, '.codex', 'agentchat', 'credentials'),
      JSON.stringify({ api_key: 'ac_live_' + 'c'.repeat(40), handle: 'codex-agent' }),
    )
    const before = snapshot(claudeDir())

    const out = await run(['logout'])

    expect(out.code).toBe(0)
    // Claude Code's credentials and anchor survive untouched…
    expect(snapshot(claudeDir())).toEqual(before)
    expect(fs.existsSync(path.join(sandbox, '.claude', 'agentchat', 'credentials'))).toBe(true)
    // …while this agent really is signed out.
    expect(fs.existsSync(path.join(sandbox, '.codex', 'agentchat', 'credentials'))).toBe(false)
    expect(fs.readFileSync(path.join(sandbox, '.codex', 'config.toml'), 'utf-8')).not.toContain(
      '[mcp_servers.agentchat]',
    )
  })

  it('mentions the OTHER agent’s front door rather than offering to do it', async () => {
    const out = await run(['--help'])
    expect(out.stdout).toContain('agentchat-claude-code')
    expect(out.stdout.toLowerCase()).toContain('separate agentchat agent')
  })
})

describe('doctor', () => {
  it('reports wiring and the missing identity before registration', async () => {
    await run([])
    const out = await run(['doctor'])
    expect(out.stdout).toContain('PASS wiring')
    expect(out.stdout).toContain('FAIL credentials')
  })

  it('detects an anchor naming a different agent, and --fix repairs it', async () => {
    await run([])
    fs.writeFileSync(
      path.join(sandbox, '.codex', 'agentchat', 'credentials'),
      JSON.stringify({ api_key: 'ac_live_' + 'c'.repeat(40), handle: 'codex-agent' }),
    )
    // Exactly the corruption the old shared CLI produced.
    fs.writeFileSync(
      path.join(sandbox, '.codex', 'AGENTS.md'),
      '<!-- agentchat:start -->\nYou are **@claude-agent** on AgentChat.\n<!-- agentchat:end -->\n',
    )

    const seen = await run(['doctor'])
    expect(seen.stdout).toContain('says @claude-agent but this agent is @codex-agent')

    const fixed = await run(['doctor', '--fix'])
    expect(fixed.stdout).toContain('repaired → @codex-agent')
    const agents = fs.readFileSync(path.join(sandbox, '.codex', 'AGENTS.md'), 'utf-8')
    expect(agents).toContain('@codex-agent')
    expect(agents).not.toContain('@claude-agent')
  })
})

describe('every hint is a runnable command', () => {
  for (const argv of [[], ['--help'], ['status'], ['doctor'], ['logout']]) {
    it(`\`${argv.join(' ') || '(bare)'}\` renders no un-interpolated placeholder`, async () => {
      const out = await run(argv)
      expect(out.stdout + out.stderr).not.toContain('${')
    })
  }
})
