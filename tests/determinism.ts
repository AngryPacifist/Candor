// The determinism test: same recording + same params -> byte-identical
// decisions AND byte-identical accountability artifacts (canonical payloads,
// payload hashes, commit memos, bankroll trajectory), within a process and
// across processes. This is the rubric's "deterministic, defensible logic"
// made checkable, extended to the ledger/commit layer as a dry run.
// Also asserts: the production grader (ledger.gradePosition) agrees with the
// replay harness grader on every entry, and the frozen-params replay results
// match the documented tuning sweep (docs/params-tuning.md).
// Run: npx tsx tests/determinism.ts

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { buildCommitMemo } from "../src/chain/commit.js";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.js";
import { buildPositionPayload, gradePosition } from "../src/ledger/ledger.js";
import { simulateMatch, type SimResult } from "../src/replay/simulate.js";
import { STRATEGY_PARAMS, STRATEGY_PARAMS_HASH } from "../src/strategy/params.js";
import type { OddsRecord, ScoreRecord } from "../src/txline/types.js";

const FIXTURES = [18218149, 18198205, 18213979, 18222446].filter((id) =>
  existsSync(`resources/replays/${id}.odds.jsonl`)
);

// Frozen-replay ground truth at the frozen params (the documented tuning sweep:
// 3 entries, 2W 1L, +9.2u across the four recordings). A change here means the
// strategy stack no longer reproduces the record the params were frozen on.
const FROZEN_EXPECT: Record<number, { entries: number; pnlUnits: number }> = {
  18218149: { entries: 0, pnlUnits: 0 },
  18198205: { entries: 1, pnlUnits: -12.28 },
  18213979: { entries: 1, pnlUnits: 14.15 },
  18222446: { entries: 1, pnlUnits: 7.3 },
};

function simArtifacts(fixtureId: number): { r: SimResult; digest: string } {
  const scoreRecords = readFileSync(`resources/replays/${fixtureId}.jsonl`, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ScoreRecord);
  const oddsRecords = readFileSync(`resources/replays/${fixtureId}.odds.jsonl`, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as OddsRecord);
  const r = simulateMatch({ fixtureId, scoreRecords, oddsRecords, params: STRATEGY_PARAMS, evalMs: 5_000 });

  // Ledger/commit dry run: rebuild the exact artifacts production would anchor
  // on-chain. The sim opens every entry at the starting bankroll (bankroll only
  // moves on settlement, and all of a match's entries open before its final).
  // Production chains commit memos on tx signatures; those do not exist offline,
  // so the dry-run chain links payload hashes instead.
  const bankroll0 = STRATEGY_PARAMS.sizing.startingBankrollUnits;
  let prev = "genesis";
  const commits = r.entries.map((e) => {
    const { payloadCanonical, payloadHash } = buildPositionPayload({
      candidate: {
        family: e.family, fixtureId, lineKey: e.lineKey, side: e.side,
        price: e.price, modelProb: e.modelProb, marketProb: e.marketProb,
        ts: e.ts, reason: e.reason,
      },
      scope: e.scope,
      stakeUnits: e.stakeUnits,
      entryGoals1: e.entryGoals1,
      entryGoals2: e.entryGoals2,
      bankrollBefore: bankroll0,
    });
    const memo = buildCommitMemo(payloadHash, STRATEGY_PARAMS_HASH, prev);
    prev = payloadHash;
    return { payloadCanonical, payloadHash, memo };
  });
  let bank = bankroll0;
  const bankrollTrajectory = r.entries.map((e) => (bank = Math.round((bank + e.pnlUnits) * 100) / 100));

  const digest = sha256Hex(
    canonicalJson({ entries: r.entries, jumps: r.jumps, final: r.final, commits, bankrollTrajectory })
  );
  return { r, digest };
}

if (process.argv[2] === "--child") {
  // child mode: print one digest per fixture and exit
  console.log(FIXTURES.map((f) => simArtifacts(f).digest).join(" "));
  process.exit(0);
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log(`params ${STRATEGY_PARAMS.version} hash=${STRATEGY_PARAMS_HASH.slice(0, 16)}`);

// in-process: two runs must agree per fixture
const first = FIXTURES.map((f) => simArtifacts(f));
const second = FIXTURES.map((f) => simArtifacts(f));
FIXTURES.forEach((f, i) =>
  check(`in-process determinism ${f}`, first[i]!.digest === second[i]!.digest, first[i]!.digest.slice(0, 16))
);

// grader parity: the production grader must agree with the harness grader on
// identical inputs for every entry (drift between the two would split the
// replay evidence from live settlement)
FIXTURES.forEach((f, i) => {
  const r = first[i]!.r;
  const mismatches = r.entries.filter((e) => {
    const prod = gradePosition({
      marketKey: e.lineKey,
      side: e.side,
      entryGoals1: e.entryGoals1,
      entryGoals2: e.entryGoals2,
      finalGoals1: e.scope === "full" ? r.final.goals1 : r.final.h1goals1,
      finalGoals2: e.scope === "full" ? r.final.goals2 : r.final.h1goals2,
    });
    return prod !== e.outcome;
  });
  check(`grader parity ${f}`, mismatches.length === 0, `${r.entries.length} entries`);
});

// frozen-replay pin: the frozen params must keep reproducing the documented
// tuning-sweep results on the recordings that are present
FIXTURES.forEach((f, i) => {
  const r = first[i]!.r;
  const exp = FROZEN_EXPECT[f];
  if (!exp) return;
  const pnl = Math.round(r.entries.reduce((a, e) => a + e.pnlUnits, 0) * 100) / 100;
  check(
    `frozen-replay pin ${f}`,
    r.entries.length === exp.entries && Math.abs(pnl - exp.pnlUnits) < 0.005,
    `${r.entries.length} entries, ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}u`
  );
});

// cross-process: a fresh node process must reproduce the same digests
const child = spawnSync(process.execPath, ["--import", "tsx", "tests/determinism.ts", "--child"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
const childHashes = (child.stdout ?? "").trim().split("\n").pop()?.split(" ") ?? [];
FIXTURES.forEach((f, i) =>
  check(`cross-process determinism ${f}`, childHashes[i] === first[i]!.digest, childHashes[i]?.slice(0, 16) ?? "no output")
);

if (failures > 0) {
  console.error(`\n${failures} determinism check(s) FAILED`);
  process.exit(1);
}
console.log("\nDETERMINISTIC: same recording in, byte-identical decisions and on-chain artifacts out.");
