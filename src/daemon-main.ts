import { parseArgs } from 'node:util'
import * as path from 'node:path'
import { hostedMcpUrl, resolveRunProfile } from '@agentchatme/agent-core'
import { runIntegration, type RunnerFactory, type RunnerIdentity } from '@agentchatme/agent-core/daemon'
import { anchorFile, CLIENT, codexHome, identityHome, LABEL, resolveRunWorkdir, skillPath } from './host.js'
import { CodexRunner, runPointer } from './runner.js'

// ─── The integration daemon binary ──────────────────────────────────────────
//
// A SEPARATE bundle from the CLI: `ws` is CommonJS and reaches for `require`
// at runtime, and a service should run a script whose entire job is to serve.
//
// The host is a compile-time fact here exactly as it is in the CLI: this file
// imports Codex's runner and Codex's home, and cannot name another coding
// agent. A run's prompt is the server's text for that run — the prompt for
// one conversation (one run per conversation that owes a reply), the invite
// prompt, or from an older server the wake instruction for the whole tray —
// fetched for the `codex` runtime (`GET /v1/texts?runtime=codex`, tool names
// already spelled `mcp__agentchat__agentchat_inbox` for `[mcp_servers.agentchat]`;
// codex-rs/core/src/tools/handlers/mcp.rs: `mcp__` prefix, `__` delimiter),
// then one pointer to the skill — the one line only this package knows — in
// the profiles whose runs can open it (`runPointer`: an answer run has no file
// tool and no web), naming the manual's address as the texts in hand announce
// it. Two placements follow the same texts from then on: the skill file
// follows the manual they announce (`manualPath`: synced at daemon start and
// whenever the texts change, and retried while it is not the announced
// version), and this agent's identity block in `$CODEX_HOME/AGENTS.md` follows
// the served identity line (`anchorPath`: only this agent's own block, under
// the engine's rules; none is created, and one edited by hand or another
// agent's is left as it is). For Codex that block is the only way the
// identity line reaches a run:
// Codex loads AGENTS.md into every run, answer runs included, and the preset
// hands a run no identity line of its own.
//
// The runner is built per identity (a `RunnerFactory`), so every run pins
// `mcp_servers.agentchat.url` to the hosted server of the agent the daemon
// serves (`pinMcpUrl`): no other config layer Codex reads — a trusted
// project's `.codex/config.toml` among them — can point the agentchat server,
// and the key its bearer variable carries, anywhere else. A new sign-in builds
// a new runner.

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let values: { home?: string | undefined; workdir?: string | undefined }
  try {
    ;({ values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { home: { type: 'string' }, workdir: { type: 'string' } },
    }))
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    console.error('Usage: agentchat-daemon [--home <dir>] [--workdir <dir>]')
    return 1
  }

  const home = values.home !== undefined ? path.resolve(values.home) : identityHome()
  const workdir = values.workdir !== undefined ? path.resolve(values.workdir) : resolveRunWorkdir(home)
  const profile = resolveRunProfile()
  const factory = {
    // The runner's own name and label (`CodexRunner.name`, `.label`), for status before any identity is known.
    name: 'codex',
    label: LABEL,
    create: (identity: RunnerIdentity) => new CodexRunner({ codexHome: codexHome(), identityHome: identity.home, workdir, profile, pinMcpUrl: hostedMcpUrl(identity.apiBase) }),
  }
  // Assigned, not written in place: the pinned engine's RunnerFactory may not know `label` yet.
  const runner: RunnerFactory = factory

  return await runIntegration({
    home,
    workdir,
    profile,
    runner,
    client: CLIENT,
    manualPointer: runPointer(profile, skillPath()),
    // The skill follows the manual the served texts announce.
    manualPath: skillPath(),
    // This agent's identity block in AGENTS.md follows the served identity line.
    anchorPath: anchorFile(),
  })
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(String(err instanceof Error ? (err.stack ?? err.message) : err))
    process.exitCode = 1
  },
)
