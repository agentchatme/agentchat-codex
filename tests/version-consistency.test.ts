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
// AgentChat release versions move append-only: add one digit to the current
// patch component when a release is approved. The founder owns any
// minor/major transition.

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
