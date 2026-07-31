import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { hookTrustFromList } from '../src/identity.js'
import {
  codexHooksPath,
  stableBundlePath,
} from '../src/wiring.js'

let home: string
let priorCodexHome: string | undefined

beforeEach(() => {
  priorCodexHome = process.env['CODEX_HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-hook-trust-'))
  process.env['CODEX_HOME'] = home
  fs.writeFileSync(codexHooksPath(), '{}\n')
})

afterEach(() => {
  if (priorCodexHome === undefined) delete process.env['CODEX_HOME']
  else process.env['CODEX_HOME'] = priorCodexHome
  fs.rmSync(home, { recursive: true, force: true })
})

function listed(status: string, enabled = true) {
  const command = (subcommand: string) =>
    `node "${stableBundlePath()}" hook ${subcommand}`
  return {
    data: [
      {
        hooks: [
          {
            eventName: 'session_start',
            command: command('session-start'),
            sourcePath: codexHooksPath(),
            enabled,
            trustStatus: status,
          },
          {
            eventName: 'user_prompt_submit',
            command: command('user-prompt'),
            sourcePath: codexHooksPath(),
            enabled,
            trustStatus: status,
          },
          {
            eventName: 'stop',
            command: command('stop'),
            sourcePath: codexHooksPath(),
            enabled,
            trustStatus: status,
          },
          {
            eventName: 'session_end',
            command: command('session-end'),
            sourcePath: codexHooksPath(),
            enabled,
            trustStatus: status,
          },
        ],
      },
    ],
  }
}

describe('Codex hook trust inspection', () => {
  it('accepts the app-server’s documented snake_case event names', () => {
    expect(hookTrustFromList(listed('trusted'))).toMatchObject({
      verdict: 'PASS',
      name: 'hook-trust',
    })
  })

  it('warns on changed or disabled definitions despite existing trust state', () => {
    expect(hookTrustFromList(listed('modified'))).toMatchObject({
      verdict: 'WARN',
      detail: expect.stringContaining('4 untrusted/changed'),
    })
    expect(hookTrustFromList(listed('trusted', false))).toMatchObject({
      verdict: 'WARN',
      detail: expect.stringContaining('4 disabled'),
    })
  })
})
