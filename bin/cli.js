#!/usr/bin/env node
"use strict";

const path = require("node:path");

const herdr = require("../lib/herdr");
const store = require("../lib/store");
const { buildModel, buildRows } = require("../lib/model");
const { applyGroups } = require("../lib/sync");
const view = require("../lib/view");

const USAGE = `Agent Groups for Herdr

Usage: herdr-groups <command> [options]

Commands:
  tui [--assign]              Draw the interactive group manager (a pane)
  open [--entrypoint ID]      Open the manager as a Herdr plugin pane
  list [--json]               Print groups, members, and the sidebar view
  add <name>                  Create a group
  rename <group> <name>       Rename a group
  rm <group>                  Delete a group and clear its members
  assign <group> [--pane ID | --agent NAME]
                              Put one agent in a group
  unassign [--pane ID | --agent NAME]
                              Remove one agent from its group
  view <off|groups|group> [<group>]
                              Control the sidebar Agent view
  sync [--keep-stale]         Reapply tokens and the saved view
  snippet                     Print the config.toml sidebar snippet
  path                        Print the state file path
`;

function log(line = "") {
  process.stdout.write(line + "\n");
}

function warn(line) {
  process.stderr.write(line + "\n");
}

function fail(message) {
  warn(`error: ${message}`);
  process.exitCode = 1;
}

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function findLiveAgent(agents, identity) {
  if (identity.name) {
    return agents.find((agent) => agent.name === identity.name) || null;
  }
  if (identity.pane_id) {
    return agents.find((agent) => agent.pane_id === identity.pane_id) || null;
  }
  return null;
}

/** Work out which pane/agent a CLI or plugin-action invocation is about. */
function resolveIdentity(flags, agents) {
  const context = herdr.invocationContext();
  const explicitName = typeof flags.agent === "string" ? flags.agent : null;
  const explicitPane = typeof flags.pane === "string" ? flags.pane : null;

  if (explicitName) {
    const agent = findLiveAgent(agents, { name: explicitName });
    if (!agent) return { error: `no live agent named "${explicitName}"` };
    return { pane_id: agent.pane_id, agent_name: agent.name, workspace_id: agent.workspace_id };
  }

  const paneId = explicitPane || context.focused_pane_id;
  if (!paneId) {
    return { error: "no pane targeted: pass --pane <id>, --agent <name>, or run inside a Herdr pane" };
  }
  const agent = findLiveAgent(agents, { pane_id: paneId });
  return {
    pane_id: paneId,
    agent_name: agent ? agent.name : null,
    workspace_id: agent ? agent.workspace_id : null,
    agent,
  };
}

function identityForAssignment(identity) {
  return {
    pane_id: identity.pane_id,
    agent_name: identity.agent_name || null,
    workspace_id: identity.workspace_id || null,
  };
}

function requireAgents() {
  try {
    return herdr.listAgents();
  } catch (error) {
    warn(`error: cannot read agents from Herdr: ${error.message}`);
    warn("Is the Herdr server running?");
    process.exit(1);
  }
}

function statusGlyph(status) {
  switch (status) {
    case "working":
      return "\u25cf";
    case "blocked":
      return "\u25b2";
    case "done":
      return "\u2713";
    case "idle":
      return "\u25cb";
    default:
      return "?";
  }
}

function agentLabel(agent) {
  return agent.name || agent.display_agent || agent.agent || agent.pane_id;
}

/* ------------------------------------------------------------------ commands */

