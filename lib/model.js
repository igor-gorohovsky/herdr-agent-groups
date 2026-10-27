"use strict";

const { GROUP_TOKEN } = require("./herdr");

/**
 * Join stored groups/assignments with the live agent list.
 *
 * Assignments are stored with both the agent name and the pane id. A live
 * agent name is the stronger identity (it follows the pane occupant), so it
 * wins; the pane id is the fallback for unnamed agents and restarted ones.
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

  const assigned = new Map(); // pane_id -> { group, agent, assignment }
  const stale = []; // assignment kept, agent gone
  const dropped = []; // assignment for a closed pane or deleted group

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

  // Reconcile the sidebar token for every live agent, not just grouped ones, so
  // that removed assignments leave no stale token behind.
  const plan = [];
  for (const agent of agents) {
    const desired = assigned.get(agent.pane_id)?.group.name ?? null;
    const current = agent.tokens && typeof agent.tokens[GROUP_TOKEN] === "string"
      ? agent.tokens[GROUP_TOKEN]
      : null;
    if (desired !== current) plan.push({ pane_id: agent.pane_id, value: desired, name: agent.name });
  }

  return { agents, assigned, stale, dropped, plan, groupById };
}

/** Rows for the manager UI: one header per group, then that group's agents. */
function buildRows(state, model) {
  const rows = [];
  const ungrouped = [];

  for (const agent of model.agents) {
    if (!model.assigned.has(agent.pane_id)) ungrouped.push(agent);
  }

  for (const group of state.groups) {
    const members = model.agents.filter(
      (agent) => model.assigned.get(agent.pane_id)?.group.id === group.id,
    );
    const staleMembers = model.stale.filter((entry) => entry.group.id === group.id);
    rows.push({
      kind: "header",
      group,
      count: members.length,
      staleCount: staleMembers.length,
    });
    for (const agent of members) rows.push({ kind: "agent", agent, group });
    for (const entry of staleMembers) rows.push({ kind: "stale", entry, group });
  }

  rows.push({ kind: "header", group: null, count: ungrouped.length, staleCount: 0 });
  for (const agent of ungrouped) rows.push({ kind: "agent", agent, group: null });

  return rows;
}

module.exports = { buildModel, buildRows };
