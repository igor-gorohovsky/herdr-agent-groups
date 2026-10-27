#!/bin/sh
# Launch the plugin with whichever Node.js is available.
#
# Herdr runs plugin commands with the server's environment, which may be a
# minimal PATH (for example a GUI-launched or SSH-started server that never
# sourced the user's shell). Resolve a runtime instead of trusting PATH.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

find_node() {
  if [ -n "${AGENT_GROUPS_NODE:-}" ] && [ -x "${AGENT_GROUPS_NODE}" ]; then
    printf '%s' "${AGENT_GROUPS_NODE}"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    "${HOME}/.local/bin/node" \
    "${HOME}/.local/share/mise/shims/node" \
    "${HOME}/.asdf/shims/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  newest=""
  for candidate in \
    "${HOME}"/.nvm/versions/node/*/bin/node \
    "${HOME}"/.local/share/fnm/node-versions/*/installation/bin/node
  do
    if [ -x "$candidate" ]; then
      newest="$candidate"
    fi
  done
  if [ -n "$newest" ]; then
    printf '%s' "$newest"
    return 0
  fi
  return 1
}

if ! node_bin=$(find_node); then
  echo "agent-groups: no Node.js runtime found." >&2
  echo "Install Node 18+ or point AGENT_GROUPS_NODE at the binary." >&2
  exit 127
fi

exec "$node_bin" "$here/cli.js" "$@"
