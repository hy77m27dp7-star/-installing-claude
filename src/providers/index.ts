// Provider lookup. Settings name a provider; this module hands back the adapter and
// says whether the environment holds what that adapter needs.
import { ProviderError } from "../types";
import type { Env, ImageProvider, ImageProviderName, ProviderName, TextProvider } from "../types";
import type { ProviderRegistry } from "./types";
import { anthropicProvider } from "./anthropic";
import { openaiImageProvider, openaiProvider } from "./openai";
import { workersAiProvider } from "./workersai";
import { stubImageProvider, stubProvider } from "./stub";

export const registry: ProviderRegistry = {
  text: {
    anthropic: anthropicProvider,
    openai: openaiProvider,
    workersai: workersAiProvider,
    stub: stubProvider,
  },
  image: {
    openai: openaiImageProvider,
    stub: stubImageProvider,
  },
};

export function getTextProvider(name: ProviderName): TextProvider {
  // Settings come from JSON, so guard at runtime as well as in the type.
  const p = (registry.text as Record<string, TextProvider | undefined>)[name];
  if (!p) throw new ProviderError(String(name), "config", "unknown text provider: " + String(name), 503, false);
  return p;
}

export function getImageProvider(name: ImageProviderName): ImageProvider {
  const p = (registry.image as Record<string, ImageProvider | undefined>)[name];
  if (!p) throw new ProviderError(String(name), "config", "unknown image provider: " + String(name), 503, false);
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
