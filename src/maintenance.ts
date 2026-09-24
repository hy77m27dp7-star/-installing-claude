// The nightly pass (SPEC_V3 "Crons"): the 07:00 UTC daily handler in src/index.ts runs
// this beside the backup. Four steps, each in its own try: weather_cache rows older than
// a day go; open asks older than askLetGoDays are let go (wants.letGoStaleStmts, audited
// per ask); pending tastings older than 30 minutes expire; calls still starting or live
// with no tick for 2 minutes expire. Every change is audited. A failed step is logged by
// class and swallowed, so the backup still runs and one broken table never stops the rest.
import { auditStmt } from "./db";
import { purgeCacheStmt } from "./weather";
import { letGoStaleStmts, wantsSettings } from "./wants";
import type { WantsSettings } from "./wants";
import type { Env } from "./types";

export const ACTOR = "maintenance";
export const WEATHER_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const TASTING_STALE_MS = 30 * 60 * 1000;
export const CALL_STALE_MS = 2 * 60 * 1000;

export interface NightlyResult {
  at: string;
  weatherCacheDeleted: number;
  asksLetGo: string[];
  tastingsExpired: number;
  callsExpired: number;
  errors: Array<{ step: string; error: string }>;
}

function changes(r: D1Result | D1Result[] | undefined): number {
  if (!r) return 0;
  if (Array.isArray(r)) return r.reduce((n, x) => n + (x?.meta?.changes ?? 0), 0);
  return r.meta?.changes ?? 0;
}

export function expireTastingsStmt(db: D1Database, now: Date): D1PreparedStatement {
  const cutoff = new Date(now.getTime() - TASTING_STALE_MS).toISOString();
  return db.prepare("UPDATE tastings SET status = 'expired', decided_at = ?2 WHERE status = 'pending' AND created_at < ?1").bind(cutoff, now.toISOString());
}

export function expireCallsStmt(db: D1Database, now: Date): D1PreparedStatement {
  const cutoff = new Date(now.getTime() - CALL_STALE_MS).toISOString();
  return db.prepare("UPDATE calls SET status = 'expired', ended_at = ?2, end_reason = COALESCE(end_reason, 'expired') WHERE status IN ('starting', 'live') AND COALESCE(last_tick_at, started_at) < ?1")
    .bind(cutoff, now.toISOString());
}

async function step(result: NightlyResult, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const cls = e instanceof Error ? e.name || "Error" : "error";
    console.warn("maintenance step failed", name, cls);
    result.errors.push({ step: name, error: cls });
  }
}

export async function nightly(_env: Env, db: D1Database, settings: WantsSettings | null | undefined, now: Date = new Date()): Promise<NightlyResult> {
  const result: NightlyResult = { at: now.toISOString(), weatherCacheDeleted: 0, asksLetGo: [], tastingsExpired: 0, callsExpired: 0, errors: [] };

  await step(result, "weather_cache", async () => {
    const r = await purgeCacheStmt(db, new Date(now.getTime() - WEATHER_CACHE_MAX_AGE_MS)).run();
    result.weatherCacheDeleted = changes(r);
    if (result.weatherCacheDeleted > 0) {
      await auditStmt(db, ACTOR, "maintenance.weather_cache", "weather_cache", null, null, { deleted: result.weatherCacheDeleted, at: result.at }).run();
    }
  });

  await step(result, "asks", async () => {
    const days = wantsSettings(settings).askLetGoDays;
    const { askIds, stmts } = await letGoStaleStmts(db, now, days, ACTOR);
    if (stmts.length) await db.batch(stmts);
    result.asksLetGo = askIds;
  });

  await step(result, "tastings", async () => {
    const r = await expireTastingsStmt(db, now).run();
    result.tastingsExpired = changes(r);
    if (result.tastingsExpired > 0) {
      await auditStmt(db, ACTOR, "maintenance.tastings_expired", "tasting", null, null, { expired: result.tastingsExpired, at: result.at }).run();
    }
  });

  await step(result, "calls", async () => {
    const r = await expireCallsStmt(db, now).run();
    result.callsExpired = changes(r);
    if (result.callsExpired > 0) {
      await auditStmt(db, ACTOR, "maintenance.calls_expired", "call", null, null, { expired: result.callsExpired, at: result.at }).run();
    }
  });

  await step(result, "summary", async () => {
    await auditStmt(db, ACTOR, "maintenance.nightly", "cron", "0 7 * * *", null, {
      at: result.at,
      weatherCacheDeleted: result.weatherCacheDeleted,
      asksLetGo: result.asksLetGo.length,
      tastingsExpired: result.tastingsExpired,
      callsExpired: result.callsExpired,
      errors: result.errors.map((e) => e.step),
    }).run();
  });

  return result;
}
