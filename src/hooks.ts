import { createHookRunners } from '@agentchatme/agent-core'
import { identityHome, hostCopy } from './host.js'
import { sessionStartOutput, stopOutput, printJson } from './dialect.js'

// ─── Session hooks ──────────────────────────────────────────────────────────
//
// agent-core decides WHAT the agent is told; ./dialect.ts decides HOW to say it
// to Codex. This file only joins the two. No host is selected at runtime —
// `identityHome()` is a constant of this package.
//
// The joining logic was duplicated per integration and the two copies were
// byte-identical, so it lives in the engine now. The invariant it carries is
// unchanged: exit code is ALWAYS 0. A failing hook degrades to "no AgentChat
// context this turn", never to a broken session.

export const { runSessionStart, runUserPrompt, runStop } = createHookRunners(
  () => ({ home: identityHome(), copy: hostCopy() }),
  { sessionStartOutput, stopOutput, printJson },
)