function cmdList(argv) {
  const { flags } = parseFlags(argv);
  const state = store.load();
  const agents = requireAgents();
  const panes = herdr.listPanes();
  const model = buildModel(state, agents, panes);
  const rows = buildRows(state, model);

  if (flags.json) {
    log(
      JSON.stringify(
        {
          view: state.view,
          view_label: view.label(state),
          groups: state.groups.map((group) => ({
            id: group.id,
            name: group.name,
            agents: rows
              .filter((row) => row.kind === "agent" && row.group && row.group.id === group.id)
              .map((row) => ({
                pane_id: row.agent.pane_id,
                workspace_id: row.agent.workspace_id,
                tab_id: row.agent.tab_id,
                name: row.agent.name,
                agent: row.agent.agent,
                status: row.agent.agent_status,
              })),
            stale: rows
              .filter((row) => row.kind === "stale" && row.group.id === group.id)
              .map((row) => ({ pane_id: row.entry.assignment.pane_id, name: row.entry.assignment.agent_name })),
          })),
          ungrouped: rows
            .filter((row) => row.kind === "agent" && !row.group)
            .map((row) => ({
              pane_id: row.agent.pane_id,
              workspace_id: row.agent.workspace_id,
              name: row.agent.name,
              agent: row.agent.agent,
              status: row.agent.agent_status,
            })),
        },
        null,
        2,
      ),
    );
    return;
  }

  log(`view: ${view.label(state)}`);
  if (!state.groups.length) log("(no groups yet \u2014 press n in the manager, or run: agent-groups add TODO)");

  for (const row of rows) {
    if (row.kind === "header") {
      const name = row.group ? row.group.name : "(ungrouped)";
      const extra = row.staleCount ? `, ${row.staleCount} stale` : "";
      log(`${name} (${row.count}${extra})`);
      continue;
    }
    if (row.kind === "agent") {
      const agent = row.agent;
      const label = agentLabel(agent);
      log(
        `  ${statusGlyph(agent.agent_status)} ${label.padEnd(18)} ${agent.pane_id.padEnd(8)} ${agent.agent_status ?? "unknown"}`,
      );
      continue;
    }
    if (row.kind === "stale") {
      const entry = row.entry.assignment;
      log(`  \u00b7 ${(entry.agent_name || entry.pane_id).padEnd(18)} ${entry.pane_id.padEnd(8)} gone`);
    }
  }
}

function cmdAdd(argv) {
  const { positional } = parseFlags(argv);
  const name = positional.join(" ").trim();
  if (!name) return fail("usage: agent-groups add <name>");
  const state = store.load();
  const { group, created } = store.addGroup(state, name);
  store.save(state);
  log(created ? `created group ${group.name} (${group.id})` : `group ${group.name} already exists`);
}

function cmdRename(argv) {
  const { positional } = parseFlags(argv);
  const [needle, ...rest] = positional;
  const name = rest.join(" ").trim();
  if (!needle || !name) return fail("usage: agent-groups rename <group> <new name>");
  const state = store.load();
  const { group, previous } = store.renameGroup(state, needle, name);
  store.save(state);
  log(`renamed ${previous} -> ${group.name}`);
  return cmdSync([]);
}

function cmdRemove(argv) {
  const { positional } = parseFlags(argv);
  const needle = positional.join(" ").trim();
  if (!needle) return fail("usage: agent-groups rm <group>");
  const state = store.load();
  const agents = requireAgents();
  const model = buildModel(state, agents, herdr.listPanes());
  const { group, removed } = store.removeGroup(state, needle);
  for (const entry of removed) {
    const live = model.assigned.get(entry.pane_id);
    if (live) {
      try {
        herdr.reportGroupToken(entry.pane_id, null);
      } catch (error) {
        warn(`warning: ${error.message}`);
      }
    }
  }
  store.save(state);
  log(`deleted group ${group.name} (cleared ${removed.length} assignment${removed.length === 1 ? "" : "s"})`);
  return applyView(state, { quiet: true });
}

function cmdAssign(argv) {
  const { positional, flags } = parseFlags(argv);
  const groupName = positional.join(" ").trim();
  if (!groupName) return fail("usage: agent-groups assign <group> [--pane ID | --agent NAME]");
  const state = store.load();
  const agents = requireAgents();
  const identity = resolveIdentity(flags, agents);
  if (identity.error) return fail(identity.error);

  const { group, entry } = store.assign(state, groupName, identityForAssignment(identity));
  store.save(state);

  try {
    herdr.reportGroupToken(entry.pane_id, group.name);
  } catch (error) {
    warn(`warning: could not write the sidebar token: ${error.message}`);
  }
  log(`${identity.agent_name || entry.pane_id} -> ${group.name}`);
}

