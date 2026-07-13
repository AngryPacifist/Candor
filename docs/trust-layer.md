# The trust layer: how Candor's record is made unfakeable

This is the complete specification of Candor's accountability protocol: every artifact it
puts on Solana mainnet, the exact bytes in each, how they chain together, and how a third
party checks any of it without trusting this repository, the dashboard, or its operator.
Companions: [`architecture.md`](architecture.md) (the system around this layer),
[`txline-integration.md`](txline-integration.md) (the data and proofs it consumes),
[`how-candor-trades.md`](how-candor-trades.md) (the strategy being held accountable).

The problem being solved: **self-reported track records are worthless.** Anyone can
screenshot winners, delete losers, or backdate picks. Candor is built so that the four
ways a record can lie (invent wins, hide losses, backdate decisions, move the goalposts)
are each closed by a separate on-chain mechanism:

| Way to lie | Closed by |
|---|---|
| Backdate a pick | commit-at-decision: the payload hash is on mainnet before the outcome exists |
| Delete a loser | the hash chain: every commit names its predecessor, so a gap is visible |
| Misreport an outcome | settlement proofs: `validate_stat_v2` certifies the win condition against TxODDS's root |
| Tune the strategy after the fact | the frozen-params hash in every commit, anchored by the freeze ceremony |
| Curate the narrative | daily Merkle roots over the complete signal log, passes included |

Everything below is implemented in [`src/chain/`](../src/chain/),
[`src/ledger/ledger.ts`](../src/ledger/ledger.ts), and
[`src/lib/canonical.ts`](../src/lib/canonical.ts).

## 0. Canonical serialization

Every hash in the protocol is `sha256` (hex, lowercase) over a **canonical JSON** string
produced by one function used everywhere ([`src/lib/canonical.ts`](../src/lib/canonical.ts)):

- object keys sorted lexicographically, recursively;
- `undefined`-valued keys dropped;
- arrays kept in order;
- no whitespace; UTF-8 input to the hash.

One serializer for position payloads, the strategy parameters, and signal leaves means a
verifier reimplements exactly one rule.

## 1. Commit at decision time

### The payload

The moment the ledger opens a position, it canonicalizes this object
(schema `candor.position.v1`, built in [`buildPositionPayload`](../src/ledger/ledger.ts)):

| Field | Meaning |
|---|---|
| `schema` | `"candor.position.v1"` |
| `fixtureId` | TxLINE fixture id |
| `marketKey` | the exact line: `type\|period\|params`, e.g. `OVERUNDER_PARTICIPANT_GOALS\|half=1\|line=1.5` |
| `scope` | `full` or `half1` |
| `side` | `over` / `under` / `part1` / `part2` / `draw` |
| `family` | `divergence` or `movement` (which signal family entered) |
| `priceTaken` | decimal odds at entry |
| `modelProb`, `marketProb` | the agent's fair probability and the demargined consensus, rounded to 6 decimals |
| `stakeUnits` | paper units staked |
| `bankrollBefore` | bankroll at open (bankroll only moves on settlement) |
| `entryGoals1`, `entryGoals2` | the score in scope at decision time (Asian handicap grades on goals after entry) |
| `decidedTs` | the stream-time timestamp of the decision (deterministic clock, not wall time) |
| `paramsHash` | the full sha256 of the frozen strategy parameters |

`payload_hash = sha256(canonicalJson(payload))`. Both the canonical string and the hash
are stored in the `positions` row and served verbatim by the record export, so anyone can
re-derive the hash.

### The memo

[`src/chain/commit.ts`](../src/chain/commit.ts) broadcasts one SPL Memo transaction per
position, signed by the agent wallet:

```
candor|v1|commit|<payload_hash>|params:<first 16 chars of paramsHash>|prev:<previous commit signature | "genesis">
```

