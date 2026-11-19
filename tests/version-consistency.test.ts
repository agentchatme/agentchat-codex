import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── One version, stated in two places ──────────────────────────────────────
//
// package.json is what npm publishes; src/version.ts is what `--version`
// prints. Neither is generated from the other, and the publish workflow gates
// on the tag matching package.json — so a stale version.ts sails through and
// every user is told the wrong number.
//
// The number itself follows VERSIONING.md (minor +1 for rebuilt or added
// behaviour, patch +1 for fixes; set at the release step).

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

describe('every declared version agrees', () => {
  const pkg = (JSON.parse(read('package.json')) as { version: string }).version

  it('package.json has a version', () => {
    expect(pkg).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('src/version.ts matches package.json', () => {
    const m = read('src/version.ts').match(/VERSION\s*=\s*'([^']+)'/)
    expect(m?.[1]).toBe(pkg)
  })

  it('the built bundle reports it', () => {
    expect(read('dist/index.js')).toContain(pkg)
  })
})

// ─── A release runs on the engine its texts describe ────────────────────────
//
// The help, the README and `doctor` describe the `own` run profile (the
// default from the @agentchatme/agent-core release that added it). Pull
// requests may land on an older pinned engine — the tests that need `own` skip
// there — but a release may not: on a tag build (the publish workflow's gate
// job runs these tests for the tag), this fails until the pin is moved.
describe('the release gate on the engine pin', () => {
  it.runIf(process.env['GITHUB_REF_TYPE'] === 'tag')('a tagged release bundles an engine with the own profile', async () => {
    const engine = (await import('@agentchatme/agent-core')) as { RUN_PROFILES: readonly string[]; DEFAULT_RUN_PROFILE: string }
    expect(engine.RUN_PROFILES).toContain('own')
    expect(engine.DEFAULT_RUN_PROFILE).toBe('own')
  })
})
