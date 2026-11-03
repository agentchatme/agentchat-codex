#!/usr/bin/env bash
# Release smoke: pack the package, then prove the TARBALL (not the checkout)
# runs: the CLI prints its version, the doorbell daemon idles resident with no
# identity, and an npm-installed copy run through the node_modules/.bin shim
# installs, re-installs, reports status and uninstalls against a sandbox HOME
# with the package's own fake `codex` and the service in dry-run. Nothing touches
# a real Codex or a real launchd/systemd job.
#
# Run by publish.yml (its `tgz` output is what gets published) and by ci.yml
# on every PR, so it cannot go stale between releases.
set -euo pipefail
workspace="$PWD"
root="${SMOKE_ROOT:-${RUNNER_TEMP:-/tmp}/smoke}"
rm -rf "$root"
mkdir -p "$root/verify" "$root/npxlike"

# The actual package boundary, not files beside the checkout.
tgz="$(npm pack --ignore-scripts --pack-destination "$root/verify" | tail -1)"
echo "packed: $tgz"
tar xzf "$root/verify/$tgz" -C "$root/verify"
echo "--- tarball contents ---"
(cd "$root/verify/package" && find . -type f | sed 's|^\./|  |' | sort)
for file in dist/index.js dist/daemon-main.js; do
  test -f "$root/verify/package/$file" || { echo "::error::the tarball is missing $file"; exit 1; }
done

cd "$root/verify/package"
cli_out="$(node dist/index.js --version 2>&1 || true)"
echo "--- cli --version: $cli_out"
case "$cli_out" in
  *"Cannot find module"*|*"ERR_MODULE_NOT_FOUND"*|*"Dynamic require"*)
    echo "::error::the CLI is not self-contained"; exit 1 ;;
esac
expected="$(node -p "require('./package.json').version")"
[ "$cli_out" = "$expected" ] || { echo "::error::--version printed '$cli_out', expected '$expected'"; exit 1; }

# The doorbell daemon runs from the tarball with no identity and stays
# resident, waiting for a credential.
daemon_alive() { # <script> <log>: run it 6 s with a fresh identity home, report whether it idled
  local dhome; dhome="$(mktemp -d)"
  (node "$1" --home "$dhome" >"$2" 2>&1) &
  local dpid=$!
  sleep 6
  local alive=0
  kill -0 "$dpid" 2>/dev/null && alive=1
  kill "$dpid" 2>/dev/null || true
  wait "$dpid" 2>/dev/null || true
  echo "--- daemon ($1) ---"; cat "$2"
  [ "$alive" = "1" ] || { echo "::error::the daemon exited instead of idling"; exit 1; }
  grep -q "doorbell resident" "$2" || { echo "::error::the daemon did not come up as a resident doorbell"; exit 1; }
}
daemon_alive "$root/verify/package/dist/daemon-main.js" "$root/daemon-tarball.log"

# Install the tarball for real and drive it through the node_modules/.bin
# shim npx uses, against a sandbox HOME / CODEX_HOME and the package's own fake
# `codex` (generic runners have no Codex; nothing here touches a real one).
cd "$root/npxlike"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund "$root/verify/$tgz" >/dev/null 2>&1
mkdir -p home/.codex
(cd "$workspace" && node --experimental-strip-types -e "import('./tests/helpers/fake-codex.ts').then((m) => m.installFakeCodex(process.argv[1]))" "$root/fake" >/dev/null)
run_cli() {
  env -u AGENTCHAT_API_KEY -u AGENTCHAT_API_BASE \
    HOME="$root/npxlike/home" \
    CODEX_HOME="$root/npxlike/home/.codex" \
    PATH="$root/fake/fake-bin:$PATH" \
    AGENTCHAT_SERVICE_DRY_RUN=1 \
    ./node_modules/.bin/agentchat-codex "$@"
}
[ "$(run_cli --version)" = "$expected" ] || { echo "::error::the bin shim does not run the CLI"; exit 1; }

for pass in first idempotent; do
  out="$(run_cli 2>&1)"
  echo "--- $pass install ---"; echo "$out"
  echo "$out" | grep -q "AgentChat doorbell for Codex $expected"
  echo "$out" | grep -q "✓ skill: manual"
  echo "$out" | grep -q "✓ service: doorbell daemon registered"
  echo "$out" | grep -q 'Ask Codex: "Set up your AgentChat account."'
done
codex_dir="$root/npxlike/home/.codex"
head -3 "$codex_dir/skills/agentchat/SKILL.md" | grep -q "^name: agentchat" || { echo "::error::the manual is not placed as the agentchat skill"; exit 1; }
grep -q "AgentChat" "$codex_dir/AGENTS.md" || { echo "::error::AGENTS.md carries no AgentChat block"; exit 1; }

# The service runs a durable copy of the daemon; it must run on its own.
durable="$codex_dir/agentchat/bin/agentchat-daemon.mjs"
test -f "$durable" || { echo "::error::daemon install did not place the durable daemon copy"; exit 1; }
alone="$(mktemp -d)"; cp "$durable" "$alone/daemon.mjs"
daemon_alive "$alone/daemon.mjs" "$root/daemon-durable.log"

status_out="$(run_cli status 2>&1 || true)"
echo "--- status ---"; echo "$status_out"
echo "$status_out" | grep -q "No AgentChat identity for this Codex agent"

removed="$(run_cli uninstall 2>&1)"
echo "--- uninstall ---"; echo "$removed"
echo "$removed" | grep -q "Codex integration removed"
test ! -e "$codex_dir/skills/agentchat" || { echo "::error::uninstall left the agentchat skill"; exit 1; }
test ! -e "$durable" || { echo "::error::uninstall left the durable daemon copy"; exit 1; }
if grep -q "AgentChat" "$codex_dir/AGENTS.md" 2>/dev/null; then echo "::error::uninstall left the AGENTS.md block"; exit 1; fi

# `daemon install` through the bin shim with a stored identity: 0.0.12 shipped
# it broken for every user (the daemon was resolved relative to argv[1], the
# .bin symlink under npx, not the bundle).
rm -rf "$root/npxlike/home"
mkdir -p "$root/npxlike/home/.codex/agentchat"
printf '{"api_key":"ac_live_%040d","handle":"ci-probe"}' 0 > "$root/npxlike/home/.codex/agentchat/credentials"
shim_out="$(run_cli daemon install 2>&1 || true)"
echo "--- daemon install via node_modules/.bin ---"; echo "$shim_out"
case "$shim_out" in
  *"daemon bundle is missing"*) echo "::error::daemon install cannot find the daemon when run through a bin shim"; exit 1 ;;
esac
test -f "$root/npxlike/home/.codex/agentchat/bin/agentchat-daemon.mjs" || { echo "::error::daemon install did not place the durable daemon copy"; exit 1; }

cd "$workspace"
echo "tgz=$root/verify/$tgz" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "smoke: ok"
