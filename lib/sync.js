"use strict";

const herdr = require("./herdr");
const store = require("./store");
const { buildModel } = require("./model");

/**
 * Push the stored groups into Herdr as pane metadata, heal the stored
 * identities against live agents, and prune assignments for closed panes.
 *
 * Herdr keeps tokens, display names, and agent views in server memory, so this
 * runs again from the plugin startup hook, from pane events, and after every
 * edit in the manager.
 */
function applyGroups(state, { keepStale = false, warn, persist = true } = {}) {
  const agents = herdr.listAgents();
  const model = buildModel(state, agents, herdr.listPanes());

  let written = 0;
  let failed = 0;
  for (const step of model.plan) {
    try {
      herdr.reportMetadata(step.pane_id, {
        agent: step.agent_label,
        tokens: step.tokens,
        displayAgent: step.display_agent,
      });
      written += 1;
    } catch (error) {
      failed += 1;
      if (warn) warn(`warning: ${error.message}`);
    }
  }

  let healed = 0;
  for (const entry of model.assigned.values()) {
    const assignment = entry.assignment;
    const nextName = entry.agent.name || null;
    const nextWorkspace = entry.agent.workspace_id || null;
    if (
      assignment.pane_id !== entry.agent.pane_id ||
      (assignment.agent_name || null) !== nextName ||
      (assignment.workspace_id || null) !== nextWorkspace
    ) {
      assignment.pane_id = entry.agent.pane_id;
      assignment.agent_name = nextName;
      assignment.workspace_id = nextWorkspace;
      assignment.updated_at = Date.now();
      healed += 1;
    }
  }

  const dropped = new Set(model.dropped);
  if (!keepStale && dropped.size) {
    state.assignments = state.assignments.filter((entry) => !dropped.has(entry));
  }
  if (persist) store.save(state);

  return {
    written,
    failed,
    healed,
    pruned: keepStale ? 0 : dropped.size,
    stale: model.stale.length,
  };
}

module.exports = { applyGroups };
