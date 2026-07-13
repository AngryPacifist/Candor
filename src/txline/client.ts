// Fresh thin client for TxLINE (REST + SSE). Written for Candor; no code ported.
// Auth model: Authorization Bearer <guest JWT> + X-Api-Token on every request.
// The guest JWT is re-issued via POST /auth/guest/start when missing or near expiry.

import { config } from "../config.js";
import type { Fixture, OddsRecord, ScoreRecord, StatValidationResponse, StatValidationV3Response } from "./types.js";

const JWT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000; // re-issue when <1 day left

function jwtExpiryMs(jwt: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export interface StreamHandlers {
  onRecord: (raw: string) => void;
  onHeartbeat?: () => void;
  onConnect?: (encoding: string) => void;
  onDisconnect?: (reason: string) => void;
}

export class TxlineClient {
  private jwt: string | null = config.txline.jwt;

  private async ensureJwt(): Promise<string> {
    if (this.jwt) {
      const exp = jwtExpiryMs(this.jwt);
      if (exp !== null && exp - Date.now() > JWT_REFRESH_MARGIN_MS) return this.jwt;
    }
    const res = await fetch(`${config.txline.origin}/auth/guest/start`, { method: "POST" });
    if (!res.ok) throw new Error(`guest/start failed: HTTP ${res.status}`);
    const body = (await res.json()) as { token: string };
    this.jwt = body.token;
    return this.jwt;
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.ensureJwt()}`,
      "X-Api-Token": config.txline.apiToken,
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${config.txline.origin}${path}`, { headers: await this.headers() });
    if (res.status === 401) {
      // stale JWT despite margin — force re-issue once
      this.jwt = null;
      const retry = await fetch(`${config.txline.origin}${path}`, { headers: await this.headers() });
      if (!retry.ok) throw new Error(`GET ${path} -> HTTP ${retry.status}`);
      return (await retry.json()) as T;
    }
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  // ── REST ──────────────────────────────────────────────────────

  fixturesSnapshot(epochDay?: number): Promise<Fixture[]> {
    const q = epochDay !== undefined ? `?epochDay=${epochDay}` : "";
    return this.getJson<Fixture[]>(`/api/fixtures/snapshot${q}`);
  }

  scoresSnapshot(fixtureId: number): Promise<ScoreRecord[]> {
    return this.getJson<ScoreRecord[]>(`/api/scores/snapshot/${fixtureId}`);
  }

  oddsSnapshot(fixtureId: number): Promise<OddsRecord[]> {
    return this.getJson<OddsRecord[]>(`/api/odds/snapshot/${fixtureId}`);
  }

  statValidation(fixtureId: number, seq: number, statKeys: number[]): Promise<StatValidationResponse> {
    return this.getJson<StatValidationResponse>(
      `/api/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys.join(",")}`
    );
  }

  /** Multiproof validation payloads (mainnet since 2026-07-13). */
  statValidationV3(fixtureId: number, seq: number, statKeys: number[]): Promise<StatValidationV3Response> {
    return this.getJson<StatValidationV3Response>(
      `/api/scores/stat-validation-v3?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys.join(",")}`
    );
  }

  // ── SSE ───────────────────────────────────────────────────────

  /**
   * Consume an SSE stream with reconnect + liveness watchdog. Resolves only
   * when `signal` aborts. Reconnects on error/server-close with capped backoff.
   */
  async stream(
    path: "/api/scores/stream" | "/api/odds/stream",
    handlers: StreamHandlers,
    signal: AbortSignal,
    watchdogMs = 90_000
  ): Promise<void> {
    let backoff = 1000;
    while (!signal.aborted) {
      const ctrl = new AbortController();
      const onOuterAbort = () => ctrl.abort();
      signal.addEventListener("abort", onOuterAbort, { once: true });
      let lastActivity = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > watchdogMs) ctrl.abort();
      }, 5000);
      try {
        const res = await fetch(`${config.txline.origin}${path}`, {
          headers: {
            ...(await this.headers()),
            Accept: "text/event-stream",
            "Cache-Control": "no-cache",
          },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        handlers.onConnect?.(res.headers.get("content-encoding") ?? "none");
        backoff = 1000;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lastActivity = Date.now();
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (/^event:\s*heartbeat/m.test(frame)) {
              handlers.onHeartbeat?.();
              continue;
            }
            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (dataLine) handlers.onRecord(dataLine.slice(5).trim());
          }
        }
        handlers.onDisconnect?.("server closed stream");
      } catch (e) {
        if (!signal.aborted) {
          handlers.onDisconnect?.(e instanceof Error ? e.message : String(e));
        }
      } finally {
        clearInterval(watchdog);
        signal.removeEventListener("abort", onOuterAbort);
      }
      if (signal.aborted) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

export const epochDayNow = (): number => Math.floor(Date.now() / 86_400_000);