function cmdUnassign(argv) {
  const { flags } = parseFlags(argv);
  const state = store.load();
  const agents = requireAgents();
  const identity = resolveIdentity(flags, agents);
  if (identity.error) return fail(identity.error);

  const removed = store.unassign(state, identityForAssignment(identity));
  store.save(state);
  if (!removed) {
    log(`${identity.agent_name || identity.pane_id} was not in a group`);
    return;
  }
  try {
    herdr.reportGroupToken(identity.pane_id, null);
  } catch (error) {
    warn(`warning: could not clear the sidebar token: ${error.message}`);
  }
  log(`${identity.agent_name || identity.pane_id} -> (ungrouped)`);
}

async function cmdView(argv) {
  const { positional } = parseFlags(argv);
  const mode = (positional[0] || "").toLowerCase();
  const state = store.load();

  if (mode === "off") {
    state.view = { mode: "off", group_id: null };
  } else if (mode === "groups" || mode === "grouped" || mode === "all") {
    state.view = { mode: "groups", group_id: null };
  } else if (mode === "group") {
    const group = store.findGroup(state, positional.slice(1).join(" "));
    if (!group) return fail(`unknown group: ${positional.slice(1).join(" ") || "(none given)"}`);
    state.view = { mode: "group", group_id: group.id };
  } else {
    return fail("usage: agent-groups view <off|groups|group> [<group>]");
  }

  store.save(state);
  await applyView(state, { quiet: false });
}

async function applyView(state, { quiet }) {
  try {
    await view.apply(state, { source: herdr.SOURCE, quiet });
  } catch (error) {
    if (!quiet) warn(`warning: could not update the sidebar view: ${error.message}`);
  }
}

async function cmdSync(argv) {
  const { flags } = parseFlags(argv);
  const quiet = Boolean(flags.quiet);
  const state = store.load();

  let summary;
  try {
    summary = applyGroups(state, {
      keepStale: Boolean(flags.keepStale),
      warn: quiet ? null : (line) => warn(line),
    });
  } catch (error) {
    if (!quiet) warn(`warning: cannot sync with Herdr: ${error.message}`);
    return;
  }

  await applyView(state, { quiet });

  if (!quiet) {
    log(
      `synced: ${summary.written} token${summary.written === 1 ? "" : "s"} written, ` +
        `${summary.healed} healed, ${summary.pruned} pruned` +
        (summary.failed ? `, ${summary.failed} failed` : ""),
    );
  }
}

function cmdSnippet() {
  log("# ~/.config/herdr/config.toml");
  log("# Show each agent's group in its sidebar row (run: herdr server reload-config).");
  log("[ui.sidebar.agents]");
  log("rows = [");
  log('  ["state_icon", "machine", "workspace", "tab"],');
  log('  ["agent", "$group"],');
  log("]");
}

function cmdPath() {
  log(store.statePath());
}

function cmdOpen(argv) {
  const { flags } = parseFlags(argv);
  const entrypoint = typeof flags.entrypoint === "string" ? flags.entrypoint : "manager";
  const args = ["plugin", "pane", "open", "--plugin", herdr.PLUGIN_ID, "--entrypoint", entrypoint];
  const res = herdr.run(args);
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || (res.error && res.error.message) || "").trim();
    return fail(`could not open the "${entrypoint}" pane: ${detail || "failed"}`);
  }
  return undefined;
}

async function cmdTui(argv) {
  const { flags } = parseFlags(argv);
  const { runTui } = require("./tui");
  await runTui({ assignMode: Boolean(flags.assign), frameOnly: Boolean(flags.frame) });
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || "help";
  const rest = argv.slice(1);

  switch (command) {
    case "tui":
      return cmdTui(rest);
    case "open":
      return cmdOpen(rest);
    case "list":
      return cmdList(rest);
    case "add":
      return cmdAdd(rest);
    case "rename":
      return cmdRename(rest);
    case "rm":
    case "remove":
      return cmdRemove(rest);
    case "assign":
      return cmdAssign(rest);
    case "unassign":
      return cmdUnassign(rest);
    case "view":
      return cmdView(rest);
    case "sync":
      return cmdSync(rest);
    case "snippet":
      return cmdSnippet();
    case "path":
      return cmdPath();
    case "help":
    case "--help":
    case "-h":
      return log(USAGE.trimEnd());
    default:
      warn(`unknown command: ${command}`);
      return fail(`try: ${path.basename(process.argv[1])} help`);
  }
}

main().catch((error) => {
  warn(`error: ${error.message}`);
  process.exit(1);
});
