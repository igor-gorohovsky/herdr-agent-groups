"use strict";

const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

let counter = 0;

function defaultSocketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const home = os.homedir();
  const configDir = process.env.HERDR_CONFIG_PATH
    ? path.dirname(process.env.HERDR_CONFIG_PATH)
    : path.join(home, ".config", "herdr");
  const session = process.env.HERDR_SESSION;
  return session
    ? path.join(configDir, "sessions", session, "herdr.sock")
    : path.join(configDir, "herdr.sock");
}

/**
 * Send one newline-delimited JSON request to the local Herdr server.
 * The CLI covers most of the API; `agent.view.set`/`clear` are socket-only.
 */
function request(method, params = {}, { timeout = 5000, socketPath } = {}) {
  const target = socketPath || defaultSocketPath();
  const id = `agent-groups:${process.pid}:${++counter}`;

  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const sock = net.connect(target);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(value);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`timed out waiting for ${method} on ${target}`)),
      timeout,
    );

    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id, method, params }) + "\n"));
    sock.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== id) continue;
        if (message.error) {
          const error = new Error(
            message.error.message || message.error.code || `${method} failed`,
          );
          error.code = message.error.code;
          finish(reject, error);
        } else {
          finish(resolve, message.result);
        }
        return;
      }
    });
    sock.on("error", (error) => finish(reject, error));
  });
}

module.exports = { defaultSocketPath, request };
