"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION = 1;

function stateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) return process.env.HERDR_PLUGIN_STATE_DIR;
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "herdr", "agent-groups");
}

function statePath() {
  return path.join(stateDir(), "groups.json");
}

function emptyState() {
  return { version: VERSION, groups: [], assignments: [], view: { mode: "grouped", group_id: null } };
}

function normalize(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== "object") return state;

  if (Array.isArray(raw.groups)) {
    const seen = new Set();
    for (const group of raw.groups) {
      if (!group || typeof group !== "object") continue;
      const name = String(group.name ?? "").trim();
      if (!name) continue;
      let id = String(group.id ?? "").trim() || slugify(name);
      while (seen.has(id)) id = `${id}-${seen.size + 1}`;
      seen.add(id);
      state.groups.push({ id, name, created_at: Number(group.created_at) || Date.now() });
    }
  }

  if (Array.isArray(raw.assignments)) {
    for (const entry of raw.assignments) {
      if (!entry || typeof entry !== "object") continue;
      const groupId = String(entry.group_id ?? "");
      const paneId = String(entry.pane_id ?? "");
      if (!groupId || !paneId) continue;
      state.assignments.push({
        group_id: groupId,
        agent_name: entry.agent_name ? String(entry.agent_name) : null,
        pane_id: paneId,
        workspace_id: entry.workspace_id ? String(entry.workspace_id) : null,
        updated_at: Number(entry.updated_at) || Date.now(),
      });
    }
  }

  const view = raw.view && typeof raw.view === "object" ? raw.view : {};
  const aliases = { groups: "grouped", all: "grouped" };
  const requested = aliases[view.mode] || view.mode;
  const mode = ["off", "grouped", "group"].includes(requested) ? requested : "grouped";
  state.view = { mode, group_id: mode === "group" ? (view.group_id ?? null) : null };
  return state;
}

function load() {
  const file = statePath();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  return normalize(parsed);
}

function save(state) {
  const dir = stateDir();
  const file = statePath();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.groups.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return file;
}

function slugify(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "group";
}

function uniqueGroupId(state, name) {
  const base = slugify(name);
  const taken = new Set(state.groups.map((group) => group.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function findGroup(state, needle) {
  if (!needle) return null;
  const wanted = String(needle).trim();
  const lowered = wanted.toLowerCase();
  return (
    state.groups.find((group) => group.id === wanted) ||
    state.groups.find((group) => group.name === wanted) ||
    state.groups.find((group) => group.name.toLowerCase() === lowered) ||
    state.groups.find((group) => group.id.toLowerCase() === lowered) ||
    null
  );
}

function groupIndex(state, needle) {
  const group = findGroup(state, needle);
  return group ? state.groups.findIndex((entry) => entry.id === group.id) : -1;
}

function addGroup(state, name) {
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("group name cannot be empty");
  if (clean.length > 40) throw new Error("group name is limited to 40 characters");
  const existing = findGroup(state, clean);
  if (existing) return { group: existing, created: false };
  const group = { id: uniqueGroupId(state, clean), name: clean, created_at: Date.now() };
  state.groups.push(group);
  return { group, created: true };
}

function renameGroup(state, needle, name) {
  const group = findGroup(state, needle);
  if (!group) throw new Error(`unknown group: ${needle}`);
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("group name cannot be empty");
  if (clean.length > 40) throw new Error("group name is limited to 40 characters");
  const clash = findGroup(state, clean);
  if (clash && clash.id !== group.id) throw new Error(`group "${clean}" already exists`);
  const previous = group.name;
  group.name = clean;
  return { group, previous };
}

function removeGroup(state, needle) {
  const index = groupIndex(state, needle);
  if (index < 0) throw new Error(`unknown group: ${needle}`);
  const [group] = state.groups.splice(index, 1);
  const removed = state.assignments.filter((entry) => entry.group_id === group.id);
  state.assignments = state.assignments.filter((entry) => entry.group_id !== group.id);
  if (state.view.mode === "group" && state.view.group_id === group.id) {
    state.view = { mode: "grouped", group_id: null };
  }
  return { group, removed };
}

function moveGroup(state, needle, delta) {
  const index = groupIndex(state, needle);
  if (index < 0) throw new Error(`unknown group: ${needle}`);
  const target = index + delta;
  if (target < 0 || target >= state.groups.length) return state.groups[index];
  const [group] = state.groups.splice(index, 1);
  state.groups.splice(target, 0, group);
  return group;
}

function sameIdentity(entry, identity) {
  if (identity.pane_id && entry.pane_id === identity.pane_id) return true;
  if (identity.agent_name && entry.agent_name === identity.agent_name) return true;
  return false;
}

function assign(state, groupNeedle, identity) {
  const group = findGroup(state, groupNeedle);
  if (!group) throw new Error(`unknown group: ${groupNeedle}`);
  if (!identity.pane_id) throw new Error("cannot assign: no pane id");
  state.assignments = state.assignments.filter((entry) => !sameIdentity(entry, identity));
  const entry = {
    group_id: group.id,
    agent_name: identity.agent_name || null,
    pane_id: identity.pane_id,
    workspace_id: identity.workspace_id || null,
    updated_at: Date.now(),
  };
  state.assignments.push(entry);
  return { group, entry };
}

function unassign(state, identity) {
  const before = state.assignments.length;
  state.assignments = state.assignments.filter((entry) => !sameIdentity(entry, identity));
  return before - state.assignments.length;
}

function unassignGroup(state, groupNeedle) {
  const group = findGroup(state, groupNeedle);
  if (!group) throw new Error(`unknown group: ${groupNeedle}`);
  const removed = state.assignments.filter((entry) => entry.group_id === group.id);
  state.assignments = state.assignments.filter((entry) => entry.group_id !== group.id);
  return removed;
}

module.exports = {
  addGroup,
  assign,
  emptyState,
  findGroup,
  groupIndex,
  load,
  moveGroup,
  normalize,
  removeGroup,
  renameGroup,
  save,
  slugify,
  stateDir,
  statePath,
  unassign,
  unassignGroup,
};
