"use strict";

const { GROUP_TOKEN, clearView, setView } = require("./herdr");

/**
 * Translate the stored view mode into one `agent.view.set` request.
 *
 *  off    - the plugin owns nothing; leave the sidebar alone
 *  groups - keep every agent, sort by group name (ungrouped last)
 *  group  - show only one group, newest state changes first
 */
function describe(state) {
  if (!state.view || state.view.mode === "off") return null;
  if (state.view.mode === "groups") {
    return {
      label: "groups",
      filter: null,
      sort: [
        { field: { token: GROUP_TOKEN }, order: "asc" },
        { field: "state_change_seq", order: "desc" },
      ],
    };
  }
  const group = state.groups.find((entry) => entry.id === state.view.group_id);
  if (!group) return null;
  return {
    label: group.name,
    filter: { op: "eq", field: { token: GROUP_TOKEN }, value: group.name },
    sort: [{ field: "state_change_seq", order: "desc" }],
  };
}

async function apply(state, { source, quiet = false } = {}) {
  const spec = describe(state);
  const result = spec
    ? await setView({ source, ...spec })
    : await clearView();
  if (!quiet) {
    if (result && result.active && spec) {
      process.stdout.write(`sidebar view: ${result.label || spec.label}\n`);
    } else if (result && !result.active) {
      process.stdout.write("sidebar view: off\n");
    }
  }
  return result;
}

function label(state) {
  if (!state.view || state.view.mode === "off") return "off";
  if (state.view.mode === "groups") return "grouped";
  const group = state.groups.find((entry) => entry.id === state.view.group_id);
  return group ? `only ${group.name}` : "off";
}

module.exports = { apply, describe, label };
