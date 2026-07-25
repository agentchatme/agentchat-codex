import { defineConfig } from 'tsup'

// The engine is BUNDLED into this package rather than left as a runtime
// dependency: no second install step, no npx cold start, and no window in
// which the front door and the engine are different versions. `splitting:false`
// is load-bearing — a split bundle breaks the single-file bin.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  noExternal: ['@agentchatme/agent-core', 'zod'],
})
