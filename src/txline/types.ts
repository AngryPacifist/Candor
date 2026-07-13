// TxLINE record shapes, per the API reference + live probes (Session 1).
// REST/stream JSON is PascalCase.

export interface Fixture {
  Ts: number;
  StartTime: number;
  Competition: string;
  CompetitionId: number;
  FixtureGroupId: number;
  Participant1Id: number;
  Participant1: string;
  Participant2Id: number;
  Participant2: string;
  FixtureId: number;
  Participant1IsHome: boolean;
}

export interface OddsRecord {
  FixtureId: number;
  MessageId: string;
  Ts: number;
  Bookmaker: string;
  BookmakerId: number;
  SuperOddsType: string; // 1X2_PARTICIPANT_RESULT | OVERUNDER_PARTICIPANT_GOALS | ASIANHANDICAP_PARTICIPANT_GOALS
  GameState: string | null;
  InRunning: boolean;
  MarketParameters: string | null; // e.g. "line=2.5"
  MarketPeriod: string | null; // null(full) | "half=1" | "et" | "penalties"
  PriceNames: string[];
  Prices: number[]; // decimal odds ×1000
  Pct: string[]; // implied % per price, "NA" on edge lines
}

export interface ScoreClock {
  Running: boolean;
  Seconds: number;
}

/** Per-period friendly score breakdown: Score.Participant1.Total.Goals etc. */
export type ScoreBreakdown = Record<
  string,
  Record<string, Record<string, number>>
>;

/**
 * Stat-key period bands, GOALS, AS OBSERVED ON THE LIVE FEED (game_finalised
 * records of two full recordings — this contradicts the docs' table):
 *   +1000 = H1 · +2000 = halftime CUMULATIVE (mirrors H1) · +3000 = H2
 * The docs claim +2000 = H2 and +3000 = ET1. Regulation = 1000-band + 3000-band.
 * Bands +4000..+7000 were all zero in both (no-ET) matches; their exact
 * semantics (ET/pens) are unverified — treat ET matches with care.
 */
export interface ScoreRecord {
  FixtureId: number;
  GameState: string;
  StartTime: number;
  CompetitionId?: number;
  SportId?: number;
  Participant1IsHome?: boolean;
  Participant1Id?: number;
  Participant2Id?: number;
  Action?: string;
  Id: number;
  Ts: number;
  Seq: number;
  StatusId?: number;
  Clock?: ScoreClock;
  Score?: ScoreBreakdown;
  Data?: Record<string, unknown>;
  Stats?: Record<string, number>; // encoded stat keys -> value
  Participant?: number;
  Possession?: number;
  PossessionType?: string;
  Confirmed?: boolean;
}

/** Soccer gameState/StatusId phases (api reference §5). */
export const Phase = {
  NotStarted: 1,
  H1: 2,
  HT: 3,
  H2: 4,
  Finished: 5,
  WaitingET: 6,
  ET1: 7,
  HTET: 8,
  ET2: 9,
  FinishedET: 10,
  WaitingPens: 11,
  Penalties: 12,
  FinishedPens: 13,
  Interrupted: 14,
  Abandoned: 15,
  Cancelled: 16,
  CoverageCancelled: 17,
  CoverageSuspended: 18,
  Postponed: 19,
  /** Settlement-grade final record (troubleshooting guide): action=game_finalised */
  GameFinalised: 100,
} as const;

export const IN_PLAY_PHASES: ReadonlySet<number> = new Set([
  Phase.H1,
  Phase.H2,
  Phase.ET1,
  Phase.ET2,
  Phase.Penalties,
]);

export interface StatValidationResponse {
  ts: number;
  statsToProve: { key: number; value: number; period: number }[];
  eventStatRoot: unknown;
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: unknown;
  };
  statProofs: { hash: unknown; isRightSibling: boolean }[][];
  subTreeProof: { hash: unknown; isRightSibling: boolean }[];
  mainTreeProof: { hash: unknown; isRightSibling: boolean }[];
}

/**
 * stat-validation-v3 response (Merkle multiproof; promoted to mainnet
 * 2026-07-13, shape pinned by live probe the same day). Mainnet serves hashes
 * as numeric byte arrays; devnet has served hex/base64 strings — parseHash
 * normalizes all three. Per-leaf statProof arrived EMPTY on every observed
 * case (the multiproof carries the paths) but is mapped defensively since the
 * IDL's StatLeaf requires the field. multiproof.indices is passed through
 * verbatim; its count can differ from the leaf count (observed 3 for 4).
 */
export interface StatValidationV3Response {
  ts: number;
  statsToProve: {
    stat: { key: number; value: number; period: number };
    statProof: { hash: unknown; isRightSibling: boolean }[];
  }[];
  eventStatRoot: unknown;
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: unknown;
  };
  multiproof: { hashes: { hash: unknown; isRightSibling: boolean }[]; indices: number[] };
  subTreeProof: { hash: unknown; isRightSibling: boolean }[];
  mainTreeProof: { hash: unknown; isRightSibling: boolean }[];
}
