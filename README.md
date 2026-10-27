# Agent Groups for Herdr

Manual agent grouping for [Herdr](https://herdr.dev). Name groups
("1. In Progress", "Review", "Blocked"), assign agents to them, and see them
grouped in the sidebar's Agent panel — with Herdr's own layout, columns, and
styling untouched.

```text
●  ~ · 1
   ▸ 1. In Progress · onboarding-client     ← the group name rides the first row
●  ~ · 1
   card-type-label                           ← rest of the block
●  ~ · 1
   create-cta
●  ~ · 2
   ▸ Review · docs
●  ~ · 2
   tests
```

Two things make that happen, and nothing else in the UI changes:

1. **Ordering.** The plugin writes an invisible sort key per pane and installs
   one Herdr *agent view* that sorts the Agent panel by it, so the agents of a
   group become one contiguous block, in group order.
2. **A heading.** Herdr has no group headers and plugins cannot add sidebar
   rows, so the group name is carried in the block's *first* row via that pane's
   display name. Rename a group and the heading follows; remove the agent and
   the next member becomes the heading (the plugin resyncs on pane events).

The first row of every block is the member your layout puts first (workspace,
then tab, then pane), so the heading does not hop around while agents change
state.

## Requirements

- Herdr 0.9.1 or newer (verified against 0.9.1 and 0.9.5)
- Node.js 18+ somewhere findable; no dependencies, no build step

`bin/run.sh` resolves the runtime instead of trusting `PATH`, because Herdr
runs plugin commands with the server's environment, which may be minimal. It
tries `PATH` first, then `~/.local/bin`, mise/asdf shims, `/opt/homebrew/bin`,
`/usr/local/bin`, and nvm/fnm version directories. Set `AGENT_GROUPS_NODE` to
override.

## Install

```bash
herdr plugin install igor-gorohovsky/herdr-agent-groups
herdr plugin list --plugin agent-groups
```

No `config.toml` change is needed: the plugin does not touch your keybindings
and does not override `ui.sidebar.agents`. For local development, link the
working copy instead:

```bash
herdr plugin link ~/Projects/herdr-agent-groups
```

## The manager

```bash
herdr plugin pane open --plugin agent-groups --entrypoint manager
```

Bind it to a key you do not already use, for example `prefix+alt+g`
(`prefix+g` is Herdr's `goto`, so do not take that one):

```toml
[[keys.command]]
key = "prefix+alt+g"
type = "plugin_action"
command = "agent-groups.manage"
description = "agent groups"
```

```text
 Agent Groups                                        view: grouped

  1. 1. In Progress (2)
     ● onboarding-client  wG:p18   working
     ○ create-cta         wG:p1B   idle
  2. Review (1)
     ✓ tests              wG:p19   done
     (ungrouped) (5)
     ○ claude             wG:p7    idle

↑↓ move   1-9 assign   u unassign   n new   r rename   d delete   s sync
enter focus   v sidebar view   q close
```

| Key | Action |
| --- | --- |
| `↑`/`↓`, `k`/`j` | Move the cursor |
| `1`–`9` | Put the selected agent in group 1–9 |
| `u` | Remove the selected agent from its group |
| `n` | Create a group (prompts for a name) |
| `r` | Rename the selected group |
| `d` `d` | Delete the selected group (press twice) |
| `enter` | Jump to the selected agent's pane and close |
| `v` | Cycle the sidebar view: grouped → only this group → off |
| `s` | Reapply metadata and view |
| `q` / `esc` | Close |

Group numbers are the digit targets; a group with no members still appears so
you can create it first and fill it later. `--assign` (the `assigner` pane)
starts on the focused pane's agent and closes as soon as you pick a group.

## Sidebar views

The plugin owns exactly one thing in the sidebar: an agent view, applied with
source `plugin:agent-groups`, so Herdr only lets it replace or clear its own.

```bash
node bin/cli.js view grouped      # default: sort by group, headings on first rows
node bin/cli.js view group Review # only that group
node bin/cli.js view off          # hand the panel back to Herdr untouched
```

`view off` restores Herdr's own ordering immediately and is remembered; the
plugin will not reapply a view until you ask for one.

## CLI

The CLI is the same code the manifest commands run, so you can script it:

```bash
node bin/cli.js add "In review"
node bin/cli.js assign "In review" --pane w1:p3
node bin/cli.js assign "In review" --agent reviewer
node bin/cli.js assign TODO              # focused agent (default)
node bin/cli.js unassign
node bin/cli.js rm "In review"
node bin/cli.js list [--json]
node bin/cli.js view <grouped|off|group NAME>
node bin/cli.js sync [--keep-stale]
node bin/cli.js open [--entrypoint manager|assigner]
node bin/cli.js snippet   # optional: show the group on EVERY row via $group
node bin/cli.js path
```

`--pane`/`--agent` default to the focused pane, so running
`agent-groups assign TODO` from a pane's shell groups that pane's agent.

## Actions in the manifest

| Action id | What it does |
| --- | --- |
| `agent-groups.manage` | Open the manager |
| `agent-groups.assign-focused` | Assign the focused agent in a small popup |
| `agent-groups.show-groups` | Apply the grouped sidebar view |
| `agent-groups.show-all` | Clear the plugin's view |
| `agent-groups.sync` | Reapply metadata and view |
| `agent-groups.list` | Print the group list to the plugin log |

## How it works

```
~/.local/state/herdr/plugins/agent-groups/groups.json   # groups + assignments
```

1. An assignment records `group_id`, `agent_name`, `pane_id`, and
   `workspace_id`. The agent name is the strong identity (Herdr keeps a live
   agent name with its pane occupant); the pane id is the fallback for unnamed
   agents.
2. Each assigned pane gets two tokens: `group` (the name, also used by the
   single-group filter) and `groupsort` (the ordering key). The block's first
   pane additionally gets a display name `▸ <group> · <agent>`.
3. One agent view sorts the panel by `groupsort`. Ungrouped agents have no key
   and therefore sort last, after the grouped blocks.
4. Tokens, display names, and views live in server memory. The `[[startup]]`
   hook, the `pane.closed` / `pane.agent_detected` event hooks, and `sync`
   reapply them, heal pane ids when an agent moves, and prune closed panes.
   Every write is diffed first, so an idle sync makes no Herdr calls.

## Local and remote machines

Herdr registers plugins **per user, per machine**, and plugin actions run on the
server you are viewing. Install it on every machine that runs agents:

```bash
# on the remote host itself (plugin install is not forwardable)
herdr plugin install igor-gorohovsky/herdr-agent-groups

# or register code you already copied there (plugin link *is* forwardable,
# and the path must be absolute and already exist on the host)
rsync -az ~/Projects/herdr-agent-groups/ mac:Projects/herdr-agent-groups/
herdr --machine mac plugin link /Users/me/Projects/herdr-agent-groups
herdr --machine mac plugin update agent-groups
```

Groups do not sync between machines: each host keeps its own `groups.json`. On a
client that shows several machines at once, `view grouped` sorts the combined
list while `view group <name>` filters by token and therefore hides agents whose
machine has no such group.

## Known limits

- The group name appears once per block, on its first row — Herdr has no sidebar
  headers and plugin v1 cannot add rows to the side panel.
- Block order is group order (as created in the manager), then workspace, tab,
  and pane. There is no custom sort yet.
- One view is active at a time: grouped, one group, or off.
- Linux and macOS only; `agent.view.set` is reached over the Unix socket, which
  this plugin does not speak on Windows.

## Next steps

- Automatic groups: a hook that maps an external ticket status onto
  `agent-groups assign <status>` would remove the manual step.
- Reordering groups (the manager lists them in creation order).
- Group colors via additional sidebar tokens, for people who do override
  `ui.sidebar.agents` themselves.
