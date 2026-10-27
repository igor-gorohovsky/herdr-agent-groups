#!/usr/bin/env bash
# Smoke test for the agent-groups plugin using a stateful fake herdr binary.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fails=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  ok   %s\n' "$label"
  else
    printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$label" "$expected" "$actual"
    fails=$((fails + 1))
  fi
}

# ------------------------------------------------------- stateful fake herdr
cat > "$tmp/herdr" <<'FAKE'
#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const file = process.env.FAKE_STATE;
const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
fs.appendFileSync(process.env.FAKE_LOG, args.join(" ") + "\n");

if (args[0] === "agent" && args[1] === "list") {
  console.log(JSON.stringify({ id: "x", result: { type: "agent_list", agents: fixture.agents } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "list") {
  console.log(JSON.stringify({ id: "x", result: { type: "pane_list", panes: fixture.panes } }));
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "focus") {
  console.log(JSON.stringify({ id: "x", result: { type: "agent_info", agent: {} } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "report-metadata") {
  const paneId = args[2];
  const agent = fixture.agents.find((entry) => entry.pane_id === paneId);
  if (!agent) {
    console.error("no such pane: " + paneId);
    process.exit(1);
  }
  agent.tokens = agent.tokens || {};
  for (let i = 3; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--token") {
      const [name, ...rest] = value.split("=");
      agent.tokens[name] = rest.join("=");
      i += 1;
    } else if (flag === "--clear-token") {
      agent.tokens[value] = null;
      i += 1;
    } else if (flag === "--display-agent") {
      agent.display_agent = value;
      i += 1;
    } else if (flag === "--clear-display-agent") {
      agent.display_agent = null;
    } else if (["--source", "--agent", "--applies-to-source", "--seq", "--ttl-ms"].includes(flag)) {
      i += 1;
    }
  }
  for (const key of Object.keys(agent.tokens)) {
    if (agent.tokens[key] === null) delete agent.tokens[key];
  }
  fs.writeFileSync(file, JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify({ id: "x", result: { type: "pane_info" } }));
  process.exit(0);
}
console.error("fake herdr: unsupported " + args.join(" "));
process.exit(1);
FAKE
chmod +x "$tmp/herdr"

fixture() {
  cat > "$tmp/state.json" <<'JSON'
{
  "agents": [
    {"terminal_id":"t1","pane_id":"w1:p3","workspace_id":"w1","tab_id":"w1:t1","name":"api","agent":"claude","agent_status":"working","focused":true,"revision":1,"tokens":{},"display_agent":null},
    {"terminal_id":"t2","pane_id":"w1:p10","workspace_id":"w1","tab_id":"w1:t1","name":"ui","agent":"pi","agent_status":"idle","focused":false,"revision":1,"tokens":{},"display_agent":null},
    {"terminal_id":"t3","pane_id":"w1:p4","workspace_id":"w1","tab_id":"w1:t2","name":"tests","agent":"codex","agent_status":"done","focused":false,"revision":1,"tokens":{},"display_agent":null},
    {"terminal_id":"t4","pane_id":"w2:p1","workspace_id":"w2","tab_id":"w2:t1","name":"docs","agent":"claude","agent_status":"blocked","focused":false,"revision":1,"tokens":{},"display_agent":null}
  ],
  "panes": [{"pane_id":"w1:p3"},{"pane_id":"w1:p10"},{"pane_id":"w1:p4"},{"pane_id":"w2:p1"}]
}
JSON
}
fixture

export FAKE_STATE="$tmp/state.json"
export FAKE_LOG="$tmp/calls.log"
export HERDR_BIN_PATH="$tmp/herdr"
export HERDR_PLUGIN_STATE_DIR="$tmp/plugin"
export HERDR_SOCKET_PATH="$tmp/no-server.sock"   # keep tests off the live session

cli() { (cd "$root" && node bin/cli.js "$@" 2>/dev/null); }
calls() { cat "$tmp/calls.log" 2>/dev/null || true; }
reset_calls() { : > "$tmp/calls.log"; }
state() { cat "$HERDR_PLUGIN_STATE_DIR/groups.json"; }
tokens() { jq -r --arg pane "$1" '.agents[] | select(.pane_id==$pane) | .tokens.group // "none"' "$tmp/state.json"; }
label_of() { jq -r --arg pane "$1" '.agents[] | select(.pane_id==$pane) | .display_agent // "none"' "$tmp/state.json"; }

echo "groups"
cli add "TODO" >/dev/null
cli add "In review" >/dev/null
check "two groups stored" "2" "$(state | jq '.groups | length')"

echo "assign"
cli assign TODO --pane w1:p3 >/dev/null
cli assign "in review" --agent tests >/dev/null
cli assign TODO --pane w1:p10 >/dev/null
check "three assignments" "3" "$(state | jq '.assignments | length')"
check "agent name kept" "api" "$(state | jq -r '.assignments[0].agent_name')"
check "two TODO members" "2" "$(cli list --json | jq '[.groups[] | select(.name=="TODO") | .agents[]] | length')"
check "token on the pane" "TODO" "$(tokens w1:p3)"

echo "blocks and headings"
fixture            # wipe pane metadata, keep assignments
reset_calls
cli sync >/dev/null
check "head row carries the group name" "▸ TODO · api" "$(label_of w1:p3)"
check "second member has no heading" "none" "$(label_of w1:p10)"
check "other group headed by its own first row" "▸ In review · tests" "$(label_of w1:p4)"
check "ungrouped agent untouched" "0" "$(calls | grep -c 'w2:p1')"
check "head label passed to herdr" "1" "$(calls | grep -c -- '--display-agent ▸ TODO · api')"
check "sort key written" "1" "$(calls | grep -c 'groupsort=00.0001.0001.0003')"
check "member sorts after head" "1" "$(calls | grep -c 'groupsort=00.0001.0001.0036')"

echo "order follows layout, not string order"
order="$(cd "$root" && node -e '
const { sortKey } = require("./lib/model");
const a = { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3" };
const b = { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p10" };
process.stdout.write(sortKey(0, a) < sortKey(0, b) ? "p3-before-p10" : "wrong");
')"
check "natural pane ordering" "p3-before-p10" "$order"
check "idempotent: nothing to rewrite" "0" "$(reset_calls; cli sync >/dev/null; calls | grep -c 'report-metadata')"

echo "heal"
jq '.agents |= map(if .pane_id == "w1:p4" then .pane_id = "w1:p9" else . end)
  | .panes = [{"pane_id":"w1:p3"},{"pane_id":"w1:p10"},{"pane_id":"w1:p9"}]' \
  "$tmp/state.json" > "$tmp/state2.json" && mv "$tmp/state2.json" "$tmp/state.json"
reset_calls
cli sync >/dev/null
check "assignment follows the agent" "w1:p9" "$(state | jq -r '.assignments[] | select(.agent_name=="tests") | .pane_id')"
check "metadata written on the new pane" "In review" "$(tokens w1:p9)"

echo "prune"
jq '.agents |= map(select(.pane_id != "w1:p3")) | .panes |= map(select(.pane_id != "w1:p3"))' \
  "$tmp/state.json" > "$tmp/state2.json" && mv "$tmp/state2.json" "$tmp/state.json"
cli sync --quiet
check "closed pane pruned" "2" "$(state | jq '.assignments | length')"

echo "rename"
cli rename TODO "Doing" >/dev/null
check "rename rewrites the token" "Doing" "$(tokens w1:p10)"
check "rename rewrites the heading" "▸ Doing · ui" "$(label_of w1:p10)"

echo "unassign"
cli unassign --pane w1:p10 >/dev/null
check "unassign clears the token" "none" "$(tokens w1:p10)"
check "unassign clears the heading" "none" "$(label_of w1:p10)"

echo "remove group"
cli rm "in review" >/dev/null
check "group removed" "1" "$(state | jq '.groups | length')"
check "member token cleared" "none" "$(tokens w1:p9)"
check "member heading cleared" "none" "$(label_of w1:p9)"

echo "sidebar view"
check "grouped by default" "grouped" "$(cli list | head -1 | sed 's/view: //')"
cli view off >/dev/null
check "view off is remembered" "off" "$(cli list | head -1 | sed 's/view: //')"
cli view grouped >/dev/null

echo "manager frame"
frame="$(COLUMNS=80 LINES=20 cli tui --frame)"
check "frame shows the group" "1" "$(printf '%s' "$frame" | grep -c 'Doing')"
check "frame shows the help line" "1" "$(printf '%s' "$frame" | grep -c 'q close')"

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
