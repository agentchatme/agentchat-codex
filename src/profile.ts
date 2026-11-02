import type { RunProfile } from '@agentchatme/agent-core'

// ─── Run profiles → codex exec flags ────────────────────────────────────────
//
// What a headless run may do is the operator's decision (`AGENTCHAT_RUN_PROFILE`),
// mapped here to Codex's real flags. Verified against `codex exec --help`
// (codex-cli 0.154.0) and the openai/codex sources:
//
//   -s, --sandbox read-only|workspace-write|danger-full-access
//                                   the sandbox policy for model-generated commands
//   --dangerously-bypass-approvals-and-sandbox
//                                   skip all confirmation prompts and run unsandboxed
//   -c approval_policy="never"      `codex exec` already defaults to `never` in
//                                   headless mode (codex-rs/exec/src/lib.rs) — passed
//                                   explicitly so a run can never wait on an approval,
//                                   whatever a profile or requirements file says.
//   --json                          events as JSONL on stdout (discarded by the runner;
//                                   the first event is how "started" is told from
//                                   "never got going")
//   --skip-git-repo-check           the run's working directory is not a repository
//   --ephemeral                     no session files on disk for a doorbell run
//   -C <dir>                        the working root
//
// The hosted AgentChat tools reach the run through `[mcp_servers.agentchat]` in
// `config.toml` (bearer token from `AGENTCHAT_API_KEY`), with
// `default_tools_approval_mode = "approve"` so they never prompt. Web search
// follows the user's own `web_search` setting.

/** `--ephemeral`, `--sandbox`, `-C`, `--json` all exist on this version; older builds were not checked. */
export const MIN_CODEX_VERSION = '0.154.0'

export function codexProfileArgs(profile: RunProfile): string[] {
  switch (profile) {
    case 'answer':
      return ['--sandbox', 'read-only', '-c', 'approval_policy="never"']
    case 'work':
      return ['--sandbox', 'workspace-write', '-c', 'approval_policy="never"']
    case 'full':
      return ['--dangerously-bypass-approvals-and-sandbox']
  }
}

/**
 * The full argument list for one headless run. The prompt is the positional
 * argument and stdin is closed at once: `codex exec` reads stdin when it is
 * piped, and hangs waiting for EOF when it is left open.
 */
export function codexRunArgs(profile: RunProfile, options: { workdir: string; prompt: string }): string[] {
  return ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', options.workdir, ...codexProfileArgs(profile), options.prompt]
}
