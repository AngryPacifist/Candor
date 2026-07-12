// The determinism test: same recording + same params -> byte-identical
// decisions, within a process and across processes. This is the rubric's
// "deterministic, defensible logic" made checkable.
// Run: npx tsx tests/determinism.ts

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.js";
import { simulateMatch } from "../src/replay/simulate.js";
import { STRATEGY_PARAMS, STRATEGY_PARAMS_HASH } from "../src/strategy/params.js";
import type { OddsRecord, ScoreRecord } from "../src/txline/types.js";

import { existsSync } from "node:fs";
const FIXTURES = [18218149, 18198205, 18213979, 18222446].filter((id) =>
  existsSync(`resources/replays/${id}.odds.jsonl`)
);

function simHash(fixtureId: number): string {
  const scoreRecords = readFileSync(`resources/replays/${fixtureId}.jsonl`, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ScoreRecord);
  const oddsRecords = readFileSync(`resources/replays/${fixtureId}.odds.jsonl`, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as OddsRecord);
  const r = simulateMatch({ fixtureId, scoreRecords, oddsRecords, params: STRATEGY_PARAMS, evalMs: 5_000 });
  return sha256Hex(canonicalJson({ entries: r.entries, jumps: r.jumps, final: r.final }));
}

if (process.argv[2] === "--child") {
  // child mode: print one hash per fixture and exit
  console.log(FIXTURES.map(simHash).join(" "));
  process.exit(0);
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log(`params ${STRATEGY_PARAMS.version} hash=${STRATEGY_PARAMS_HASH.slice(0, 16)}`);

// in-process: two runs must agree per fixture
const first = FIXTURES.map(simHash);
const second = FIXTURES.map(simHash);
FIXTURES.forEach((f, i) =>
  check(`in-process determinism ${f}`, first[i] === second[i], first[i]!.slice(0, 16))
);

// cross-process: a fresh node process must reproduce the same hashes
const child = spawnSync(process.execPath, ["--import", "tsx", "tests/determinism.ts", "--child"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
const childHashes = (child.stdout ?? "").trim().split("\n").pop()?.split(" ") ?? [];
FIXTURES.forEach((f, i) =>
  check(`cross-process determinism ${f}`, childHashes[i] === first[i], childHashes[i]?.slice(0, 16) ?? "no output")
);

if (failures > 0) {
  console.error(`\n${failures} determinism check(s) FAILED`);
  process.exit(1);
}
console.log("\nDETERMINISTIC: same recording in, byte-identical decisions out.");
