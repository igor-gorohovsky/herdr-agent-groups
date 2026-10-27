#!/usr/bin/env bash
# Smoke test for the agent-groups plugin using a fake herdr binary.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fails=0
check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  ok   %s\n' "$label"
  else
    printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$label" "$expected" "$actual"
    fails=$((fails + 1))
  fi
}

# ---------------------------------------------------------------- fake herdr
cat > "$tmp/herdr" <<'FAKE'
#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
if (process.env.FAKE_LOG) {
  fs.appendFileSync(process.env.FAKE_LOG, args.join(" ") + "\n");
}
if (args[0] === "agent" && args[1] === "list") {
  console.log(JSON.stringify({ id: "x", result: { type: "agent_list", agents: fixture.agents } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "list") {
  console.log(JSON.stringify({ id: "x", result: { type: "pane_list", panes: fixture.panes } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "report-metadata") {
  console.log(JSON.stringify({ id: "x", result: { type: "pane_info" } }));
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "focus") {
  console.log(JSON.stringify({ id: "x", result: { type: "agent_info", agent: {} } }));
  process.exit(0);
}
console.error("fake herdr: unsupported " + args.join(" "));
process.exit(1);
FAKE
chmod +x "$tmp/herdr"

cat > "$tmp/state.json" <<'JSON'
{
  "agents": [
    {"terminal_id":"t1","pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","name":"api","agent":"claude","agent_status":"working","focused":true,"revision":1,"tokens":{}},
    {"terminal_id":"t2","pane_id":"w1:p2","workspace_id":"w1","tab_id":"w1:t1","name":null,"agent":"pi","agent_status":"idle","focused":false,"revision":1,"tokens":{"group":"STALE"}},
    {"terminal_id":"t3","pane_id":"w1:p3","workspace_id":"w1","tab_id":"w1:t2","name":"tests","agent":"codex","agent_status":"done","focused":false,"revision":1,"tokens":{}},
    {"terminal_id":"t4","pane_id":"w2:p1","workspace_id":"w2","tab_id":"w2:t1","name":"docs","agent":"claude","agent_status":"blocked","focused":false,"revision":1,"tokens":{}}
  ],
  "panes": [{"pane_id":"w1:p1"},{"pane_id":"w1:p2"},{"pane_id":"w1:p3"},{"pane_id":"w2:p1"}]
}
JSON

export FAKE_STATE="$tmp/state.json"
export FAKE_LOG="$tmp/calls.log"
export HERDR_BIN_PATH="$tmp/herdr"
export HERDR_PLUGIN_STATE_DIR="$tmp/plugin"

cli() { (cd "$root" && node bin/cli.js "$@"); }
tokens() { grep -h 'report-metadata' "$tmp/calls.log" 2>/dev/null || true; }
state() { cat "$HERDR_PLUGIN_STATE_DIR/groups.json"; }

echo "groups"
cli add "TODO" >/dev/null
cli add "In review" >/dev/null
check "two groups stored" "2" "$(state | jq '.groups | length')"

echo "assign"
cli assign TODO --pane w1:p1 >/dev/null
cli assign "in review" --agent tests >/dev/null
cli assign TODO --pane w1:p2 >/dev/null
check "three assignments" "3" "$(state | jq '.assignments | length')"
check "agent name kept" "api" "$(state | jq -r '.assignments[0].agent_name')"
check "two todo members" "2" "$(cli list --json | jq '[.groups[] | select(.name=="TODO") | .agents[]] | length')"
check "token written on assign"   "pane report-metadata w1:p1 --source plugin:agent-groups --token group=TODO"   "$(tokens | head -1)"

echo "sync"
: > "$tmp/calls.log"
cli sync >/dev/null
check "stale token cleared then rewritten" "pane report-metadata w1:p2 --source plugin:agent-groups --token group=TODO"   "$(tokens | grep 'w1:p2' | head -1)"
check "no call for untouched agent" "0" "$(tokens | grep -c 'w2:p1' || true)"

echo "heal"
jq '.agents |= map(if .pane_id == "w1:p3" then .pane_id = "w1:p9" else . end)
  | .panes = [{"pane_id":"w1:p1"},{"pane_id":"w1:p2"},{"pane_id":"w1:p9"}]' \
  "$tmp/state.json" > "$tmp/state2.json" && mv "$tmp/state2.json" "$tmp/state.json"
: > "$tmp/calls.log"
cli sync >/dev/null
check "assignment follows the agent" "w1:p9" "$(state | jq -r '.assignments[] | select(.agent_name=="tests") | .pane_id')"
check "token written on the new pane" "1" "$(tokens | grep -c 'report-metadata w1:p9.*group=In review')"

echo "prune"
jq '.agents |= map(select(.pane_id != "w1:p1")) | .panes |= map(select(.pane_id != "w1:p1"))' \
  "$tmp/state.json" > "$tmp/state2.json" && mv "$tmp/state2.json" "$tmp/state.json"
cli sync --quiet
check "closed pane pruned" "2" "$(state | jq '.assignments | length')"

echo "rename and remove"
cli rename TODO "To do" >/dev/null
check "renamed token rewritten" "1" "$(tokens | grep -c 'group=To do')"
cli rm "in review" >/dev/null
check "group removed" "1" "$(state | jq '.groups | length')"
check "member removed" "1" "$(state | jq '.assignments | length')"

echo "manager frame"
frame="$(COLUMNS=80 LINES=20 cli tui --frame)"
check "frame shows the group" "1" "$(printf '%s' "$frame" | grep -c 'To do')"
check "frame shows the help line" "1" "$(printf '%s' "$frame" | grep -c 'q close')"

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
