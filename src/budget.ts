// Spend caps, cost estimation and usage accounting. Money is compared as micro-USD
// integers so float drift never lets a turn slip past a cap.
//
// A model with no price is never called: an unpriced model would meter at $0, so no cap
// could ever trip. The estimate refuses it (402 price_unknown) before anything is spent,
// and assertBudget refuses an estimate that is not a finite number for the same reason.
//
// v3: priceUsage prices a realtime call's cumulative usage (SPEC_V3 EE, the "priced" side
// of max(metered, priced)), and assertTastingBudget bounds the day's tastings by their
// own cap on top of the normal caps (SPEC_V3 HH).
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

// The day's and the month's spend against the caps, for callers that meter after the
// fact (a call's tick): { todayMicro, monthMicro, dailyMicro, monthlyMicro }.
export async function spendAgainstCaps(db: D1Database, settings: Settings): Promise<{ todayMicro: number; monthMicro: number; dailyMicro: number; monthlyMicro: number }> {
  const [todayMicro, monthMicro] = await Promise.all([spendMicro(db, dayKey()), spendMicro(db, monthStart())]);
  return {
    todayMicro,
    monthMicro,
    dailyMicro: Math.max(0, Math.round(capUsd(settings, "dailyCapUsd") * MICRO)),
    monthlyMicro: Math.max(0, Math.round(capUsd(settings, "monthlyCapUsd") * MICRO)),
  };
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

// ------------------------------------------------------------------ v3: calls (SPEC_V3 EE)

// Token counts the page accumulates from the session's response.done events, cumulative
// for the call so far. Cached text tokens count as textIn: the meter takes no discount.
export interface CallUsage {
  audioIn: number;
  audioOut: number;
  textIn: number;
  textOut: number;
}

// USD per million tokens, one price per token class (settings.callPrices).
export interface CallPrices {
  audioInPerMTok: number;
  audioOutPerMTok: number;
  textInPerMTok: number;
  textOutPerMTok: number;
}

export const DEFAULT_CALL_PRICES: CallPrices = { audioInPerMTok: 32, audioOutPerMTok: 64, textInPerMTok: 4, textOutPerMTok: 16 };

function nonNegative(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

// The call prices as stored, each 0..100000 with the defaults for anything missing.
export function callPricesOf(settings: Settings): CallPrices {
  const raw = (settings as unknown as Record<string, unknown>).callPrices;
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const pick = (k: keyof CallPrices): number => (typeof o[k] === "number" && Number.isFinite(o[k] as number) ? Math.min(100000, Math.max(0, o[k] as number)) : DEFAULT_CALL_PRICES[k]);
  return { audioInPerMTok: pick("audioInPerMTok"), audioOutPerMTok: pick("audioOutPerMTok"), textInPerMTok: pick("textInPerMTok"), textOutPerMTok: pick("textOutPerMTok") };
}

// Cumulative usage priced at list, in micro-USD (tokens x USD per million is already
// micro-USD), rounded up. Negative or missing counts read as 0.
export function priceUsage(usage: CallUsage | null | undefined, prices: CallPrices): number {
  if (!usage) return 0;
  const micro =
    nonNegative(usage.audioIn) * prices.audioInPerMTok +
    nonNegative(usage.audioOut) * prices.audioOutPerMTok +
    nonNegative(usage.textIn) * prices.textInPerMTok +
    nonNegative(usage.textOut) * prices.textOutPerMTok;
  return Math.ceil(micro);
}

// ------------------------------------------------------------------ v3: tastings (SPEC_V3 HH)

const DEFAULT_TASTING_DAILY_CAP_USD = 1;

// The tastings cap as stored (0..1000), the spec default when missing.
export function tastingDailyCapUsd(settings: Settings): number {
  const v = (settings as unknown as Record<string, unknown>).tastingDailyCapUsd;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_TASTING_DAILY_CAP_USD;
}

// The UTC day's tastings so far (the sum of tastings.cost_usd_micro since midnight).
export async function tastingSpendMicro(db: D1Database, day = dayKey()): Promise<number> {
  const r = await db.prepare("SELECT COALESCE(SUM(cost_usd_micro), 0) AS s FROM tastings WHERE created_at >= ?1").bind(day).first<{ s: number }>();
  return Number(r?.s ?? 0);
}

// The tasting cap bounds the day's tastings on top of the normal caps (which see the
// double spend through usage_daily). 402 tasting_budget_exceeded; nothing is written.
export async function assertTastingBudget(db: D1Database, settings: Settings, estimateUsdValue: number): Promise<void> {
  if (typeof estimateUsdValue !== "number" || !Number.isFinite(estimateUsdValue) || estimateUsdValue < 0) {
    throw new ApiHttpError(402, "price_unknown", "the tasting has no usable cost estimate; check both performers' prices on the Model page", false);
  }
  const cap = tastingDailyCapUsd(settings);
  const capMicro = Math.max(0, Math.round(cap * MICRO));
  const estimateMicro = Math.round(estimateUsdValue * MICRO);
  const fail = (spent: number): ApiHttpError =>
    new ApiHttpError(402, "tasting_budget_exceeded", "tasting budget exceeded", false, `today's tastings ${usd(spent)} + estimate ${usd(estimateMicro)} exceeds the tasting cap ${usd(capMicro)}`);
  if (cap <= 0) throw fail(0);
  const spent = await tastingSpendMicro(db);
  if (spent + estimateMicro > capMicro) throw fail(spent);
}
