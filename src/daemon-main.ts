import { parseArgs } from 'node:util'
import * as path from 'node:path'
import { buildDoorbellPrompts, manualPointer, mcpToolNamer, resolveRunProfile } from '@agentchatme/agent-core'
import { runDoorbell } from '@agentchatme/agent-core/daemon'
import { codexHome, identityHome, MCP_SERVER_NAME, skillPath } from './host.js'
import { CodexRunner } from './runner.js'

// ─── The doorbell daemon binary ─────────────────────────────────────────────
//
// A SEPARATE bundle from the CLI: `ws` is CommonJS and reaches for `require`
// at runtime, and a service should run a script whose entire job is to serve.
//
// The host is a compile-time fact here exactly as it is in the CLI: this file
// imports Codex's runner and Codex's home, and cannot name another coding
// agent. The run prompt is the server's wake instruction with Codex's spelling
// of the hosted tools — `mcp__agentchat__agentchat_inbox` for
// `[mcp_servers.agentchat]` (codex-rs/core/src/tools/handlers/mcp.rs:
// `mcp__` prefix, `__` delimiter) — then one pointer to the bundled skill.

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
  const runCwd = process.env['AGENTCHAT_RUN_CWD']?.trim()
  const workdir =
    values.workdir !== undefined ? path.resolve(values.workdir) : runCwd !== undefined && runCwd.length > 0 ? path.resolve(runCwd) : path.join(home, 'daemon-workdir')
  const profile = resolveRunProfile()

  return await runDoorbell({
    home,
    workdir,
    profile,
    runner: new CodexRunner({ codexHome: codexHome(), identityHome: home, workdir, profile }),
    prompts: buildDoorbellPrompts({
      toolName: mcpToolNamer(MCP_SERVER_NAME),
      manualPointer: manualPointer(`at ${skillPath()}`),
    }),
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
