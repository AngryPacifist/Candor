# TxLINE integration: every surface, every finding

How Candor consumes TxLINE, endpoint by endpoint, with the operational behavior we
measured live and the discoveries that shaped the build. Everything here was established
empirically during the event and is implemented in
[`src/txline/client.ts`](../src/txline/client.ts), [`src/ingest/`](../src/ingest/), and
[`src/chain/`](../src/chain/). Companions: [`trust-layer.md`](trust-layer.md),
[`architecture.md`](architecture.md).

## 1. Access and authentication

Candor runs on the TxLINE mainnet **World Cup real-time tier** (the documented free tiers
for the event: service level 1 is 60-second delayed, service level 12 is real-time; both
cover World Cup and International Friendlies). Access comes from the standard flow: an
on-chain `subscribe` transaction from the agent wallet, then a wallet-signed activation
(`POST /api/token/activate`) that issues the long-lived API token.

Every request carries two credentials:

```
Authorization: Bearer <guest session JWT>
X-Api-Token: <activated long-lived token>
```

The client treats the JWT as disposable: it decodes the expiry from the token itself,
re-issues via `POST /auth/guest/start` whenever less than a day remains, and on any 401
forces one re-issue and retries the request once. The worker never needs a human for
auth.

## 2. REST surfaces

| Endpoint | Used for | Notes from production |
|---|---|---|
| `GET /api/fixtures/snapshot?epochDay=` | fixture discovery, every 10 minutes | Returns fixtures well beyond the documented 30-day window (harmless). Fields carry no round/stage metadata; `FixtureGroupId` is typed but undescribed (feedback item 14). New knockout fixtures appear automatically as TxODDS publishes them. |
| `GET /api/scores/snapshot/{fixtureId}` | restart warmup; recorder seeding | Full record history for the fixture; replayed through the same fold as the stream. |
| `GET /api/odds/snapshot/{fixtureId}` | restart warmup | Latest state per market line. |
| `GET /api/scores/stat-validation-v3?fixtureId=&seq=&statKeys=` | Merkle **multiproof** payloads, the primary settlement-proof source since its 2026-07-13 mainnet promotion | Same query shape as V2; response carries `statsToProve[{stat, statProof}]` plus one shared `multiproof`. 404s while anchoring, like V2. |
| `GET /api/scores/stat-validation?fixtureId=&seq=&statKeys=` | Merkle proof payloads for the `validate_stat_v2` fallback path | `seq` must be the `game_finalised` sequence (sequences start at 1). 404s while the batch is still anchoring; see §5. |
| `POST /auth/guest/start` | JWT issue and re-issue | No credentials needed; the JWT alone is not data access. |

## 3. The two firehoses

`GET /api/scores/stream` and `GET /api/odds/stream`, both SSE. Measured operational
profile (live, across four recorded matches and two weeks of running):

- **Encoding**: `content-encoding: deflate` in practice (the docs suggest gzip; standard
  clients handle both transparently).
- **Heartbeats**: `event: heartbeat` roughly every 20 seconds. The client counts any
  traffic as liveness and reconnects after 90 seconds of silence, checked every 5
  seconds.
- **Drops are routine, not exceptional**: 4 disconnects in one two-hour evening on our
  worker, 7 in under an hour on a second client the same night. Reconnect uses capped
  exponential backoff (1s doubling to 30s). There is no documented resume cursor
  (feedback item 8), so a reconnect can duplicate or drop records; consumers must treat
  the streams as at-least-once.
- **Dedupe keys that work**: scores by `(FixtureId, Id, Seq)`, odds by `MessageId`.
- **Pre-match odds flow** on the stream well before kickoff with `InRunning: false`,
  which is what makes closing-line capture possible at all.

Ingest discipline downstream of the streams
([`src/ingest/scores.ts`](../src/ingest/scores.ts),
[`src/ingest/odds.ts`](../src/ingest/odds.ts)):

- **Scores fold strictly by sequence.** One serialized queue; the `match_state` upsert is
  guarded by `last_seq` so a stale record can never regress state, and `COALESCE` keeps
  fields a record does not carry.
- **Stats fold latest-value, never monotonically.** A VAR-disallowed goal really does
  roll the stat bands back minutes later (observed live, 54' goal retracted at 57'); any
  consumer folding stats as monotonic counters corrupts on VAR.
- **Odds are buffered and batch-flushed** once per second: live matches burst to the
  order of 200 ticks per second, far beyond per-tick database round-trips. Every tick
  appends to `odds_history` (movement detection, CLV horizon quotes); `odds_latest` gets
  one coalesced upsert per line, newest timestamp wins, guarded server-side too.

## 4. The odds records themselves

Per record: `SuperOddsType` (1X2, over/under, Asian handicap), `MarketPeriod` (null for
full match, `half=1`, `et`, `penalties`), `MarketParameters` (`line=2.5`), `PriceNames`
and `Prices` (decimal odds ×1000), and `Pct`: the **demargined consensus probabilities**,
the input Candor actually trades on. Two structural facts that shaped the strategy layer:

- **Quarter lines never carry probabilities** (`Pct: ["NA","NA"]` across ~72k recorded
  ticks), so they can never be signal targets; the model prices them anyway from adjacent
  lines but does not trade them (feedback item 7).
