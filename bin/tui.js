"use strict";

const herdr = require("../lib/herdr");
const store = require("../lib/store");
const view = require("../lib/view");
const { applyGroups } = require("../lib/sync");
const { buildModel, buildRows } = require("../lib/model");

const CSI = "\u001b[";
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const INVERSE = `${CSI}7m`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const ALT_SCREEN_ON = `${CSI}?1049h`;
const ALT_SCREEN_OFF = `${CSI}?1049l`;

const STATUS_GLYPH = {
  working: "\u25cf",
  blocked: "\u25b2",
  done: "\u2713",
  idle: "\u25cb",
  unknown: "?",
};

const HELP_KEYS = "\u2191\u2193 move   1-9 assign   u unassign   n new   r rename   d delete   s sync";
const HELP_KEYS_2 = "enter focus   v sidebar view   q close";

function agentLabel(agent) {
  return agent.name || agent.display_agent || agent.agent || agent.pane_id;
}

function truncate(text, width) {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return text.slice(0, 1);
  return `${text.slice(0, width - 1)}\u2026`;
}

function pad(text, width) {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

function rowKey(row) {
  if (!row) return "none";
  if (row.kind === "header") return `group:${row.group ? row.group.id : "(none)"}`;
  if (row.kind === "agent") return `agent:${row.agent.pane_id}`;
  return `stale:${row.entry.assignment.pane_id}:${row.entry.assignment.group_id}`;
}

class Manager {
  constructor({ assignMode }) {
    this.assignMode = assignMode;
    this.state = store.load();
    this.model = { agents: [], assigned: new Map(), stale: [], dropped: [], plan: [], groupById: new Map() };
    this.rows = [];
    this.cursor = 0;
    this.offset = 0;
    this.message = "";
    this.messageIsError = false;
    this.prompt = null;
    this.armedDelete = null;
    this.error = null;
    this.context = herdr.invocationContext();
    this.focusPaneId = this.context.focused_pane_id;
    this.quit = false;
  }

  reload({ keepCursor = true } = {}) {
    const previousKey = keepCursor ? rowKey(this.rows[this.cursor]) : null;
    this.state = store.load();
    try {
      this.model = buildModel(this.state, herdr.listAgents(), herdr.listPanes());
      this.error = null;
    } catch (error) {
      this.model = buildModel(this.state, [], null);
      this.error = `cannot read agents: ${error.message}`;
    }
    this.rows = buildRows(this.state, this.model);

    if (previousKey && previousKey !== "none") {
      const found = this.rows.findIndex((row) => rowKey(row) === previousKey);
      if (found >= 0) this.cursor = found;
    }
    this.clampCursor();
  }

  clampCursor() {
    if (this.cursor >= this.rows.length) this.cursor = Math.max(0, this.rows.length - 1);
    if (this.cursor < 0) this.cursor = 0;
  }

  focusInitialRow() {
    if (!this.focusPaneId) return;
    const index = this.rows.findIndex(
      (row) => row.kind === "agent" && row.agent.pane_id === this.focusPaneId,
    );
    if (index >= 0) this.cursor = index;
  }

  get currentRow() {
    return this.rows[this.cursor] || null;
  }

  say(text, isError = false) {
    this.message = text;
    this.messageIsError = isError;
  }

  move(delta) {
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
    this.armedDelete = null;
  }

  save() {
    store.save(this.state);
  }

  /** Recompute pane metadata in Herdr after a local edit. */
  reconcile() {
    try {
      return applyGroups(this.state, { warn: (line) => this.say(line, true) });
    } catch (error) {
      return { error: error.message };
    }
  }

  assign(groupIndex) {
    const row = this.currentRow;
    if (!row || row.kind !== "agent") {
      this.say("select an agent row first", true);
      return;
    }
    const group = this.state.groups[groupIndex];
    if (!group) {
      this.say(`no group ${groupIndex + 1}`, true);
      return;
    }
    const agent = row.agent;
    try {
      const result = store.assign(this.state, group.id, {
        pane_id: agent.pane_id,
        agent_name: agent.name || null,
        workspace_id: agent.workspace_id || null,
      });
      this.save();
      const summary = this.reconcile();
      this.say(`${agentLabel(agent)} \u2192 ${result.group.name}${summary.error ? ` (Herdr: ${summary.error})` : ""}`, Boolean(summary.error));
      if (this.assignMode) this.quit = true;
    } catch (error) {
      this.say(error.message, true);
    }
  }

  unassign() {
    const row = this.currentRow;
    if (!row) return;
    if (row.kind === "agent") {
      const agent = row.agent;
      store.unassign(this.state, { pane_id: agent.pane_id, agent_name: agent.name || null });
      this.save();
      const summary = this.reconcile();
      this.say(`${agentLabel(agent)} \u2192 (ungrouped)${summary.error ? ` (Herdr: ${summary.error})` : ""}`, Boolean(summary.error));
    } else if (row.kind === "stale") {
      store.unassign(this.state, {
        pane_id: row.entry.assignment.pane_id,
        agent_name: row.entry.assignment.agent_name,
      });
      this.save();
      this.say("removed stale assignment");
    } else {
      this.say("select an agent row first", true);
      return;
    }
    this.reload();
  }

  removeGroup() {
    const row = this.currentRow;
    if (!row || row.kind !== "header" || !row.group) {
      this.say("select a group header first", true);
      return;
    }
    if (this.armedDelete !== row.group.id) {
      this.armedDelete = row.group.id;
      this.say(`press d again to delete "${row.group.name}" and clear its members`);
      return;
    }
    this.armedDelete = null;
    try {
      store.removeGroup(this.state, row.group.id);
      this.save();
      this.reconcile();
      this.say(`deleted group ${row.group.name}`);
      this.reload();
      this.refreshView({ quiet: true });
    } catch (error) {
      this.say(error.message, true);
    }
  }

  startPrompt(label, initial, onDone) {
    this.prompt = { label, buffer: initial || "", onDone };
    this.armedDelete = null;
  }

  submitPrompt() {
    const prompt = this.prompt;
    this.prompt = null;
    if (!prompt) return;
    const value = prompt.buffer.trim();
    if (!value) return;
    prompt.onDone(value);
  }

  newGroup() {
    this.startPrompt("new group name", "", (name) => {
      try {
        const { group, created } = store.addGroup(this.state, name);
        this.save();
        this.say(created ? `created group ${group.name}` : `group ${group.name} already exists`);
        this.reload();
      } catch (error) {
        this.say(error.message, true);
      }
    });
  }

  renameGroup() {
    const row = this.currentRow;
    const group = row && row.kind === "header" ? row.group : row && row.group ? row.group : null;
    if (!group) {
      this.say("select a group header first", true);
      return;
    }
    this.startPrompt(`rename "${group.name}" to`, group.name, (name) => {
      try {
        store.renameGroup(this.state, group.id, name);
        this.save();
        this.say(`renamed to ${name}`);
        this.reload();
        this.refreshView({ quiet: true });
      } catch (error) {
        this.say(error.message, true);
      }
    });
  }

  async cycleView() {
    const row = this.currentRow;
    const group = row && row.group ? row.group : null;
    if (this.state.view.mode === "off") {
      this.state.view = { mode: "grouped", group_id: null };
    } else if (this.state.view.mode === "grouped" && group) {
      this.state.view = { mode: "group", group_id: group.id };
    } else {
      this.state.view = { mode: "off", group_id: null };
    }
    this.save();
    this.say(`sidebar view: ${view.label(this.state)}`);
    await this.refreshView();
  }

  async refreshView({ quiet = false } = {}) {
    try {
      await view.apply(this.state, { source: herdr.SOURCE, quiet: true });
    } catch (error) {
      if (!quiet) this.say(`sidebar view failed: ${error.message}`, true);
    }
  }

  async sync() {
    this.say("syncing\u2026");
    this.render();
    try {
      const summary = applyGroups(this.state, { warn: (line) => this.say(line, true) });
      this.say(
        `synced: ${summary.written} tokens, ${summary.healed} healed, ${summary.pruned} pruned`,
      );
      this.reload();
      await this.refreshView({ quiet: true });
    } catch (error) {
      this.say(`sync failed: ${error.message}`, true);
    }
  }

  focusCurrent() {
    const row = this.currentRow;
    if (!row) return;
    if (row.kind === "header") {
      const first = this.rows.findIndex(
        (entry, index) =>
          index > this.cursor && entry.kind === "agent" && entry.group === row.group,
      );
      if (first >= 0) {
        this.cursor = first;
        this.say("moved to the first agent of this group");
      } else {
        this.say("this group has no live agents");
      }
      return;
    }
    const target = row.kind === "agent" ? row.agent.name || row.agent.pane_id : row.entry.assignment.agent_name;
    try {
      herdr.focusAgent(target);
      this.quit = true;
    } catch (error) {
      this.say(error.message, true);
    }
  }

  async handleKey(key) {
    if (this.prompt) {
      if (key === "esc" || key === "ctrl-c") {
        this.prompt = null;
        this.say("cancelled");
        return;
      }
      if (key === "enter") {
        this.submitPrompt();
        return;
      }
      if (key === "backspace") {
        this.prompt.buffer = this.prompt.buffer.slice(0, -1);
        return;
      }
      if (key.length === 1 && key >= " ") this.prompt.buffer += key;
      return;
    }

    if (key === "q" || key === "esc" || key === "ctrl-c") {
      this.quit = true;
      return;
    }
    this.armedDelete = null;

    switch (key) {
      case "up":
      case "k":
        return this.move(-1);
      case "down":
      case "j":
        return this.move(1);
      case "home":
        this.cursor = 0;
        return;
      case "end":
        this.cursor = this.rows.length - 1;
        return;
      case "u":
        return this.unassign();
      case "n":
        return this.newGroup();
      case "r":
        return this.renameGroup();
      case "d":
        return this.removeGroup();
      case "enter":
        return this.focusCurrent();
      case "v":
        return this.cycleView();
      case "s":
        return this.sync();
      default:
        if (/^[1-9]$/.test(key)) return this.assign(Number(key) - 1);
        return undefined;
    }
  }

  bodyLines(width, height) {
    const lines = [];
    const groupIndexes = new Map(this.state.groups.map((group, index) => [group.id, index + 1]));

    for (let i = this.offset; i < this.rows.length && lines.length < height; i += 1) {
      const row = this.rows[i];
      const selected = i === this.cursor;
      const marker = selected ? "\u203a " : "  ";
      let text;
      let style = selected ? INVERSE : "";

      if (row.kind === "header") {
        const number = row.group ? groupIndexes.get(row.group.id) : null;
        const prefix = row.group && number && number <= 9 ? `${number}.` : "  ";
        const suffix = row.group && row.count === 0 ? "  (empty)" : "";
        const viewMark =
          row.group && this.state.view.mode === "group" && this.state.view.group_id === row.group.id
            ? "  \u2190 sidebar"
            : "";
        text = `${marker}${prefix} ${row.group ? row.group.name : "(ungrouped)"} (${row.count})${suffix}${viewMark}`;
        if (!selected) style = BOLD;
        if (!row.group) style = selected ? INVERSE : DIM;
      } else if (row.kind === "agent") {
        const agent = row.agent;
        const glyph = STATUS_GLYPH[agent.agent_status] || "?";
        const label = pad(truncate(agentLabel(agent), 22), 22);
        const pane = pad(agent.pane_id, 8);
        const status = agent.agent_status || "unknown";
        text = `${marker}   ${glyph} ${label} ${pane} ${status}`;
        if (agent.pane_id === this.focusPaneId && !selected) style = BOLD;
      } else {
        const assignment = row.entry.assignment;
        const label = pad(truncate(assignment.agent_name || assignment.pane_id, 22), 22);
        text = `${marker}   \u00b7 ${label} ${pad(assignment.pane_id, 8)} gone`;
        if (!selected) style = DIM;
      }
      lines.push({ text: truncate(text, width), style });
    }

    if (!this.rows.length) {
      lines.push({ text: truncate("  no agents running", width), style: DIM });
      lines.push({ text: truncate("  press n to create a group", width), style: DIM });
    }
    return lines;
  }

  frame(width, height) {
    const bodyHeight = Math.max(1, height - 5);
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.rows.length - bodyHeight)));
    if (this.cursor < this.offset) this.offset = this.cursor;
    if (this.cursor >= this.offset + bodyHeight) this.offset = this.cursor - bodyHeight + 1;

    const title = `Agent Groups`;
    const right = `view: ${view.label(this.state)}`;
    const gap = Math.max(1, width - title.length - right.length - 2);
    const lines = [
      { text: truncate(` ${title}${" ".repeat(gap)}${right}`, width), style: BOLD },
      { text: "", style: "" },
    ];

    for (const line of this.bodyLines(width, bodyHeight)) lines.push(line);

    while (lines.length < 2 + bodyHeight) lines.push({ text: "", style: "" });

    lines.push({ text: truncate(HELP_KEYS, width), style: DIM });
    lines.push({ text: truncate(HELP_KEYS_2, width), style: DIM });
    lines.push({ text: "", style: "" });

    if (this.prompt) {
      lines[lines.length - 1] = {
        text: truncate(` ${this.prompt.label}: ${this.prompt.buffer}_`, width),
        style: BOLD,
      };
      return lines.slice(0, height);
    }

    const message = this.error || this.message;
    const style = this.error || this.messageIsError ? "" : DIM;
    if (message) lines[lines.length - 1] = { text: truncate(` ${message}`, width), style };
    return lines.slice(0, height);
  }

  render() {
    const width = process.stdout.columns || 80;
    const height = process.stdout.rows || 24;
    const lines = this.frame(width, height);
    let out = HIDE_CURSOR + `${CSI}H`;
    for (let i = 0; i < height; i += 1) {
      const line = lines[i];
      out += `${CSI}2K`;
      if (line && line.text) out += `${line.style}${truncate(line.text, width)}${line.style ? RESET : ""}`;
      if (i < height - 1) out += "\r\n";
    }
    out += `${CSI}J`;
    process.stdout.write(out);
  }
}

