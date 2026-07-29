import { defineConfig } from 'tsup'

// Two self-contained ESM files, built from one config so they can never drift
// in target or inlining:
//
//   dist/index.js        the CLI + hooks — this package's `bin`.
//   dist/daemon-main.js  the always-on daemon, copied to a durable path at
//                        `daemon install` and run by the service unit.
//
// The engine is BUNDLED into both rather than left as a runtime dependency: no
// second core install/resolution step and no window in which the front door and
// the engine are different versions. `splitting:false` plus a total
// `noExternal` is what keeps each file standalone — it runs straight out of an
// npx cache with no node_modules beside it, so one external import is a hard
// crash at startup for every user.
//
// The `createRequire` line matters only to the daemon: `ws` is CommonJS and
// reaches for `require` at runtime, which plain ESM has no binding for ("Dynamic
// require of events is not supported"). Defining it from `import.meta.url`
// satisfies that. The CLI does not import `ws`, so its bundle just carries an
// unused binding.
const BANNER = [
  '#!/usr/bin/env node',
  'import{createRequire as __acCreateRequire}from"node:module";',
  'const require=__acCreateRequire(import.meta.url);',
].join('\n')

export default defineConfig({
  entry: ['src/index.ts', 'src/daemon-main.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node20',
  // Subpath builtins (readline/promises) are only recognised as builtins when
  // the platform is explicit; without it the engine's inlined CLI prompts fail
  // to resolve and the whole bundle fails to build.
  platform: 'node',
  banner: { js: BANNER },
  noExternal: ['@agentchatme/agent-core', 'agentchatme', 'zod', 'ws'],
})