A real one, position #3's commit (verify it on
[Solscan](https://solscan.io/tx/nZcN8aen5RsfpdEKYyTJHDRdGsKY7a9gACFPDsyRat5BAPmC63R86UQXQ5XmkBE9nN25sbvRFgyqCn3Tru2wMXp)):

```
candor|v1|commit|e51d400d24bc2591bef5b04bf510971c7cc5dc251c225af5a595bdb1a4064436|params:e8d0d4b6f761e75c|prev:2Zyw4jsXbQRQLywfMDmybGzCktrXb6EHuPdhCZPhu8xQcMFDegoovZGGDAzdmQ7Pwv4ZmvhtxYV1BgtsFnzgUiD4
```

Implementation guarantees, each load-bearing:

- **Strict serialization.** Commits go through an in-process chain lock, so `prev` links
  are linear even when several positions open in the same second.
- **The chain tip lives in the database** (`agent_state.last_commit_sig`) and each new
  memo carries it, so the chain survives restarts.
- **Retries with honest failure.** Three attempts with backoff; a position whose commit
  cannot land is marked `commit_status = failed`, shown publicly, and retried by a sweep
  every two minutes until it lands. There is no silent path.
- **Cost.** A signed memo needs ~140k compute units (signature verification is the
  expensive part); at the configured priority fee a commit costs roughly 8,000 lamports.

### What a verifier concludes

The transaction's block time is a lower bound on when the decision existed; the memo's
hash binds the full decision content; `prev` makes the sequence append-only. To audit the
whole record: walk the agent wallet's memo transactions, check each `prev` names the
previous commit, and check every `payload_hash` appears in the record export with a
payload that re-hashes to it. A deleted position breaks the walk; an invented one has no
pre-outcome timestamp.

## 2. The freeze ceremony

The complete strategy configuration lives in one frozen object
([`src/strategy/params.ts`](../src/strategy/params.ts)); its canonical hash is
`e8d0d4b6f761e75ceecdb8d7f0ea321d27f188d39db2ba3763f65c776d4842d8`. Before deployment,
the freeze itself was committed to mainnet
([`3xmdHkBG…`](https://solscan.io/tx/3xmdHkBGzghmi11ffuLSZfvgrdm7WezSZvA21qtub9nim9HN63vXDFixHALZyk1yfFqguYBpykM7V2XW3mniZfmB)):

```
candor|v1|freeze|candor-params-v1|params:<full 64-char hash>
```

Every subsequent position commit carries the first 16 characters of that hash. The claim
this construction makes precise: **any position committed after the ceremony was decided
by exactly the parameters the ceremony froze.** Changing a threshold changes the hash,
and the seam would be public. Code may still be fixed mid-run (a deploy is visible as an
epoch in the commit stream); parameters may not, and were not. How the values were
derived, dead ends included, is [`params-tuning.md`](params-tuning.md).

## 3. Settlement, from certified bands only

Settlement ([`Ledger.settleFixture`](../src/ledger/ledger.ts)) runs when the scores
stream delivers the finalisation marker (`action=game_finalised` / `statusId=100`, the
settlement-grade record per TxODDS guidance):

- **Regulation goals are computed from the period bands**, not the base totals: full
  match = the `+1000` band (first half) plus the `+3000` band (second half); first-half
  markets use the `+1000` band alone. This matters because the base total keys include
  extra-time goals, and because the documented band table is wrong (see
  [`txline-integration.md`](txline-integration.md) for the evidence).
- **A cross-check is recorded**: `totalsAgree` (base totals equal the band sum) is stored
  in the settlement evidence; disagreement is the extra-time signature.
- **Asian handicap grades on the remaining-goals convention** (goals after entry), which
  is what in-running AH lines actually mean in this feed, established empirically.
- **Every settlement stores its evidence**: finalised sequence number, the regulation
  component scores, which bands were used, and the totals cross-check, as JSON in the
  `settlements` row, served by the export.
- **CLV is measured at a fixed horizon**: the line's demargined probability ten minutes
  after the decision versus the entry probability. An in-play line's last quote converges
  to the outcome, so a conventional "closing line" would just restate the result. The
  horizon quote must pass a vig sanity filter (probabilities summing to 90 to 110 before
  demargining) and line-death empty ticks are excluded; if no valid quote exists the CLV
  is honestly `null`.
- **Voids return stakes.** Abandoned, cancelled, coverage-cancelled, or postponed matches
  (status ids 15, 16, 17, 19) void all open positions: outcome `void`, zero P&L, reason
  recorded, and a `proof_unavailable` row written so the position still terminates in an
  explicit proof state.

Bankroll moves only here: stakes are exposure, never spend, and every settlement records
`bankroll_after`, which is what the dashboard's step curve draws.

## 4. Prove at settlement

[`src/chain/proof.ts`](../src/chain/proof.ts) turns each settled position into an
on-chain certification. The design decision that makes the proofs meaningful: the program
is not asked "what was the score"; it is asked **the position's exact win condition**,
compiled into a `validate_stat_v2` strategy:

| Market | Stat keys | Compiled predicate |
|---|---|---|
| 1X2, home / away / draw | full: `1,2` · half: `1001,1002` | binary subtract `> 0` / `< 0` / `== 0` |
| Over/Under `line` | same | binary add `> line` (over) or `< line` (under); non-integer lines floor/ceil to the equivalent integer comparison; a push is proven as add `== line` |
| Asian handicap `line` | same | binary subtract against `c = entryGoals1 − entryGoals2 − line`: the committed entry score is folded into the threshold, so the on-chain claim matches the remaining-goals grading exactly |

The expected verdict is derived from the settlement: a won position expects `true`, a
lost one expects `false` (losses are proven with the same rigor as wins), a push expects
its equality claim to hold.

**Extra time gets an honest, stronger treatment instead of a fudge.** If the finalised
stats show extra-time markers (any `+4000` through `+7000` band nonzero) or the totals
cross-check fails, a full-match market cannot be proven via the base total keys (they
include ET goals). Instead the proof pins the exact regulation components with four
`equalTo` legs over keys `1001, 1002, 3001, 3002`: the chain certifies "H1 was a-b and H2
was c-d", and the market outcome follows from those certified numbers by public
arithmetic. This path was validated on mainnet against a real extra-time quarterfinal,
in both directions.

**Simulation must agree before anything is broadcast.** The compiled call is first run as
a free `.view()`; if the simulated verdict differs from the settlement expectation, the
broadcast is blocked and the position is marked `proof_unavailable` with the reason
`on-chain result X does not match settlement expectation Y`, because at that point either
the settlement or the claim is wrong and neither deserves a certificate. Only on
agreement is the real transaction sent (1,400,000 compute units, the measured requirement
for multi-leg validations).

**Every proof attempt is a row.** The `proofs` table keeps the full attempt history:
status (`proven` / `proof_unavailable`), the stat keys, the target timestamp, the exact
strategy JSON sent on-chain, the on-chain result, the broadcast signature, or the error.
The dashboard shows the latest state; the export shows it with the strategy.

**The anchoring lag is handled by retry, visibly.** TxODDS anchors score batches in
windows, so `stat-validation` 404s for a freshly finalised record (observed on the
agent's first live settlement). A sweep every five minutes retries positions settled in
the last 24 hours whose latest proof failure looks transient (404, 5xx, 429, network,
timeout, blockhash); structural reasons are final. Position #4's proof landed exactly this
way, autonomously, five minutes after settlement.

## 5. The daily decisions root

Positions prove what the agent did; the decisions root proves what it considered.
[`src/chain/decisions-root.ts`](../src/chain/decisions-root.ts), once per completed UTC
day:

- **Leaf**: `sha256(canonicalJson({id, ts, fixtureId, family, marketKey, side, edge,
  decision, reason}))` for every signal logged that day, entries and passes alike, in id
  order. `ts` is the ISO-8601 string; `edge` is numeric or null.
- **Tree**: pair adjacent nodes, `sha256(left + right)` over the hex strings, duplicating
  the last node on odd levels; the root of the empty log is `sha256("")`.
- **Memo**, chained like commits through `agent_state.last_decisions_sig`:

```
candor|v1|decisions|<YYYY-MM-DD>|root:<64-char root>|n:<leaf count>|prev:<previous root signature | "genesis">
```

The record export serves every signal with exactly the leaf fields, so a third party
recomputes the root with thirty lines of code. Editing, deleting, or inserting a signal
after the day closes changes the root and contradicts the chain.

## 6. The record export and the in-browser verifier

[`GET /api/record`](https://candor.website/api/record) is the machine-readable ground
truth (`candor.record.v1`): every position with its canonical payload string, payload
hash, params hash, both chain signatures and the proof history fields, settlement
evidence, CLV; the complete signal log; and the agent state (chain tips, freeze, daily
roots, heartbeat). It is served by the read-only dashboard but trusts nothing from it:
each claim in the export is checkable against the chain or recomputable, which is the
entire design.

The dashboard's per-position **Verify** button runs the audit in the visitor's own
browser: fetch the export, recompute the sha256 with WebCrypto, fetch the commit
transaction from a public Solana RPC (this site deliberately absent from its own trust
path), and check the memo carries the recomputed hash and the chain link.

## 7. Live artifacts (the record's own receipts)

| Artifact | Transaction |
|---|---|
| Freeze ceremony (`candor-params-v1`, full hash) | [`3xmdHkBG…`](https://solscan.io/tx/3xmdHkBGzghmi11ffuLSZfvgrdm7WezSZvA21qtub9nim9HN63vXDFixHALZyk1yfFqguYBpykM7V2XW3mniZfmB) |
| Position #3 commit (pre-outcome, World Cup QF) | [`nZcN8aen…`](https://solscan.io/tx/nZcN8aen5RsfpdEKYyTJHDRdGsKY7a9gACFPDsyRat5BAPmC63R86UQXQ5XmkBE9nN25sbvRFgyqCn3Tru2wMXp) |
| Position #3 proof (`result=true`) | [`BA7FsisU…`](https://solscan.io/tx/BA7FsisUkUDV3bRnRvVGXRcNAxUNGAYdBzRLWd3tuAL6jZNpGbq3jjR6nq2LLbtb866vG14chvDWxjNqFkPekx3) |
| Position #4 commit (one minute after kickoff) | [`43P8YQpf…`](https://solscan.io/tx/43P8YQpfANktVPWrkFYfHAYCTSwX62jw1twjis4sB9aLPoM5fATYGKRSDGckV6LiX7zRMM62BHxgXFGmJctN4QJD) |
| Position #4 proof (self-healed via the retry sweep) | [`21tPRJdm…`](https://solscan.io/tx/21tPRJdmUFfkYZhKRASW5LuQPWDos2LveKpDPaHxuu5giF7eaj6wjqm7637WoGi8wWm4GDpRPX7feuEVfRH8w3uS) |
| First daily decisions root (2026-07-11, n=1) | [`3UBFfGzN…`](https://solscan.io/tx/3UBFfGzNuNMjRoYQQPKwZDbyJEsWtKzeQYrqftD4ax5jHnCAmcvji5UJXUezVwn5MKWC6Mwbjv7NYDfmVJTpD5Pi) |

Agent wallet:
[`DKdqzAhvYMB3TZFZSM7M6JA3nQqmsjk5W9Smo6vq7xrE`](https://solscan.io/account/DKdqzAhvYMB3TZFZSM7M6JA3nQqmsjk5W9Smo6vq7xrE) ·
oracle program:
[`9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`](https://solscan.io/account/9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA).

## 8. Threat model, honestly

What the protocol does **not** claim, stated so the claim it does make stays sharp:

- **It cannot prove a decision was made by the model** rather than a human whispering to
  the process. It proves when the decision existed and that the frozen parameters signed
  it; determinism ([`tests/determinism.ts`](../tests/determinism.ts)) plus the public
  code make "a human picked this" an expensive lie to maintain, but the cryptographic
  claim is about time, content, and completeness.
- **Match truth is TxODDS's root.** The proofs certify claims against the roots TxODDS
  anchors; if the oracle's data were wrong, the proofs would be faithfully wrong with it.
  That trust is explicit, singular, and inspectable on-chain.
- **Omission before commitment.** A position whose commit never landed would be visible
  as `commit_status = failed` in the export and as a hole against the signal log and its
  daily root; the window for quiet omission is the commit retry window, and it leaves
  tracks in the reasoning trail.

Within those boundaries the record is what it claims: timestamped before outcomes,
append-only, outcome-certified, parameter-bound, and narrative-sealed.