function parseKeys(chunk) {
  const keys = [];
  let i = 0;
  while (i < chunk.length) {
    const char = chunk[i];
    if (char === "\u001b") {
      if (chunk.startsWith(`${CSI}A`, i)) {
        keys.push("up");
        i += 3;
        continue;
      }
      if (chunk.startsWith(`${CSI}B`, i)) {
        keys.push("down");
        i += 3;
        continue;
      }
      if (chunk.startsWith(`${CSI}H`, i)) {
        keys.push("home");
        i += 3;
        continue;
      }
      if (chunk.startsWith(`${CSI}F`, i)) {
        keys.push("end");
        i += 3;
        continue;
      }
      if (chunk.startsWith(`${CSI}1~`, i)) {
        keys.push("home");
        i += 4;
        continue;
      }
      if (chunk.startsWith(`${CSI}4~`, i)) {
        keys.push("end");
        i += 4;
        continue;
      }
      if (chunk.startsWith(`${CSI}3~`, i)) {
        keys.push("delete");
        i += 4;
        continue;
      }
      if (chunk.startsWith(`${CSI}`, i)) {
        let end = i + 2;
        while (end < chunk.length && !/[@-~]/.test(chunk[end])) end += 1;
        i = end + 1;
        continue;
      }
      keys.push("esc");
      i += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      keys.push("enter");
      i += 1;
      continue;
    }
    if (char === "\u007f" || char === "\b") {
      keys.push("backspace");
      i += 1;
      continue;
    }
    if (char === "\t") {
      keys.push("tab");
      i += 1;
      continue;
    }
    if (char === "\u0003") {
      keys.push("ctrl-c");
      i += 1;
      continue;
    }
    keys.push(char);
    i += 1;
  }
  return keys;
}

