// Shared helpers for the unit suite (plain Node 22, no Workers runtime).
//
// 1. A resolve hook. The Worker's TypeScript modules use extensionless relative imports
//    ("./db", "./providers"), which Node's ESM loader refuses. The hook maps such a
//    specifier to "<path>.ts" or "<path>/index.ts" when that file exists, and leaves every
//    other specifier alone. Type stripping itself comes from Node (node --experimental-strip-types;
//    on by default since 22.18). Test files import the modules through loadSrc() so the hook is
//    registered before any src module is resolved, whatever command launched the file.
// 2. RSA key and JWT helpers for the auth tests.
// 3. Row fixtures shared by several test files.
import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSign, generateKeyPairSync } from "node:crypto";

// ------------------------------------------------------------------ resolve hook

const HOOK_FLAG = Symbol.for("avelie.tests.tsResolveHook");
const HAS_EXTENSION = /\.(?:[cm]?[jt]s|json|node|wasm)$/i;

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

if (!globalThis[HOOK_FLAG]) {
  globalThis[HOOK_FLAG] = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      const parent = context.parentURL;
      if (relative && !HAS_EXTENSION.test(specifier) && typeof parent === "string" && parent.startsWith("file:")) {
        const base = fileURLToPath(new URL(specifier, parent));
        if (existsSync(base + ".ts")) return nextResolve(pathToFileURL(base + ".ts").href, context);
        if (isDirectory(base) && existsSync(base + "/index.ts")) return nextResolve(pathToFileURL(base + "/index.ts").href, context);
      }
      return nextResolve(specifier, context);
    },
  });
}

// Imports a module under src/ by its basename ("checks", "providers/stub").
export function loadSrc(name) {
  return import(new URL(`../../src/${name}.ts`, import.meta.url));
}

// ------------------------------------------------------------------ typography

// Built from code points so this file itself passes the typography scan.
export const EM_DASH = String.fromCharCode(0x2014);
export const EN_DASH = String.fromCharCode(0x2013);
export const ELLIPSIS = String.fromCharCode(0x2026);
export const BAD_TYPOGRAPHY = new RegExp("[" + EM_DASH + EN_DASH + ELLIPSIS + "]");

// ------------------------------------------------------------------ JWT helpers

export function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

// A fresh 2048-bit RSA pair. The public half is returned as a JWK carrying a kid, the way
// the Cloudflare Access certs endpoint publishes keys.
export function makeRsaKeys(kid = "test-kid-1") {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return { privateKey, publicKey, kid, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

// RS256 (RSASSA-PKCS1-v1_5 with SHA-256) compact JWT.
export function signJwt(privateKey, header, payload) {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const signature = createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey);
  return `${h}.${p}.${signature.toString("base64url")}`;
}

// ------------------------------------------------------------------ fake D1

// A D1 stand-in for modules that read and write the database. Every prepared statement is
// recorded in `log` (sql, binds, and whether it ran through all/first/run/batch), and
// `answer(sql, binds)` supplies the rows a read gets back (an array; anything else is no
// rows). Writes always report one change.
export function fakeD1(answer = () => []) {
  const log = [];
  const rows = (sql, binds) => {
    const r = answer(sql, binds);
    return Array.isArray(r) ? r : [];
  };
  function statement(sql, binds) {
    return {
      sql,
      binds,
      bind: (...b) => statement(sql, b),
      async all() {
        log.push({ sql, binds, via: "all" });
        return { results: rows(sql, binds), success: true, meta: {} };
      },
      async first() {
        log.push({ sql, binds, via: "first" });
        return rows(sql, binds)[0] ?? null;
      },
      async run() {
        log.push({ sql, binds, via: "run" });
        return { results: [], success: true, meta: { changes: 1 } };
      },
    };
  }
  return {
    log,
    prepare: (sql) => statement(sql, []),
    async batch(stmts) {
      for (const s of stmts) log.push({ sql: s.sql, binds: s.binds, via: "batch" });
      return stmts.map((s) => ({ results: rows(s.sql, s.binds), success: true, meta: { changes: 1 } }));
    },
  };
}

// ------------------------------------------------------------------ fixtures

const T0 = "2026-09-24T00:00:00.000Z";

export function factRow(overrides = {}) {
  return {
    id: "f_test",
    scope: "avelie",
    subject: null,
    fact: "she keeps a plant alive out of spite",
    source: null,
    status: "approved",
    disclosed: 1,
    provisional: 0,
    version: 1,
    supersedes_id: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function historyRow(overrides = {}) {
  return {
    id: "h_test",
    seq: 1,
    title: "a test entry",
    occurred: null,
    body: "something that happened",
    what_changed: null,
    keep_consistent: null,
    source: null,
    status: "approved",
    version: 1,
    supersedes_id: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function unknownRow(overrides = {}) {
  return {
    id: "u_test",
    topic: "where she grew up",
    note: null,
    status: "open",
    resolution: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

// The seeded fresh-start state (canon/seed/state.json), copied so tests never read the seed.
export function relationshipState(overrides = {}) {
  return {
    status: "strangers",
    summary: "They have not met. There is no shared history. She does not know his name, age, life or why he is talking to her.",
    trust: "none yet",
    affection: "none yet",
    attraction: "not established",
    friction: "none",
    private_language: "none",
    his_name: null,
    nicknames: "none established",
    frontier: "before the first conversation",
    ...overrides,
  };
}

export function sceneState(overrides = {}) {
  return {
    status: "none",
    summary: "No scene is in progress.",
    location: null,
    time: null,
    present: [],
    last_beat: null,
    ...overrides,
  };
}

export function promptState(overrides = {}) {
  return {
    hasSharedHistory: false,
    fixedFacts: [
      factRow({ id: "f_fixed_name", scope: "fixed", subject: "name", fact: "Her name is Avelie, pronounced Av-el-lee." }),
      factRow({ id: "f_fixed_age", scope: "fixed", subject: "age", fact: "She is 22." }),
    ],
    avelieFacts: [],
    justinFacts: [],
    history: [],
    unknowns: [],
    relationship: relationshipState(),
    scene: sceneState(),
    ...overrides,
  };
}

export function checkCtx(overrides = {}) {
  return {
    hasSharedHistory: false,
    knownName: null,
    recentAssistantTexts: [],
    openUnknownTopics: [],
    channel: "story",
    ...overrides,
  };
}

export function testSettings(overrides = {}) {
  return {
    provider: "stub",
    model: "claude-opus-5",
    effort: "medium",
    temperature: 0.9,
    maxTokens: 700,
    proposalsEnabled: true,
    proposalProvider: "stub",
    proposalModel: "claude-sonnet-5",
    imageProvider: "stub",
    imageModel: "gpt-image-1",
    imageQuality: "medium",
    imageSize: "1024x1536",
    imageCostUsd: 0.06,
    dailyCapUsd: 3,
    monthlyCapUsd: 30,
    contextRecentMessages: 40,
    contextMaxChars: 24000,
    prices: {
      "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
      "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
    },
    ...overrides,
  };
}
