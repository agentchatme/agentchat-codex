import * as fs from 'node:fs'
import * as path from 'node:path'

export interface FakeCodex {
  binDir: string
}

/**
 * Install a deterministic Codex CLI for integration tests.
 *
 * Installation only needs the public version command. Doctor additionally
 * uses the public app-server hooks/list request, so the fake models that
 * protocol instead of depending on a developer's real Codex installation,
 * authentication, or hook trust state.
 */
export function installFakeCodex(root: string, version = '0.146.0'): FakeCodex {
  const binDir = path.join(root, 'fake-bin')
  fs.mkdirSync(binDir, { recursive: true })

  const script = path.join(binDir, 'codex')
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      'const args = process.argv.slice(2)',
      `if (args[0] === '--version') { console.log(${JSON.stringify(`codex-cli ${version}`)}); process.exit(0) }`,
      "if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0) }",
      "if (args[0] === 'app-server') {",
      "  const readline = require('node:readline')",
      "  const home = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex')",
      "  const hooksPath = path.join(home, 'hooks.json')",
      "  const eventNames = { SessionStart: 'sessionStart', UserPromptSubmit: 'userPromptSubmit', Stop: 'stop', SessionEnd: 'sessionEnd' }",
      '  const listHooks = () => {',
      '    let doc = {}',
      "    try { doc = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) } catch {}",
      "    const events = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc.hooks || doc) : {}",
      '    const hooks = []',
      '    for (const [event, groups] of Object.entries(events)) {',
      '      if (!Array.isArray(groups)) continue',
      '      for (const group of groups) {',
      "        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue",
      '        for (const hook of group.hooks) {',
      "          if (!hook || typeof hook.command !== 'string') continue",
      "          hooks.push({ eventName: eventNames[event] || event, command: hook.command, sourcePath: hooksPath, enabled: true, trustStatus: 'untrusted', currentHash: 'sha256:fake-current' })",
      '        }',
      '      }',
      '    }',
      '    return { data: [{ hooks, warnings: [], errors: [] }] }',
      '  }',
      '  const rl = readline.createInterface({ input: process.stdin })',
      "  rl.on('line', (line) => {",
      '    let message',
      '    try { message = JSON.parse(line) } catch { return }',
      "    if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }))",
      "    else if (message.method === 'hooks/list') console.log(JSON.stringify({ id: message.id, result: listHooks() }))",
      '  })',
      '  return',
      '}',
      "console.error('unsupported fake codex command: ' + args.join(' '))",
      'process.exit(2)',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  // Windows resolves bare commands through PATHEXT rather than shebangs.
  fs.writeFileSync(
    path.join(binDir, 'codex.cmd'),
    '@echo off\r\nnode "%~dp0codex" %*\r\n',
  )

  return { binDir }
}
