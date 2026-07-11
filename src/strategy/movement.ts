// Signal family B: sharp movement.
// The StablePrice consensus aggregates the sharp market; a JUMP on one line is
// information arriving (goal threat, red card, sharp money). Correlated lines
// of the same fixture do not reprice in the same instant. So: detect the jump
// statistically (z-score of the latest move vs the line's own recent
// tick-to-tick distribution), then ARM the fixture for a short window during
// which the divergence scanner (fed by a fresh post-jump fit) is run with the
// "movement" tag — entries land on the lagging lines, not the line that moved.

import type { ParsedLine } from "../model/markets.js";
import type { StrategyParams } from "./params.js";

interface Tick {
  ts: number;
  /** reference probability of the line's first outcome */
  prob: number;
}

export interface Jump {
  fixtureId: number;
  lineKey: string;
  ts: number;
  movePts: number;
  z: number;
}

export class MovementDetector {
  private history = new Map<string, Tick[]>();
  private armedUntil = new Map<number, { until: number; trigger: Jump }>();

  constructor(private params: StrategyParams) {}

  /** Feed every parsed odds tick. Returns a Jump when this tick qualifies. */
  addTick(fixtureId: number, line: ParsedLine): Jump | null {
    if (line.probs === null) return null;
    const first = Object.keys(line.probs)[0];
    if (first === undefined) return null;
    const prob = line.probs[first]!;
    const key = `${fixtureId}|${line.key}`;
    const p = this.params.movement;

    let ticks = this.history.get(key);
    if (!ticks) {
      ticks = [];
      this.history.set(key, ticks);
    }
    const prev = ticks[ticks.length - 1];
    ticks.push({ ts: line.ts, prob });
    while (ticks.length > 0 && line.ts - ticks[0]!.ts > p.windowMs) ticks.shift();

    if (!prev || ticks.length < p.minTicks) return null;

    const movePts = (prob - prev.prob) * 100;
    if (Math.abs(movePts) < p.minJumpPts) return null;

    // tick-to-tick move distribution over the window, excluding the latest move
    const deltas: number[] = [];
    for (let i = 1; i < ticks.length - 1; i++) deltas.push((ticks[i]!.prob - ticks[i - 1]!.prob) * 100);
    if (deltas.length < p.minTicks - 2) return null;
    const mean = deltas.reduce((a, v) => a + v, 0) / deltas.length;
    const variance = deltas.reduce((a, v) => a + (v - mean) ** 2, 0) / deltas.length;
    const std = Math.max(Math.sqrt(variance), p.stdFloorPts);
    const z = Math.abs(movePts - mean) / std;
    if (z < p.zEnter) return null;

    const jump: Jump = { fixtureId, lineKey: line.key, ts: line.ts, movePts, z };
    this.armedUntil.set(fixtureId, { until: line.ts + p.armWindowMs, trigger: jump });
    return jump;
  }

  /** Is the fixture inside a post-jump arm window at `nowTs`? */
  armedTrigger(fixtureId: number, nowTs: number): Jump | null {
    const armed = this.armedUntil.get(fixtureId);
    if (!armed || nowTs > armed.until) return null;
    return armed.trigger;
  }

  /** Drop per-line state for finished fixtures. */
  forget(fixtureId: number): void {
    this.armedUntil.delete(fixtureId);
    for (const key of this.history.keys()) {
      if (key.startsWith(`${fixtureId}|`)) this.history.delete(key);
    }
  }
}
