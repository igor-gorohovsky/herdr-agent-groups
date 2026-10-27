"use strict";

const { GROUP_TOKEN, LABEL_PREFIX, LABEL_SEPARATOR, SORT_TOKEN } = require("./herdr");

/**
 * Herdr's sidebar has no group headers: the Agent panel is a flat list, and
 * plugins cannot add rows to it. Grouping is therefore expressed with the two
 * things Herdr does support:
 *
 *   1. an ordering key per pane, so the agents of one group form one contiguous
 *      block (the agent view sorts on it), and
 *   2. the pane's display name, so the first row of a block announces the group
 *      name once, above its members.
 *
 * Nothing else in the sidebar layout changes: Herdr keeps its own rows, columns
 * and styling.
 */

function ordinal(id) {
  if (typeof id !== "string" || !id) return 0;
  const tail = id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id;
  const digits = tail.replace(/^[a-z]/i, "");
  const value = parseInt(digits, 36);
  return Number.isFinite(value) ? value : 0;
}

/** Zero padded so a string sort matches layout order: group, workspace, tab, pane. */
function sortKey(groupRank, agent) {
  const pad = (value, width) => String(value).padStart(width, "0");
  return [
    pad(groupRank, 2),
    pad(ordinal(agent.workspace_id), 4),
    pad(ordinal(agent.tab_id), 4),
    pad(ordinal(agent.pane_id), 4),
  ].join(".");
}

/** True when this display name is a heading this plugin wrote. */
function isOwnLabel(value) {
  return typeof value === "string" && value.startsWith(LABEL_PREFIX);
}

/** The agent part of a heading we wrote, or null when it is not ours. */
function stripOwnLabel(value) {
  if (!isOwnLabel(value)) return null;
  const body = value.slice(LABEL_PREFIX.length);
  const index = body.indexOf(LABEL_SEPARATOR);
  return index >= 0 ? body.slice(index + LABEL_SEPARATOR.length) : body;
}

function baseLabel(agent) {
  if (agent.name) return agent.name;
  const stripped = stripOwnLabel(agent.display_agent);
  if (stripped) return stripped;
  return agent.display_agent || agent.agent || agent.pane_id;
}

/**
 * Join stored groups/assignments with the live agent list.
 *
 * Assignments keep both the agent name and the pane id. A live agent name is
 * the stronger identity (it follows the pane occupant), so it wins; the pane id
 * is the fallback for unnamed and restarted agents.
 */
function buildModel(state, agents, panes) {
  const byName = new Map();
  const byPane = new Map();
  for (const agent of agents) {
    if (agent.name) byName.set(agent.name, agent);
    byPane.set(agent.pane_id, agent);
  }

  const livePaneIds = panes ? new Set(panes.map((pane) => pane.pane_id)) : null;
  const groupById = new Map(state.groups.map((group) => [group.id, group]));
  const groupRank = new Map(state.groups.map((group, index) => [group.id, index]));
  const ungroupedRank = state.groups.length + 1;

  const assigned = new Map();
  const stale = [];
  const dropped = [];

  for (const assignment of state.assignments) {
    const group = groupById.get(assignment.group_id);
    if (!group) {
      dropped.push(assignment);
      continue;
    }
    const agent =
      (assignment.agent_name && byName.get(assignment.agent_name)) ||
      byPane.get(assignment.pane_id) ||
      null;

    if (agent) {
      if (assigned.has(agent.pane_id)) continue; // duplicate; first one wins
      assigned.set(agent.pane_id, { group, agent, assignment });
      continue;
    }
    if (livePaneIds && !livePaneIds.has(assignment.pane_id)) dropped.push(assignment);
    else stale.push({ group, assignment });
  }

  const keys = new Map();
  for (const [paneId, entry] of assigned) {
    keys.set(paneId, sortKey(groupRank.get(entry.group.id) ?? ungroupedRank, entry.agent));
  }

  // The first row of each block is the one that carries the group name.
  const heads = new Set();
  const headByGroup = new Map();
  for (const [paneId, entry] of assigned) {
    const key = keys.get(paneId);
    const current = headByGroup.get(entry.group.id);
    if (!current || key < current.key) headByGroup.set(entry.group.id, { key, paneId });
  }
  for (const { paneId } of headByGroup.values()) heads.add(paneId);

  // Reconcile every live agent, not just grouped ones, so a removed assignment
  // never leaves a stale token or heading behind.
  const plan = [];
  for (const agent of agents) {
    const entry = assigned.get(agent.pane_id);
    const desiredGroup = entry ? entry.group.name : null;
    const desiredSort = entry ? keys.get(agent.pane_id) : null;

    const tokens = {};
    if ((agent.tokens?.[GROUP_TOKEN] ?? null) !== desiredGroup) tokens[GROUP_TOKEN] = desiredGroup;
    if ((agent.tokens?.[SORT_TOKEN] ?? null) !== desiredSort) tokens[SORT_TOKEN] = desiredSort;

    const currentLabel = agent.display_agent ?? null;
    let displayAgent;
    if (entry && heads.has(agent.pane_id)) {
      const label = LABEL_PREFIX + entry.group.name + LABEL_SEPARATOR + baseLabel(agent);
      if (currentLabel !== label) displayAgent = label;
    } else if (isOwnLabel(currentLabel)) {
      displayAgent = null; // ours, and this pane no longer heads a block
    }

    if (Object.keys(tokens).length || displayAgent !== undefined) {
      plan.push({
        pane_id: agent.pane_id,
        agent_label: agent.agent || null,
        tokens,
        display_agent: displayAgent,
      });
    }
  }

  return { agents, assigned, stale, dropped, plan, heads, keys, groupById };
}

/** Rows for the manager UI: one header per group, then that group's agents. */
function buildRows(state, model) {
  const rows = [];
  const ungrouped = model.agents.filter((agent) => !model.assigned.has(agent.pane_id));

  for (const group of state.groups) {
    const members = model.agents.filter(
      (agent) => model.assigned.get(agent.pane_id)?.group.id === group.id,
    );
    const staleMembers = model.stale.filter((entry) => entry.group.id === group.id);
    rows.push({ kind: "header", group, count: members.length, staleCount: staleMembers.length });
    for (const agent of members) {
      rows.push({ kind: "agent", agent, group, head: model.heads.has(agent.pane_id) });
    }
    for (const entry of staleMembers) rows.push({ kind: "stale", entry, group });
  }

  rows.push({ kind: "header", group: null, count: ungrouped.length, staleCount: 0 });
  for (const agent of ungrouped) rows.push({ kind: "agent", agent, group: null });

  return rows;
}

module.exports = { buildModel, buildRows, isOwnLabel, ordinal, sortKey, stripOwnLabel };
