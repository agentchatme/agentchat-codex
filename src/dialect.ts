// ─── Codex's hook JSON dialect ──────────────────────────────────────────────
//
// How THIS host wants hook output shaped. Every coding agent expects a
// different envelope, and a shared module choosing between them is one more
// place to pick the wrong one — so each integration owns its own.
//
// Verified against codex-cli (hooks GA 2026-05): same field shapes as Claude
// Code — SessionStart carries `hookSpecificOutput.additionalContext`, Stop
// continues with `{decision:"block", reason}`.
//
// A `null` from the engine means "no action": we print nothing and exit 0,
// which the host treats as a no-op.

export function sessionStartOutput(context: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }
}

export function userPromptOutput(context: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  }
}

export function stopOutput(reason: string): Record<string, unknown> {
  return { decision: 'block', reason }
}

export function printJson(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + '\n')
}