- **In-running Asian handicap lines are remaining-goals handicaps**, not full-match
  margins. Evidence: Spain leading 2-1 late, `line=-0.5`, demargined home probability
  0.177: nonsensical under a full-match reading (the side was already covering), exact
  under a remaining-goals reading. The two conventions coincide at level scores, which is
  why the difference is invisible in most testing and catastrophic in production
  settlement (feedback item 6). Candor prices, grades, and proves AH on remaining goals.

## 5. Validation payloads and the on-chain programs

Settlement proofs consume `stat-validation-v3` (primary) or `stat-validation`
(fallback) and feed `validate_stat_v3` / `validate_stat_v2` on the oracle program
`9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`
(details of what is proven and the fallback rules: [`trust-layer.md`](trust-layer.md) §4).

The payload anatomy, as consumed by [`src/chain/proof.ts`](../src/chain/proof.ts):

- `summary.updateStats.minTimestamp` is the **`targetTs`** for the whole call and derives
  the PDA: `epochDay = floor(targetTs / 86_400_000)`, seeds
  `["daily_scores_roots", u16 LE epochDay]`. Getting this wrong produces
  `AccountNotFound`; the official examples now confirm the convention.
- `eventStatRoot` is shared at payload level; each requested stat arrives in
  `statsToProve[i]` with its own proof in `statProofs[i]`; `subTreeProof` and
  `mainTreeProof` complete the path to the daily root.
- **Hashes arrive in mixed encodings** (numeric byte arrays observed on both mainnet
  endpoints, V2 and V3 alike; TxODDS's own V3 example additionally defends against hex
  and base64 strings), so the parser normalizes all three defensively (feedback item 13).
- **Compute**: multi-leg validations need the full **1,400,000 CU** limit; the older
  400k guidance starves them. Signed memos need ~140k CU. `.view()` simulations fail
  with an unhelpful `AccountNotFound` when the fee payer holds zero lamports, so even
  free simulations need a funded wallet (feedback item 10).
- **Timing has three separate moments**: the final whistle, then the `game_finalised`
  record several minutes later (~7 minutes in our two measurements), then anchoring of
  the Merkle batch, before which `stat-validation` returns a bare 404 indistinguishable
  from "never provable" (feedback item 12). The worker settles at `game_finalised` and
  lets the proof retry sweep absorb the anchoring window; its first live proof healed
  itself exactly this way.

## 6. The period-band table, corrected

The single most settlement-critical finding: **the documented soccer stat-key period
table does not match the live feed.** From the `game_finalised` records of four fully
recorded matches, including one that went to extra time:

| Band | Docs say | The feed actually emits |
|---|---|---|
| `+1000` | first half | first half ✓ |
| `+2000` | second half | **halftime cumulative** (mirrors `+1000`) |
| `+3000` | first ET period | **second half** |
| `+4000` | second ET period | **first ET period** |
| `+7000` | (unlisted) | **ET cumulative** |
| base `1, 2` | full match | full match **including extra time** |

Consequences Candor implements: regulation = `+1000` band plus `+3000` band, cross-checked
against the base totals (they agree exactly when no extra time occurred); first-half
markets use `+1000` alone; full-match proofs on ET matches switch to regulation-component
certification because the base totals include ET goals. Evidence: Spain 2-1 (H1 1-1)
emitted `2002=1` where the documented table requires 0; the ET quarterfinal's 92.6-minute
goal ticked `+4000` and `+7000` while `+3000` stayed frozen at the H2 value
(feedback item 11). Anyone settling from the documented table silently corrupts every
match where the halves differ.

## 7. The V3 path: rehearsed, promoted, adopted

TxODDS shipped `validate_stat_v3` (multiproof: shared `leaves`, `leafIndices`,
`multiproofHashes`) mid-event, devnet-first. Candor rehearsed the full flow end to end
on devnet with the same agent wallet on July 12 (`scripts/v3-devnet-rehearsal.ts`, not
shipped in the repo): free-tier `subscribe(1, 4)`, wallet-signed activation, the
official reference case reproduced, our true case passing and false case rejected
on-chain, and one real broadcast.

On 2026-07-13 TxODDS promoted the endpoint to the mainnet cluster (announced on
Discord; the docs still listed V2 only at the time). The same-day probe confirmed the
endpoint serves under our existing token and the deployed program executes
`validate_stat_v3`, then simulated every comparison × operator combination the
win-condition compiler can emit — binary add/subtract with greater/less/equal, single
`equalTo`, and the 4-leg extra-time component shape — through **both** methods, true
and false directions, all agreeing. The proof layer adopted V3 as primary the same day,
with V2 as the automatic fallback and the method recorded on every proof row.

Shape notes from the mainnet probe: hashes arrive as numeric byte arrays; per-leaf
`statProof` arrives empty (the multiproof carries the paths) but is mapped defensively;
`multiproof.indices` can count fewer entries than the leaves (observed 3 for 4) and is
passed through verbatim — the API and program are a matched pair and Candor never
interprets the indices.

## 8. Findings, mapped

Each finding above is written up with full evidence in the feedback report curated for
the submission: item 6 (AH semantics), 7 (quarter-line `Pct`), 8 (SSE operational
details), 9 (snapshot window), 10 (validation ergonomics and CU), 11 (period bands),
12 (finalisation and anchoring lag), 13 (hash encodings), 14 (no round/stage metadata),
plus the release-visibility items (1 through 5) from the mid-event v1.5.6 forensics.
