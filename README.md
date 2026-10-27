# Agent Groups for Herdr

Manual agent grouping for [Herdr](https://herdr.dev). Put agents into named
groups ("TODO", "In review", "Blocked"), see the groups in a popup manager, and
order or filter Herdr's own sidebar Agent panel by group.

Herdr has no built-in grouping, but it does expose the two primitives this
plugin needs:

- **pane metadata tokens** — `pane report-metadata --token group=<name>` tags a
  pane, and `$group` becomes available to Agent sidebar rows.
- **agent views** — `agent.view.set` sorts or filters the sidebar Agent panel,
  using the same token.

The plugin stores the assignments, writes the tokens, and installs the view.

## Requirements

- Herdr 0.9.1 or newer (verified against 0.9.1 and 0.9.5)
- `node` on `PATH` (18+); no dependencies, no build step

## Install

```bash
herdr plugin link ~/Projects/herdr-agent-groups
herdr plugin list --plugin agent-groups
```

Then add what you want to your `~/.config/herdr/config.toml` and reload:

```bash
herdr server reload-config
```

### 1. Keys (recommended)

```toml
[[keys.command]]
key = "prefix+g"
type = "plugin_action"
command = "agent-groups.manage"
description = "agent groups"

[[keys.command]]
key = "prefix+shift+g"
type = "plugin_action"
command = "agent-groups.assign-focused"
description = "assign agent to a group"
```

`prefix+g` opens the manager. `prefix+shift+g` opens it already pointing at the
agent in the focused pane and closes as soon as you pick a group.

The same two panes are available without a keybinding:

```bash
herdr plugin pane open --plugin agent-groups --entrypoint manager
herdr plugin pane open --plugin agent-groups --entrypoint assigner
```

### 2. Show the group in the sidebar (recommended)

```bash
agent-groups snippet   # or: node bin/cli.js snippet
```

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", "$group"],
]
```

Without this the sidebar still *orders* by group, but the group name is not
shown on the row.

### 3. Turn on sidebar grouping

Keys inside the manager, or:

```bash
node bin/cli.js view groups          # sort the Agent panel by group
node bin/cli.js view group "TODO"    # show only one group
node bin/cli.js view off             # hand the sidebar back to Herdr
```

## The manager

```
 Agent Groups                                        view: grouped

  1. TODO (2)
     ● api              w1:p1    working
     ○ pi               w1:p2    idle
  2. In review (1)
     ✓ tests            w1:p3    done
     (ungrouped) (1)
     ▲ docs             w2:p1    blocked

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
| `v` | Cycle the sidebar view: off → grouped → only the selected group |
| `s` | Reapply tokens and the saved view |
| `q` / `esc` | Close |

Numbered group headers are the digit targets. A group you have never assigned
anything to still appears, so you can create the group first and fill it later.

## CLI

The CLI is the same code the manifest actions run, so you can script it:

```bash
node bin/cli.js add "In review"
node bin/cli.js assign "In review" --pane w1:p3
node bin/cli.js assign "In review" --agent reviewer
node bin/cli.js assign TODO              # focused agent (default)
node bin/cli.js unassign
node bin/cli.js rm "In review"
node bin/cli.js list [--json]
node bin/cli.js view <off|groups|group> [<group>]
node bin/cli.js open [--entrypoint manager|assigner]
node bin/cli.js sync [--keep-stale]
node bin/cli.js path
```

`--pane`/`--agent` default to the focused pane, so running `agent-groups assign
TODO` from a pane's shell groups that pane's agent.

## Actions in the manifest

| Action id | What it does |
| --- | --- |
| `agent-groups.manage` | Open the manager popup |
| `agent-groups.assign-focused` | Assign the focused agent in a small popup |
| `agent-groups.show-groups` | Sidebar sorted by group |
| `agent-groups.show-all` | Clear the plugin's view |
| `agent-groups.sync` | Reapply tokens and view |
| `agent-groups.list` | Print the group list to the plugin log |

## How it works

```
~/.local/state/herdr/plugins/agent-groups/groups.json   # groups + assignments
```

1. An assignment records `group_id`, `agent_name`, `pane_id`, and
   `workspace_id`. The agent name is the strong identity (Herdr keeps a live
   agent name with its pane occupant); the pane id is the fallback for unnamed
   agents.
2. Every assignment becomes one `pane report-metadata --token group=<name>`
   call from source `plugin:agent-groups`.
3. The sidebar view is one `agent.view.set` request with the same source, so
   Herdr only lets this plugin replace or clear its own view.
4. Tokens and views live in server memory. The `[[startup]]` hook, the
   `pane.closed` / `pane.agent_detected` event hooks, and `sync` reapply them,
   heal pane ids when an agent moves, and prune assignments for closed panes.

## Known limits

- Agent rows sort **alphabetically by group name** in the sidebar (that is how
  token sorts work). Name groups to control the order, for example
  `1 todo`, `2 review`, `3 done`.
- Only one view is active at a time: off, grouped, or one group.
- `manager` is a popup, not a sidebar panel; Herdr plugins cannot draw into the
  sidebar.
- Linux and macOS only. `agent.view.set` is reached over the Unix socket, which
  this plugin does not yet speak on Windows.
- Groups are per user and shared across named sessions, like any Herdr plugin.

## Next steps

- Automatic groups: a hook that maps an external ticket status onto
  `agent-groups assign <status>` would remove the manual step.
- Group colors via other sidebar tokens.
- Per-group keys once Herdr supports arguments in plugin actions.
