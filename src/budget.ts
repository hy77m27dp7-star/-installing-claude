// Spend caps, cost estimation and usage accounting. Money is compared as micro-USD
// integers so float drift never lets a turn slip past a cap.
//
// A model with no price is never called: an unpriced model would meter at $0, so no cap
// could ever trip. The estimate refuses it (402 price_unknown) before anything is spent,
// and assertBudget refuses an estimate that is not a finite number for the same reason.
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

export function hasPrice(settings: Settings, model: string): boolean {
  return priceFor(settings, model) !== null;
}

export function priceUnknown(model: string): ApiHttpError {
  return new ApiHttpError(
    402,
    "price_unknown",
    `no price for model ${model}; add it in the Prices section of the Model page before using it`,
    false,
    model,
  );
}

// Cost in micro-USD: tokens * price-per-million-tokens is already micro-USD. This runs
// after a call, when the money is spent; an unknown price is reported, not refused (the
// pre-call gate in estimateUsd is what keeps an unpriced model from being called at all).
export function costMicro(settings: Settings, model: string, inputTokens: number, outputTokens: number): { micro: number; priceKnown: boolean } {
  const p = priceFor(settings, model);
  if (!p) return { micro: 0, priceKnown: false };
  const micro = Math.round(Math.max(0, inputTokens) * p.inputPerMTok + Math.max(0, outputTokens) * p.outputPerMTok);
  return { micro, priceKnown: true };
}

// Pre-call estimate in USD. Input is sized from characters (four per token). Throws 402
// price_unknown for a model that is not in the price table.
export function estimateUsd(settings: Settings, model: string, inputChars: number, expectedOutputTokens: number): number {
  const p = priceFor(settings, model);
  if (!p) throw priceUnknown(model);
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
  // No estimate, no call: a missing or broken number is never read as free.
  if (typeof estimateUsdValue !== "number" || !Number.isFinite(estimateUsdValue) || estimateUsdValue < 0) {
    throw new ApiHttpError(402, "price_unknown", "the call has no usable cost estimate; check the model's price in the Prices section of the Model page", false);
  }
  const daily = capUsd(settings, "dailyCapUsd");
  const monthly = capUsd(settings, "monthlyCapUsd");
  const estimateMicro = Math.round(estimateUsdValue * MICRO);
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
