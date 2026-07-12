// Bootstrap. Imports only Node builtins plus dotenv (which never throws), so
// no configuration problem can crash the process before this file runs.
// Order: load .env if present (local dev), bind the health port (platform
// checkers need it immediately), validate the environment with NAMED errors,
// then dynamically load the worker. Every failure mode is a readable log line.

import "dotenv/config";
import { existsSync } from "node:fs";
import { createServer } from "node:http";

function log(msg: string): void {
  console.log(`${new Date().toISOString()} [worker] ${msg}`);
}

process.on("uncaughtException", (e) => {
  log(`FATAL uncaught: ${e.stack ?? e.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  log(`FATAL unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});

const state: { phase: "booting" | "live"; detail: () => Record<string, unknown> } = {
  phase: "booting",
  detail: () => ({}),
};
const health = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, phase: state.phase, ...state.detail() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
const healthPort = Number(process.env.PORT ?? process.env.WORKER_HEALTH_PORT ?? 8787);
health.listen(healthPort, () => log(`health endpoint on :${healthPort}/health (${state.phase})`));

// Named environment validation before anything else loads.
const REQUIRED = ["TXLINE_API_ORIGIN", "TXLINE_API_TOKEN", "SOLANA_RPC_URL", "DATABASE_URL"];
const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
if (missing.length > 0) {
  log(`FATAL missing environment variable(s): ${missing.join(", ")}`);
  process.exit(1);
}
if (!process.env.AGENT_KEYPAIR_JSON?.trim() && !existsSync(process.env.AGENT_KEYPAIR_PATH ?? ".secrets/agent-keypair.json")) {
  log(`FATAL no wallet: set AGENT_KEYPAIR_JSON to the keypair's JSON array (starts with [ and ends with ])`);
  process.exit(1);
}
if (process.env.AGENT_KEYPAIR_JSON) {
  try {
    const arr = JSON.parse(process.env.AGENT_KEYPAIR_JSON);
    if (!Array.isArray(arr) || arr.length !== 64) throw new Error(`expected a 64-number array, got ${Array.isArray(arr) ? arr.length + " numbers" : typeof arr}`);
  } catch (e) {
    log(`FATAL AGENT_KEYPAIR_JSON is not valid keypair JSON: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

log("environment validated — loading worker");
const { start } = await import("./run.js");
await start({
  live: (detail) => {
    state.phase = "live";
    state.detail = detail;
  },
});
