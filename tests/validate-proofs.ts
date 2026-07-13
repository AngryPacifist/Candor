// Commit/proof layer validation — REAL mainnet, end to end.
// 1. Pure win-condition compilation checks (all market types, all outcomes).
// 2. Simulated validate_stat_v2 for synthetic claims about the FINISHED Spain
//    match (1X2 winner, OU over/under, AH with entry score) — free .view()s,
//    every result asserted against the known final (2-1).
// 3. Probe: is the 3000 band (true H2) servable by stat-validation?
// 4. ONLY with --broadcast AND CANDOR_TEST_DATABASE_URL: the real pipeline on
//    that database's latest settled position — memo COMMIT (hash-chained) then
//    PROOF broadcast. Two real mainnet transactions, and it writes that
//    database's commit chain tip. Never point it at a live database.
//
// Requirements: .env with TxLINE credentials + SOLANA_RPC_URL and a funded
// agent wallet (even free .view() simulations need an existing fee payer).
// Run: npx tsx tests/validate-proofs.ts [--broadcast]

import BN from "bn.js";
import { ComputeBudgetProgram } from "@solana/web3.js";
import pg from "pg";
import { commitPosition } from "../src/chain/commit.js";
import { buildWinCondition, proveSettlement } from "../src/chain/proof.js";
import { dailyScoresPda, loadAgentKeypair, mainnetConnection, mapProof, parseHash, txoracleProgram } from "../src/chain/solana.js";
import { TxlineClient } from "../src/txline/client.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function conditionChecks(): void {
  console.log("— win-condition compilation —");
  const cases: { in: Parameters<typeof buildWinCondition>[0]; expectKeys: number[]; expected: boolean }[] = [
    { in: { marketKey: "1X2_PARTICIPANT_RESULT||", scope: "full", side: "part1", entryGoals1: 0, entryGoals2: 0, outcome: "won" }, expectKeys: [1, 2], expected: true },
    { in: { marketKey: "1X2_PARTICIPANT_RESULT|half=1|", scope: "half1", side: "draw", entryGoals1: 0, entryGoals2: 0, outcome: "lost" }, expectKeys: [1001, 1002], expected: false },
    { in: { marketKey: "OVERUNDER_PARTICIPANT_GOALS||line=2.5", scope: "full", side: "over", entryGoals1: 0, entryGoals2: 0, outcome: "won" }, expectKeys: [1, 2], expected: true },
    { in: { marketKey: "OVERUNDER_PARTICIPANT_GOALS||line=3", scope: "full", side: "under", entryGoals1: 0, entryGoals2: 0, outcome: "push" }, expectKeys: [1, 2], expected: true },
    { in: { marketKey: "ASIANHANDICAP_PARTICIPANT_GOALS||line=-0.5", scope: "full", side: "part1", entryGoals1: 1, entryGoals2: 1, outcome: "lost" }, expectKeys: [1, 2], expected: false },
  ];
  for (const c of cases) {
    const r = buildWinCondition(c.in);
    check(
      `compile ${c.in.marketKey} ${c.in.side} ${c.in.outcome}`,
      r.ok && r.condition.expected === c.expected && JSON.stringify(r.condition.statKeys) === JSON.stringify(c.expectKeys),
      r.ok ? r.condition.description : r.reason
    );
  }
}

