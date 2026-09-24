// Spend caps, cost estimation and usage accounting. Money is compared as micro-USD
// integers so float drift never lets a turn slip past a cap.
import { DEFAULT_SETTINGS, dayKey, monthKey, spendMicro, usageByDay } from "./db";
import { ApiHttpError } from "./errors";
import type { Settings } from "./types";

const MICRO = 1_000_000;
const CHARS_PER_TOKEN = 4;

type Price = { inputPerMTok: number; outputPerMTok: number };

function priceFor(settings: Settings, model: string): Price | null {
  const table = settings.prices && typeof settings.prices === "object" ? settings.prices : DEFAULT_SETTINGS.prices;
  const p = table[model];
  if (!p || typeof p.inputPerMTok !== "number" || typeof p.outputPerMTok !== "number") return null;
  return p;
}

// Cost in micro-USD: tokens * price-per-million-tokens is already micro-USD.
export function costMicro(settings: Settings, model: string, inputTokens: number, outputTokens: number): { micro: number; priceKnown: boolean } {
  const p = priceFor(settings, model);
  if (!p) return { micro: 0, priceKnown: false };
  const micro = Math.round(Math.max(0, inputTokens) * p.inputPerMTok + Math.max(0, outputTokens) * p.outputPerMTok);
  return { micro, priceKnown: true };
}

// Pre-call estimate in USD. Input is sized from characters (four per token).
export function estimateUsd(settings: Settings, model: string, inputChars: number, expectedOutputTokens: number): number {
  const p = priceFor(settings, model);
  if (!p) return 0;
  const inputTokens = Math.ceil(Math.max(0, inputChars) / CHARS_PER_TOKEN);
  return (inputTokens * p.inputPerMTok + Math.max(0, expectedOutputTokens) * p.outputPerMTok) / MICRO;
}

// A cap that is missing or not a number falls back to the default; an explicit 0 means
// no spend at all.
export function capUsd(settings: Settings, key: "dailyCapUsd" | "monthlyCapUsd"): number {
  const v = settings[key];
  return typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_SETTINGS[key];
}

function monthStart(): string {
  return monthKey() + "-01";
}

function usd(micro: number): string {
  return "$" + (micro / MICRO).toFixed(4);
}

function exceeded(period: "daily" | "monthly", spentMicro: number, estimateMicro: number, capMicro: number): ApiHttpError {
  const detail = `${period} spend ${usd(spentMicro)} + estimate ${usd(estimateMicro)} exceeds cap ${usd(capMicro)}`;
  return new ApiHttpError(402, "budget_exceeded", `${period} budget exceeded`, false, detail);
}

export async function assertBudget(db: D1Database, settings: Settings, estimateUsdValue: number): Promise<void> {
  const daily = capUsd(settings, "dailyCapUsd");
  const monthly = capUsd(settings, "monthlyCapUsd");
  const estimateMicro = Math.max(0, Math.round((Number.isFinite(estimateUsdValue) ? estimateUsdValue : 0) * MICRO));
  const dailyMicro = Math.max(0, Math.round(daily * MICRO));
  const monthlyMicro = Math.max(0, Math.round(monthly * MICRO));

  if (daily <= 0) throw exceeded("daily", 0, estimateMicro, 0);
  if (monthly <= 0) throw exceeded("monthly", 0, estimateMicro, 0);

  const [todayMicro, monthMicro] = await Promise.all([spendMicro(db, dayKey()), spendMicro(db, monthStart())]);
  if (todayMicro + estimateMicro > dailyMicro) throw exceeded("daily", todayMicro, estimateMicro, dailyMicro);
  if (monthMicro + estimateMicro > monthlyMicro) throw exceeded("monthly", monthMicro, estimateMicro, monthlyMicro);
}

export async function usageSummary(db: D1Database, settings: Settings): Promise<{
  todayUsd: number;
  monthUsd: number;
  dailyCapUsd: number;
  monthlyCapUsd: number;
  byDay: Array<{ day: string; provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; costUsd: number }>;
}> {
  const [todayMicro, monthMicro, rows] = await Promise.all([spendMicro(db, dayKey()), spendMicro(db, monthStart()), usageByDay(db)]);
  return {
    todayUsd: todayMicro / MICRO,
    monthUsd: monthMicro / MICRO,
    dailyCapUsd: capUsd(settings, "dailyCapUsd"),
    monthlyCapUsd: capUsd(settings, "monthlyCapUsd"),
    byDay: rows.map((r) => ({
      day: r.day,
      provider: r.provider,
      model: r.model,
      requests: r.requests,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd_micro / MICRO,
    })),
  };
}
