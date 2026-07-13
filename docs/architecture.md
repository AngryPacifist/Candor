# Architecture: one writer, one truth, no hands

The system around the trust layer: processes, data model, timers, failure behavior, and
the operational rules that keep an autonomous mainnet-writing agent boring. Companions:
[`trust-layer.md`](trust-layer.md), [`txline-integration.md`](txline-integration.md),
[`how-candor-trades.md`](how-candor-trades.md).

## 1. Topology

```
TxLINE mainnet (scores SSE + odds SSE + REST)
        │
        ▼
┌──────────────────────────────┐        ┌─────────────────────────────┐
│ worker (Node, Railway)       │        │ dashboard (Next.js, Railway)│
│ ingest · model · signals ·   │──────▶ │ read-only Postgres role     │
│ ledger · commits · proofs    │  Neon  │ candor.website              │
└──────────────────────────────┘        └─────────────────────────────┘
        │
        ▼
Solana mainnet (SPL Memo commits + roots · txoracle validate_stat_v2)
```

Three invariants the deployment enforces:

1. **Exactly one writer.** The Railway worker is the only process that writes the
   database or signs transactions. At deploy cutover the local worker's process tree is
   killed and verified dead (heartbeat continuity from the cloud proves the swap); it
   stays dead.
2. **The public surface cannot write.** The dashboard connects as `candor_reader`, a
   `SELECT`-only role (verified live in `pg_stat_activity`), so a compromised or buggy
   web tier cannot touch the record.
3. **Parameters are frozen; code changes are visible.** The strategy object is hashed
   into every commit and ceremony-anchored. A bugfix deploy is legitimate and shows as an
   epoch in the commit stream; a parameter change would show as a different hash and is
   forbidden mid-run.

## 2. The worker

### Bootstrap ([`src/worker/main.ts`](../src/worker/main.ts))

Ordered so that no configuration problem can produce a silent crash loop:

1. Imports only Node builtins plus dotenv (nothing that can throw at import time).
2. **Binds the health port first** (`$PORT`, `/health`), because platform health checks
   need an answer even while the app is still validating.
3. Validates the environment with **named** errors: each missing variable is a readable
   `FATAL` log line, and the keypair (`AGENT_KEYPAIR_JSON` on hosted platforms,
   `AGENT_KEYPAIR_PATH` locally) is shape-checked (a 64-number array) before anything
   loads.
4. Only then dynamically imports and starts the real worker; the health endpoint flips
   from `booting` to `live` with a state snapshot provider.

Uncaught exceptions and unhandled rejections log a `FATAL` stack and exit: the platform
restarts the process, and warmup makes restarts safe.

### Runtime loops ([`src/worker/run.ts`](../src/worker/run.ts))

| Cadence | Loop |
|---|---|
| continuous | both SSE streams: scores into a strictly serialized fold queue, odds into the batch buffer, every record also fed to the in-memory engine |
| 1s | odds buffer flush (history append + coalesced latest upsert) |
| 5s | `evaluateAll()`: the trading evaluation across live fixtures |
| 10m | fixture discovery sync (new fixtures appear automatically) |
| 2m | commit retry sweep (`commit_status = failed`) |
| 5m | proof retry sweep (transient failures, 24h window) |
| 30m + boot | daily decisions-root sweep for the previous UTC day |
| 30s | status line + heartbeat upsert (`agent_state.worker_heartbeat`: counters, params hash, wallet lamports, stale-position alarm); every 10th tick refreshes the wallet balance and warns below 0.003 SOL |

Shutdown (SIGINT/SIGTERM) aborts the streams, stops the timers, drains the scores queue,
flushes the odds buffer, and closes the pool.

### The engine ([`src/worker/engine.ts`](../src/worker/engine.ts))

The live engine is deliberately the **semantic twin of the replay harness**
([`src/replay/simulate.ts`](../src/replay/simulate.ts)): same gates, same honest-fill
rule, same stream-time clock, so replay evidence transfers to live behavior and the
determinism suite can hold both to the same digests.

Per fixture it keeps a small live state (latest line per market, phase, clock, scores,
last-goal timestamp, last-data timestamp, lifecycle flags). Evaluation, every five
seconds per live fixture:

1. **Phase gates**: only status ids 2 and 4 (open play of regulation), no new entries
   after 85:00 of match clock, first-half markets only while the first half is live.
2. **Fit**: the fair-price engine fits from the current scope's lines at stream time; the
   fit must pass quality gates (enough totals lines, anchor residual bound).
3. **Family selection**: if a movement trigger is armed (a z-score jump on some line
   within its window), the scan runs as `movement` and only considers lines re-quoted
   after the trigger, never the jumped line itself; otherwise `divergence`.
4. **Honest fill**: a candidate's quote must postdate the last goal (`minQuoteTs`), so
   the agent can never "fill" on a price from before the world changed.
5. **Cooldowns**: one entry per line and side per 10 minutes, keyed per fixture,
   rebuilt from the database on restart so a reboot cannot double-enter.
6. **Sizing then exposure**: quarter-Kelly capped at 2% of bankroll with a minimum-stake
   floor; then the ledger's exposure gates (max 4 concurrent positions, 2 per match, 6
   per match lifetime). Failing either logs an explicit `pass` signal with the reason.
7. **Entry**: ledger opens the position (canonical payload + hash at open), the signal
   log records `enter` with the full reasoning, and the hash-chained mainnet commit fires
   asynchronously so the trading path never waits on the chain.

