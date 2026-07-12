// Formatting conventions (locked): paper units carry no currency symbol,
// probabilities are percents with one decimal, prices are decimal odds with
// three, edges and CLV are probability points. Numbers render in mono with
// tabular figures so columns stay still.

export function fmtUnits(v: number | string | null | undefined, signed = false): string {
  if (v === null || v === undefined) return "–";
  const n = Number(v);
  const s = n.toFixed(2);
  return signed && n > 0 ? `+${s}` : s;
}

export function fmtPct(p: number | string | null | undefined): string {
  if (p === null || p === undefined) return "–";
  return `${(Number(p) * 100).toFixed(1)}%`;
}

export function fmtPts(v: number | string | null | undefined, signed = true): string {
  if (v === null || v === undefined) return "–";
  const n = Number(v);
  return `${signed && n > 0 ? "+" : ""}${n.toFixed(1)}`;
}

export function fmtPrice(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "–";
  return Number(v).toFixed(3);
}

export function truncSig(sig: string, chars = 4): string {
  if (sig.length <= chars * 2 + 3) return sig;
  return `${sig.slice(0, chars)}...${sig.slice(-chars)}`;
}

export function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

export function solscanAccount(addr: string): string {
  return `https://solscan.io/account/${addr}`;
}

export function timeAgo(date: Date | string): string {
  const t = typeof date === "string" ? new Date(date).getTime() : date.getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Kickoff formatting per the design system: "Jul 14 · 19:00" (UTC, deterministic). */
export function fmtKickoff(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} · ${hh}:${mm}`;
}

/** Feed competition strings -> display labels. */
export function competitionLabel(competition: string): string {
  if (competition === "Friendlies") return "Friendly";
  return competition;
}

/** "OVERUNDER_PARTICIPANT_GOALS|half=1|line=1.5" + side -> human text. */
export function humanMarket(marketKey: string, side: string, p1?: string, p2?: string): string {
  const [type, period, params] = marketKey.split("|");
  const line = /line=(-?\d+(?:\.\d+)?)/.exec(params ?? "")?.[1];
  const scope = period === "half=1" ? "1st half" : period === "et" ? "extra time" : "full match";
  const team = (s: string) => (s === "part1" ? p1 || "Home" : s === "part2" ? p2 || "Away" : s);
  if (type === "OVERUNDER_PARTICIPANT_GOALS")
    return `${side === "over" ? "Over" : "Under"} ${line} goals, ${scope}`;
  if (type === "ASIANHANDICAP_PARTICIPANT_GOALS")
    return `${team(side)} ${Number(line) > 0 ? "+" : ""}${line} (AH), ${scope}`;
  if (type === "1X2_PARTICIPANT_RESULT")
    return side === "draw" ? `Draw, ${scope}` : `${team(side)} to win, ${scope}`;
  return `${marketKey} ${side}`;
}
