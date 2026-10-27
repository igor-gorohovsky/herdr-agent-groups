"use strict";

const { spawnSync } = require("node:child_process");
const { request } = require("./socket");

const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "agent-groups";

// One identity for every write this plugin makes: pane metadata tokens and the
// agent view. Herdr only lets `plugin:<id>` clear/replace its own view.
const SOURCE = `plugin:${PLUGIN_ID}`;
const GROUP_TOKEN = "group";
// Sort key the plugin computes per pane; the sidebar view sorts on it so agents
// in the same group become one contiguous block.
const SORT_TOKEN = "groupsort";
// Separator between the group name and the agent label on the block's first row.
const LABEL_PREFIX = "\u25b8 ";
const LABEL_SEPARATOR = " \u00b7 ";

function binPath() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function run(args, opts = {}) {
  const res = spawnSync(binPath(), args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 20000,
    env: process.env,
  });
  return {
    ok: res.status === 0 && !res.error,
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    error: res.error,
  };
}

function parseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty response");
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some commands may prefix output; fall back to the first JSON document.
    const start = trimmed.search(/[[{]/);
    if (start >= 0) return JSON.parse(trimmed.slice(start));
    throw new Error("response is not JSON");
  }
}

function runJson(args) {
  const res = run(args);
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || (res.error && res.error.message) || "command failed").trim();
    throw new Error(`herdr ${args.join(" ")}: ${detail}`);
  }
  const data = parseJson(res.stdout);
  // The CLI prints the raw socket envelope: {"id": "...", "result": {...}}.
  if (data && typeof data === "object" && data.result && typeof data.result === "object") {
    return data.result;
  }
  return data;
}

function listAgents() {
  const data = runJson(["agent", "list"]);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.agents)) return data.agents;
  return [];
}

function listPanes() {
  try {
    const data = runJson(["pane", "list"]);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.panes)) return data.panes;
  } catch {
    // Pane listing is only used for pruning; agents alone are enough.
  }
  return null;
}

/**
 * Patch one pane's display metadata.
 *
 * tokens: { name: string | null } - null clears a token.
 * displayAgent: string sets the visible name, null clears it, undefined leaves it.
 * agent: optional guard, so metadata dies with the agent it was written for.
 */
function reportMetadata(paneId, { tokens = {}, displayAgent, agent } = {}) {
  const args = ["pane", "report-metadata", paneId, "--source", SOURCE];
  if (agent) args.push("--agent", agent);
  if (displayAgent !== undefined) {
    if (displayAgent === null) args.push("--clear-display-agent");
    else args.push("--display-agent", displayAgent);
  }
  for (const [name, value] of Object.entries(tokens)) {
    if (value === null) args.push("--clear-token", name);
    else args.push("--token", `${name}=${value}`);
  }
  const res = run(args);
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || (res.error && res.error.message) || "").trim();
    throw new Error(`report-metadata ${paneId}: ${detail || "failed"}`);
  }
}

function focusAgent(target) {
  const res = run(["agent", "focus", target]);
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || (res.error && res.error.message) || "").trim();
    throw new Error(`agent focus ${target}: ${detail || "failed"}`);
  }
}

async function setView(view) {
  return request("agent.view.set", view);
}

async function clearView() {
  return request("agent.view.clear", { source: SOURCE });
}

/** Resolve the pane the invoking action was aimed at. */
function invocationContext() {
  let ctx = {};
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (raw) {
    try {
      ctx = JSON.parse(raw) || {};
    } catch {
      ctx = {};
    }
  }
  const paneId =
    ctx.focused_pane_id ||
    process.env.HERDR_ACTIVE_PANE_ID ||
    process.env.HERDR_PANE_ID ||
    null;
  return {
    ...ctx,
    focused_pane_id: paneId || null,
    workspace_id: ctx.workspace_id || process.env.HERDR_WORKSPACE_ID || null,
    tab_id: ctx.tab_id || process.env.HERDR_TAB_ID || null,
    caller_pane_id: process.env.HERDR_PANE_ID || null,
  };
}

module.exports = {
  GROUP_TOKEN,
  LABEL_PREFIX,
  LABEL_SEPARATOR,
  PLUGIN_ID,
  SORT_TOKEN,
  SOURCE,
  binPath,
  clearView,
  focusAgent,
  invocationContext,
  listAgents,
  listPanes,
  reportMetadata,
  run,
  runJson,
  setView,
};