Settlement is event-driven: the finalisation marker on the scores stream schedules
`settleAndProve` (30-second grace for the fold and flush to land, then up to five
attempts), which settles all open positions from the certified bands, then proves them
sequentially with a polite gap between broadcasts. Abandoned, cancelled,
coverage-cancelled, and postponed matches (status ids 15/16/17/19) void open positions
instead, stakes returned, with an explicit terminal proof state.

Two watchdogs guard the gaps: the **stale-open alarm** (an open position whose fixture
started over four hours ago and whose state stopped updating means coverage died before
finalisation; it screams in the log and the heartbeat) and the **liveness watchdog**
inside the stream client (reconnect after 90 seconds of silence).

### Warmup (restart safety)

On boot the engine replays the scores and odds snapshots for every fixture starting
within a −6h/+36h window through the same code paths as live records, and rebuilds
recent cooldowns from the positions table. A restart mid-match rejoins with correct
state; a restart after a missed finalisation is idempotent (settlement re-checks find
zero open positions and do nothing), which was exercised on the first cloud deploy.

## 3. The data model ([`src/db/schema.sql`](../src/db/schema.sql))

| Table | Holds | Notes |
|---|---|---|
| `fixtures` | discovery snapshot | stubs are auto-created for stream records that precede discovery, then overwritten |
| `match_state` | one row per fixture: phase, clock, score, **stat bands**, `finalised_seq` | upsert guarded by `last_seq`; stats fold latest-value (VAR) |
| `odds_latest` | newest quote per market line | PK is the full line identity; `ts`-guarded upsert |
| `odds_history` | every tick, append-only | movement windows and CLV horizon quotes read this |
| `signals` | every decision, `enter` and `pass`, with reason and model inputs | leaves of the daily Merkle root |
| `positions` | the ledger: entry facts + `payload_canonical`, `payload_hash`, `params_hash`, commit chain fields | `commit_status`: pending / committed / failed |
| `settlements` | outcome, P&L, `bankroll_after`, CLV at the frozen horizon, evidence JSON | bankroll moves only here |
| `proofs` | every proof attempt: status, stat keys, strategy JSON, result, signature or error | full history kept; latest row is the position's proof state |
| `agent_state` | key-value: bankroll, chain tips, freeze record, daily roots, heartbeat | the attestation strip reads this |

## 4. The dashboard

Next.js 15, dark-only, server-rendered from the reader role on every request
(`force-dynamic`), auto-refreshing. Pages: overview (the hero record band and attestation
column), positions (the ledger with expandable per-position receipts and the in-browser
verifier), signals (the reasoning timeline with the daily roots interleaved), metrics
(bankroll step curve, CLV per position, calibration, exposure), verify (the audit
procedure), and `/api/record` (the export). The attestation strip on every page carries
the frozen hash, ceremony link, chain tip, proof score, and export link. Design tokens
and rules live in `branding/` (Oath Steel; elevation by background step, one accent,
mono numerals).

## 5. Deployment

Two Railway services from this repository plus a Neon Postgres:

- **worker**: start `npm run worker`, health check `/health`, teardown on redeploy
  (Railway injects `PORT`). Environment: the TxLINE credentials, mainnet RPC,
  `AGENT_KEYPAIR_JSON`, and the **owner** database string.
- **dashboard**: standard Next build, `DATABASE_URL` set to the **reader** role string
  (`scripts` in the repo include the role DDL).

Deploy discipline learned the hard way and now written down: read the deploy logs (not
the build logs) when a service fails; never call a green container "working" without the
health check on; and treat the cutover to a new writer as a verified handoff, not an
assumption.

## 6. Determinism and tests

[`tests/determinism.ts`](../tests/determinism.ts) is the rubric's "deterministic,
defensible logic" made executable, over full recorded matches (recordings are captured
live by the operator and are not part of the repository):

- in-process and cross-process **byte-identical digests** covering every decision and
  every accountability artifact (canonical payloads, hashes, commit memo bodies, bankroll
  trajectory), via the same pure builders production uses;
- **grader parity**: the production settlement grader must agree with the replay grader
  on every entry;
- **frozen-replay pins**: the frozen parameters must keep reproducing the documented
  tuning results, including the two entries the live agent actually took.

Alongside: the fair-price validation harness (noise-floor measurement), settlement
asserts against known finals, seven on-chain claim simulations run in both directions
before the proof layer was trusted, and the in-browser verifier as the always-on,
user-facing test.

## 7. Failure modes, by design

| Failure | Behavior | Visible as |
|---|---|---|
| Stream drop | reconnect with capped backoff; at-least-once + dedupe | `disconnects` counter in the heartbeat |
| Commit broadcast fails | position marked `failed`, retried every 2m | `commit failed` badge until it lands |
| Proof 404 (anchoring lag) | retried every 5m for 24h | `proof unavailable` then `proven (retry)` |
| Simulated proof ≠ settlement | broadcast blocked | `proof_unavailable` with the mismatch reason |
| Match abandoned/cancelled | stakes returned | `void` outcome + terminal proof state |
| Extra time on a full-match market | regulation components certified instead | proof row with the 4-leg strategy |
| Coverage dies mid-match | stale-open alarm | heartbeat `staleOpenPositions` > 0 |
| Wallet running low | warning under 0.003 SOL | log + heartbeat `walletLamports` |
| Worker crash/restart | warmup re-joins from snapshots; settlements idempotent | boot log, heartbeat counters reset |

The theme is the same everywhere: nothing degrades silently, and every degraded state has
a name the public record shows.