function renderFrameOnly(manager) {
  manager.reload();
  manager.focusInitialRow();
  const width = Number(process.env.COLUMNS) || 80;
  const height = Number(process.env.LINES) || 24;
  const lines = manager.frame(width, height);
  for (const line of lines) process.stdout.write(`${line.text}\n`);
}

async function runTui({ assignMode = false, frameOnly = false } = {}) {
  const manager = new Manager({ assignMode });

  if (frameOnly) {
    renderFrameOnly(manager);
    return;
  }

  if (!process.stdin.isTTY) {
    process.stdout.write(
      "agent-groups: the manager needs an interactive terminal.\n" +
        "Open it with: herdr plugin pane open --plugin agent-groups --entrypoint manager\n",
    );
    return;
  }

  manager.reload();
  manager.focusInitialRow();

  const stdin = process.stdin;
  const stdout = process.stdout;

  const cleanup = () => {
    stdin.setRawMode?.(false);
    stdin.pause();
    stdout.write(SHOW_CURSOR + `${CSI}0m` + ALT_SCREEN_OFF);
  };

  const onKey = async (chunk) => {
    for (const key of parseKeys(chunk)) {
      // eslint-disable-next-line no-await-in-loop
      await manager.handleKey(key);
      manager.render();
      if (manager.quit) {
        cleanup();
        process.exit(0);
      }
    }
  };

  stdout.write(ALT_SCREEN_ON + `${CSI}2J`);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdin.on("data", onKey);

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", () => {
    stdout.write(SHOW_CURSOR + RESET);
  });
  stdout.on("resize", () => manager.render());

  manager.render();

  // Background refresh so the list follows agents as they appear and exit.
  const timer = setInterval(() => {
    if (manager.quit || manager.prompt) return;
    manager.reload();
    manager.render();
  }, 2000);
  timer.unref?.();
}

module.exports = { runTui };
