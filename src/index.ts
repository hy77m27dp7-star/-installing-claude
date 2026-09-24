// Fetch entry. The owner gate runs first for every path, static assets and images included
// (run_worker_first), so nothing is ever served to a stranger. Then: /api/* to the router,
// /media/:id to R2, everything else to the ASSETS binding.
import { requireOwner } from "./auth";
import { handleApi } from "./api";
import { serveMedia } from "./images";
import { json } from "./errors";
import type { Env } from "./types";

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
const MEDIA_PREFIX = "/media/";

function methodNotAllowed(): Response {
  return json({ error: "method not allowed", code: "method_not_allowed" }, 405);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Private, uncached, unframed. Applied to every response that leaves this Worker.
function harden(res: Response): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("cache-control", "private, no-store");
  h.set("x-content-type-options", "nosniff");
  const type = (h.get("content-type") ?? "").toLowerCase();
  if (type.includes("text/html")) {
    h.set("x-frame-options", "DENY");
    h.set("referrer-policy", "no-referrer");
  }
  return out;
}

async function dispatch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let owner: { email: string; mode: "access" | "dev" };
  try {
    owner = await requireOwner(request, env);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api" || path.startsWith("/api/")) {
    return handleApi(request, env, ctx, owner.email, url);
  }

  if (path.startsWith(MEDIA_PREFIX)) {
    if (!READ_METHODS.has(request.method)) return methodNotAllowed();
    const id = safeDecode(path.slice(MEDIA_PREFIX.length));
    return serveMedia(env, env.DB, id);
  }

  if (!READ_METHODS.has(request.method)) return methodNotAllowed();
  // The assets binding maps "/" to index.html and answers 404 for anything missing.
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let res: Response;
    try {
      res = await dispatch(request, env, ctx);
    } catch (e) {
      // Class only in the log; the body says nothing about what went wrong.
      console.error("unhandled", e instanceof Error ? e.name : "error");
      res = json({ error: "internal error", code: "internal" }, 500);
    }
    return harden(res);
  },
} satisfies ExportedHandler<Env>;
