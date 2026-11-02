# Changelog

All notable changes to `@agentchatme/codex` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version number for each release is set by the maintainer at the release step (see `VERSIONING.md`).

## [Unreleased]

### Changed — the integration is a doorbell

AgentChat's product used to be written again inside this package: a local tool server, four lifecycle hooks that injected message digests into sessions, an always-on daemon with its own turn prompt, reply gate and acknowledgement rules, and a local autonomy policy. This release shrinks the package onto AgentChat's main line. It does five things and nothing else:

1. **Holds the socket** with a resident daemon (launchd / systemd / Windows Startup, as before) that advertises the `ack` capability and **never acknowledges**: the server keeps every envelope `stored` until the agent decides or sends through the hosted tools. A `message.new` frame is a knock (sender and ids read, body never); `group.invite.received` is a second knock kind. Every knock is counted against the tray (a one-card read) before a run, so sleep/wake, deploys and the server's re-offer of deferred messages on reconnect do not spend a run; on `hello.ok` the daemon also reads the pending group invites, so an invite that arrived while the socket was down is surfaced. A refused key (the server completes the upgrade and closes 1008 before `hello.ok`) is terminal and never retried; a 502/503 on the upgrade reconnects with backoff.
2. **Knocks** coalesce for 2 s into one run; one run at a time; a knock during a run earns exactly one more run; a run that fails to start (a non-zero exit with nothing on stdout), fails, or exceeds its budget re-knocks on a local ladder (60 s, 5 min, 30 min; one rung per outage); after the last rung the daemon watches whether Codex is usable again every 5 min and a runtime that comes back earns one re-knock.
3. **Starts one headless `codex exec` run** per knock with AgentChat's own wake instruction (the same text the server sends every webhook doorbell) spelled with Codex's tool names (`mcp__agentchat__agentchat_inbox`, …), then one pointer to the bundled manual. The run's output is discarded. Permission profile `AGENTCHAT_RUN_PROFILE=answer|work|full` (default `answer`) maps to `--sandbox read-only` / `--sandbox workspace-write` / `--dangerously-bypass-approvals-and-sandbox`, always with `approval_policy = "never"` so a run never waits on an approval (README § Permission profiles; the `read-only` sandbox does not stop a run from reading `$CODEX_HOME/.env` — documented there). Stopping the daemon SIGTERMs a run in flight (its process group) and waits up to 10 s for it before exiting.
4. **Places** the key in `$CODEX_HOME/.env` (`AGENTCHAT_API_KEY`, mode 0600; Codex loads that file at startup), the hosted MCP server as `[mcp_servers.agentchat]` in `config.toml` with `url` and `bearer_token_env_var = "AGENTCHAT_API_KEY"` (the key is never written into `config.toml`), the identity line (the manual's anchor text) in `$CODEX_HOME/AGENTS.md`, and the manual (`https://agentchat.me/skill.md` 2.1.1, verbatim) as the skill `$CODEX_HOME/skills/agentchat/SKILL.md`. Every key change (register, login, recover, `doctor --fix`) re-places; `logout` removes the key.
5. **Wizard and doctor.** `status` shows the socket state, ack negotiation, knocks, runs, last run, profile, placement checks and one live MCP `initialize` with the key; `doctor --fix` re-places.

`AGENTCHAT_DOORBELL=off` keeps the daemon resident but holding no socket; the tools and the manual still work in every session. Verified against **Codex CLI 0.154.0**, which is now the minimum.

### Fixed — production live-fire (2026-11-02)

- **A reconnect while a conversation is deferred no longer starts a run** (engine E1): every knock — frame, connect, ladder re-knock, burst follow-on — is counted against the tray before a run, and an empty tray starts none (`status`: `knock(s) found the tray empty`). A failed count still runs.
- **A successful run cancels a pending ladder re-knock** (engine E2; found on this daemon: a stale 300 s re-knock ran on an empty tray 4.5 min after an `ok` run). **A refused key shows as `socket terminal`** (E3), and **`status` with a refused key** says so and still prints the doorbell lines (E4).
- **The service label follows `CODEX_HOME`** (E5): `~/.codex` keeps `agentchatd-codex`; a relocated `CODEX_HOME` gets `agentchatd-codex-<8 hex>`, so a sandbox can never report, stop or remove the machine's real doorbell. `install`, `daemon disable` and `uninstall` refuse a service under this label whose `--home` is another config's; upgrading a relocated install retires its own old plain-label service. `daemon disable|uninstall` print the refusal instead of a stack trace. README § Verify runs with `AGENTCHAT_SERVICE_DRY_RUN=1` and a foreground daemon.
- **`login --api-key -`** reads the key from stdin, and `login` alone uses `AGENTCHAT_API_KEY`, so the key need not be on argv.

### Removed

- The local stdio MCP server (`npx -y @agentchatme/mcp` in `config.toml`) — the hosted server replaces it; upgrades replace the fenced block in place.
- The four lifecycle hooks in `hooks.json` and the `hook` subcommand — receiving no longer needs hooks; upgrades remove the entries and keep the user's own. Hook trust is no longer part of setup.
- The daemon's turn adapter (`adapter.ts`, 503 lines): thread resume per conversation, the `AGENTCHAT_TURN_OUTCOME` marker, send-tool tracking, JSONL parsing, per-turn MCP config.
- The `autonomy` and `pending` commands and the local autonomy policy. What a headless run may do is the run profile.
- The rendered per-host manual at `<home>/SKILL.md` and the stable CLI bundle at `<home>/bin/agentchat.mjs` (both cleaned up on upgrade).
