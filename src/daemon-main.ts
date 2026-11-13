import { parseArgs } from 'node:util'
import * as path from 'node:path'
import { hostedMcpUrl, resolveRunProfile } from '@agentchatme/agent-core'
import { runIntegration, type RunnerFactory } from '@agentchatme/agent-core/daemon'
import { CLIENT, codexHome, identityHome, resolveRunWorkdir, skillPath } from './host.js'
import { CodexRunner, runPointer } from './runner.js'

// ─── The integration daemon binary ──────────────────────────────────────────
//
// A SEPARATE bundle from the CLI: `ws` is CommonJS and reaches for `require`
// at runtime, and a service should run a script whose entire job is to serve.
//
// The host is a compile-time fact here exactly as it is in the CLI: this file
// imports Codex's runner and Codex's home, and cannot name another coding
// agent. The run prompt is the server's wake instruction, fetched for the
// `codex` runtime (`GET /v1/texts?runtime=codex`, tool names already spelled
// `mcp__agentchat__agentchat_inbox` for `[mcp_servers.agentchat]`;
// codex-rs/core/src/tools/handlers/mcp.rs: `mcp__` prefix, `__` delimiter),
// then one pointer to the skill — the one line only this package knows — in
// the profiles whose runs can open it (`runPointer`: an answer run has no file
// tool and no web). The skill file follows the manual the same texts announce
// (`manualPath`).
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
  const runner: RunnerFactory = {
    // The runner's own name (`CodexRunner.name`), for status before any identity is known.
    name: 'codex',
    create: (identity) => new CodexRunner({ codexHome: codexHome(), identityHome: identity.home, workdir, profile, pinMcpUrl: hostedMcpUrl(identity.apiBase) }),
  }

  return await runIntegration({
    home,
    workdir,
    profile,
    runner,
    client: CLIENT,
    manualPointer: runPointer(profile, skillPath()),
    // The skill follows the manual the served texts announce, on their cadence.
    manualPath: skillPath(),
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
