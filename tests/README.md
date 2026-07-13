# Tests

The verification bar, runnable. Match recordings (`resources/replays/*.jsonl`) are
captured live by the operator and are not part of the repository; tests that need them
say so and skip or fail loudly without them.

| Test | Needs | What it proves |
|---|---|---|
| `determinism.ts` | recordings | Byte-identical decisions AND on-chain artifacts (canonical payloads, hashes, memo bodies, bankroll trajectory) in-process and cross-process; production-vs-harness grader parity; frozen-replay pins against the documented tuning results. |
| `validate-fairprice.ts` | recordings | The fair-price engine's noise floor: prices every fresh line against the demargined consensus across full recordings, reporting disagreement by market bucket. |
| `validate-signals.ts` | recordings | The signal stack end to end over recordings at the frozen params, with per-entry grading. |
| `validate-ledger.ts` | recordings + `CANDOR_TEST_DATABASE_URL` | The full production settlement path against known finals: fold, open, settle, cross-check grading, CLV, bankroll. **Destructive on its database** (deletes fixture rows, resets the bankroll), so it refuses to run without a dedicated test database (apply `npm run migrate` to it first). |
| `validate-proofs.ts` | `.env` (TxLINE + mainnet RPC) + funded wallet | Win-condition compilation (pure), then synthetic claims about a real final simulated on mainnet in both directions via free `.view()`s, plus the H2-band probe. `--broadcast` additionally runs the real commit + proof pipeline (two mainnet transactions) and requires `CANDOR_TEST_DATABASE_URL`. |

Run any of them with `npx tsx tests/<name>.ts`.
