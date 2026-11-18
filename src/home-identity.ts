import { readCredentials, resolveIdentity, type ResolvedIdentity } from '@agentchatme/agent-core'

/**
 * The agent an identity home names: its `credentials`, and an exported
 * `AGENTCHAT_API_KEY` only when the home holds no key — never in place of
 * one. Found in testing: with another agent's key exported, `doctor --fix`
 * wrote THAT key for Codex, because the engine's `resolveIdentity` let the
 * environment win, and Codex's runs then acted as the other agent.
 * Everything here that places, checks or runs with a key reads it through
 * this, whatever the engine's default.
 */
export function homeIdentity(home: string): ResolvedIdentity | null {
  return resolveIdentity(home, { envKey: readCredentials(home) === null })
}
