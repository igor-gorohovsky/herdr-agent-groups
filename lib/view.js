"use strict";

const { GROUP_TOKEN, SORT_TOKEN, clearView, setView } = require("./herdr");

/**
 * The plugin's whole sidebar effect is one agent view:
 *
 *   grouped  sort by the plugin's per-pane key, so agents of a group sit
 *            together; Herdr keeps its own row layout and default columns
 *   group    the same, filtered to one group
 *   off      hand the Agent panel back to Herdr
 *
 * Sorting is the only lever: Herdr has no group headers, and the group name
 * itself is carried in the pane display name for the first row of each block.
 */
function describe(state) {
  if (!state.view || state.view.mode === "off") return null;

  const group =
    state.view.mode === "group"
      ? state.groups.find((entry) => entry.id === state.view.group_id)
      : null;
  if (state.view.mode === "group" && !group) return null;

  const sort = [{ field: { token: SORT_TOKEN }, order: "asc" }];
  return group
    ? {
        label: group.name,
        filter: { op: "eq", field: { token: GROUP_TOKEN }, value: group.name },
        sort,
      }
    : { label: "grouped", filter: null, sort };
}

async function apply(state, { source, quiet = false } = {}) {
  const spec = describe(state);
  const result = spec ? await setView({ source, ...spec }) : await clearView();
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
  if (state.view.mode === "group") {
    const group = state.groups.find((entry) => entry.id === state.view.group_id);
    return group ? `only ${group.name}` : "off";
  }
  return "grouped";
}

module.exports = { apply, describe, label };
