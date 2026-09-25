// Provider lookup. Settings name a provider; this module hands back the adapter and
// says whether the environment holds what that adapter needs.
//
// v3: a video registry (Runway, stub) and the call providers (OpenAI Realtime, stub;
// elevenlabs reserved, off). RUNWAY_API_KEY is optional: without it the video provider
// reports not configured and every video control stays hidden (SPEC_V3 FF).
//
// 2026-09-25: Runway is also an image provider (Gen-4 Image with tagged character
// references, for her photos); OpenAI stays selectable as the fallback. The key is checked
// at call time like OpenAI's, so the Model page can be switched before the secret exists
// and a photo fails cleanly (503 provider_not_configured) until it does.
import { ProviderError } from "../types";
import type { Env, ImageProviderName, ProviderName, TextProvider } from "../types";
import type { CallProviderName, ImageProviderV3, ProviderRegistry, VideoAdapterName, VideoProvider } from "./types";
import { anthropicProvider } from "./anthropic";
import { openaiImageProvider, openaiProvider } from "./openai";
import { workersAiProvider } from "./workersai";
import { stubImageProvider, stubProvider, stubVideoProvider } from "./stub";
import { runwayImageProvider, runwayProvider } from "./runway";

export const registry: ProviderRegistry = {
  text: {
    anthropic: anthropicProvider,
    openai: openaiProvider,
    workersai: workersAiProvider,
    stub: stubProvider,
  },
  image: {
    openai: openaiImageProvider,
    runway: runwayImageProvider,
    stub: stubImageProvider,
  },
  video: {
    runway: runwayProvider,
    stub: stubVideoProvider,
  },
};

export function getTextProvider(name: ProviderName): TextProvider {
  // Settings come from JSON, so guard at runtime as well as in the type.
  const p = (registry.text as Record<string, TextProvider | undefined>)[name];
  if (!p) throw new ProviderError(String(name), "config", "unknown text provider: " + String(name), 503, false);
  return p;
}

export function getImageProvider(name: ImageProviderName): ImageProviderV3 {
  const p = (registry.image as Record<string, ImageProviderV3 | undefined>)[name];
  if (!p) throw new ProviderError(String(name), "config", "unknown image provider: " + String(name), 503, false);
  return p;
}

export function getVideoProvider(name: VideoAdapterName): VideoProvider {
  const p = (registry.video as Record<string, VideoProvider | undefined>)[name];
  if (!p) throw new ProviderError(String(name), "config", "unknown video provider: " + String(name), 503, false);
  return p;
}

function hasKey(v: string | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

export function providerConfigured(env: Env, name: ProviderName): boolean {
  switch (name) {
    case "stub":
    case "workersai":
      return true;
    case "anthropic":
      return hasKey(env.ANTHROPIC_API_KEY);
    case "openai":
      return hasKey(env.OPENAI_API_KEY);
    default:
      return false;
  }
}

export function imageProviderConfigured(env: Env, name: ImageProviderName): boolean {
  switch (name) {
    case "stub":
      return true;
    case "openai":
      return hasKey(env.OPENAI_API_KEY);
    case "runway":
      return hasKey(env.RUNWAY_API_KEY);
    default:
      return false;
  }
}

// "off" and anything unknown are not configured; the caller answers 503.
export function videoProviderConfigured(env: Env, name: unknown): boolean {
  switch (name) {
    case "stub":
      return true;
    case "runway":
      return hasKey(env.RUNWAY_API_KEY);
    default:
      return false;
  }
}

// The reserved ElevenLabs path answers false here; calls.startCall names the reason.
export function callProviderConfigured(env: Env, name: unknown): boolean {
  switch (name as CallProviderName) {
    case "stub":
      return true;
    case "openai":
      return hasKey(env.OPENAI_API_KEY);
    default:
      return false;
  }
}

// An image provider that bills nothing per photo. Only such a provider may run with
// imageCostUsd at 0; a paid one at 0 would put photos on the meter for free.
const KEYLESS_IMAGE_PROVIDERS: ReadonlySet<string> = new Set<ImageProviderName>(["stub"]);

export function isKeylessImageProvider(name: unknown): boolean {
  return typeof name === "string" && KEYLESS_IMAGE_PROVIDERS.has(name);
}