async function syntheticSpainProofs(client: TxlineClient): Promise<void> {
  console.log("— synthetic claims vs the real Spain final (2-1), mainnet simulations —");
  const FIXTURE = 18218149;
  const SEQ = 1087;
  const conn = mainnetConnection();
  const agent = loadAgentKeypair();
  const { program } = txoracleProgram(conn, agent);
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  const claims: { name: string; pos: Parameters<typeof buildWinCondition>[0]; expectOnChain: boolean }[] = [
    { name: "1X2 part1 (Spain won)", pos: { marketKey: "1X2_PARTICIPANT_RESULT||", scope: "full", side: "part1", entryGoals1: 0, entryGoals2: 0, outcome: "won" }, expectOnChain: true },
    { name: "1X2 draw (it wasn't)", pos: { marketKey: "1X2_PARTICIPANT_RESULT||", scope: "full", side: "draw", entryGoals1: 0, entryGoals2: 0, outcome: "lost" }, expectOnChain: false },
    { name: "OU over 2.5 (3 goals)", pos: { marketKey: "OVERUNDER_PARTICIPANT_GOALS||line=2.5", scope: "full", side: "over", entryGoals1: 0, entryGoals2: 0, outcome: "won" }, expectOnChain: true },
    { name: "OU under 2.5 (lost)", pos: { marketKey: "OVERUNDER_PARTICIPANT_GOALS||line=2.5", scope: "full", side: "under", entryGoals1: 0, entryGoals2: 0, outcome: "lost" }, expectOnChain: false },
    { name: "AH part1 -0.5 pre-match (margin 1 > 0.5... c=-0.5, K=1 > -0.5? yes)", pos: { marketKey: "ASIANHANDICAP_PARTICIPANT_GOALS||line=-0.5", scope: "full", side: "part1", entryGoals1: 0, entryGoals2: 0, outcome: "won" }, expectOnChain: true },
    { name: "AH part1 -0.5 from 1-1 (H2 margin 1-0 covers)", pos: { marketKey: "ASIANHANDICAP_PARTICIPANT_GOALS||line=-0.5", scope: "full", side: "part1", entryGoals1: 1, entryGoals2: 1, outcome: "won" }, expectOnChain: true },
    { name: "H1 OU over 1.5 (H1 1-1 = 2 goals)", pos: { marketKey: "OVERUNDER_PARTICIPANT_GOALS|half=1|line=1.5", scope: "half1", side: "over", entryGoals1: 0, entryGoals2: 0, outcome: "won" }, expectOnChain: true },
  ];

  for (const claim of claims) {
    const built = buildWinCondition(claim.pos);
    if (!built.ok) {
      check(claim.name, false, built.reason);
      continue;
    }
    try {
      const val = await client.statValidation(FIXTURE, SEQ, built.condition.statKeys);
      const targetTs = val.summary.updateStats.minTimestamp;
      const payload = {
        ts: new BN(targetTs),
        fixtureSummary: {
          fixtureId: new BN(val.summary.fixtureId),
          updateStats: {
            updateCount: val.summary.updateStats.updateCount,
            minTimestamp: new BN(val.summary.updateStats.minTimestamp),
            maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
          },
          eventsSubTreeRoot: parseHash(val.summary.eventStatsSubTreeRoot),
        },
        fixtureProof: mapProof(val.subTreeProof as any),
        mainTreeProof: mapProof(val.mainTreeProof as any),
        eventStatRoot: parseHash(val.eventStatRoot),
        stats: val.statsToProve.map((s, i) => ({ stat: s, statProof: mapProof(val.statProofs[i] as any) })),
      };
      const result: boolean = await (program.methods as any)
        .validateStatV2(payload, built.condition.strategy)
        .accounts({ dailyScoresMerkleRoots: dailyScoresPda(targetTs, program.programId) })
        .preInstructions([cu])
        .view();
      check(claim.name, result === claim.expectOnChain, `on-chain says ${result} (${built.condition.description})`);
    } catch (e) {
      check(claim.name, false, e instanceof Error ? e.message.slice(0, 160) : String(e));
    }
  }
}

async function h2BandProbe(client: TxlineClient): Promise<void> {
  console.log("— probe: is the 3000 band (true H2) in the provable stat set? —");
  try {
    const val = await client.statValidation(18218149, 1087, [3001, 3002]);
    console.log(`  stat-validation served 3000-band: ${JSON.stringify(val.statsToProve)}`);
  } catch (e) {
    console.log(`  3000-band NOT served: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function realPipeline(pool: pg.Pool, client: TxlineClient): Promise<void> {
  console.log("— REAL pipeline on the settled test position (mainnet broadcasts) —");
  const posRes = await pool.query(
    `SELECT p.id FROM positions p JOIN settlements s ON s.position_id = p.id
     WHERE p.status = 'settled' ORDER BY p.id DESC LIMIT 1`
  );
  if (!posRes.rows[0]) {
    check("real pipeline", false, "no settled position in DB (run validate-ledger first)");
    return;
  }
  const positionId = Number(posRes.rows[0].id);
  const conn = mainnetConnection();
  const agent = loadAgentKeypair();

  const commit = await commitPosition(pool, conn, agent, positionId);
  check(
    `commit position ${positionId}`,
    commit.status === "committed" || (commit.status === "skipped" && commit.reason === "already committed"),
    commit.status === "committed" ? `sig ${commit.sig.slice(0, 20)}... memo ${commit.memo.slice(0, 60)}...` : JSON.stringify(commit)
  );

  await pool.query(`DELETE FROM proofs WHERE position_id = $1`, [positionId]);
  const proof = await proveSettlement(pool, client, positionId);
  check(
    `prove position ${positionId}`,
    proof.status === "proven",
    proof.status === "proven"
      ? `result=${proof.result} keys=${proof.statKeys} sig ${proof.broadcastSig.slice(0, 20)}...`
      : proof.reason
  );
  if (proof.status === "proven") {
    console.log(`  commit tx: https://solscan.io/tx/${commit.status === "committed" ? commit.sig : "(prior)"}`);
    console.log(`  proof tx:  https://solscan.io/tx/${proof.broadcastSig}`);
  }
}

async function main() {
  conditionChecks();
  const client = new TxlineClient();
  await syntheticSpainProofs(client);
  await h2BandProbe(client);

  if (process.argv.includes("--broadcast")) {
    const testDb = process.env.CANDOR_TEST_DATABASE_URL;
    if (!testDb) {
      console.error(
        "--broadcast refused: set CANDOR_TEST_DATABASE_URL to a dedicated test database.\n" +
          "The real pipeline writes that database's commit chain tip and broadcasts real transactions."
      );
      process.exit(1);
    }
    const pool = new pg.Pool({ connectionString: testDb, max: 5 });
    await realPipeline(pool, client);
    await pool.end();
  } else {
    console.log("\n(read-only run; pass --broadcast with CANDOR_TEST_DATABASE_URL for the real pipeline)");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
