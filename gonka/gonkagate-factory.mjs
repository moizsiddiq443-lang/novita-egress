#!/usr/bin/env node
// gonkagate-factory.mjs â€” GONKAGATE ACCOUNT FACTORY (pure HTTP, no browser)
//
// Creates GonkaGate accounts end-to-end over REST:
//   mint Emailnator dotGmail â†’ register â†’ poll inbox â†’ extract verify token â†’
//   verify-email â†’ login (JWT) â†’ dashboard user (balance $10) â†’ api-keys (gp-) â†’
//   registry.
//
// CLI:
//   node gonkagate-factory.mjs create <n> [--from <startIdx>]   â†’ create n accounts total (sequential, paced), resumes from registry
//   node gonkagate-factory.mjs verify <email>                   â†’ chat test on that account's key (60s timeout)
//   node gonkagate-factory.mjs status                           â†’ registry count, total balance, funded/unfunded
//
// Verified flow from .opencode/goals/work/probes/brokers/broker-free-tier-map.md
// + credentials-gonkagate.json (probed live 2026-09-24). Auth host = gonkagate.com,
// inference host = api.gonkagate.com (per probe evidence).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_HOST = "https://gonkagate.com";
const API_HOST = "https://api.gonkagate.com";
const EMAILNATOR = "https://www.emailnator.com";
const EMAILNATOR_HDRS = { "Content-Type": "application/json", Accept: "application/json" };

const REGISTRY_PATH = process.env.GONKAGATE_REGISTRY || "F:\\FREE CODE BY MOIZ\\.opencode\\goals\\work\\gonkagate\\gonkagate-registry.json";
const RUN_LOG_PATH = process.env.GONKAGATE_RUNLOG || "F:\\FREE CODE BY MOIZ\\.opencode\\goals\\work\\gonkagate\\factory-run-100.md";

// ---- pacing / timeouts ----
const MINT_MIN_GAP_MS = 8000;   // Emailnator ~8/min
const REGISTER_MIN_GAP_MS = 3000; // register pace (IP safety)
const JITTER_MS = 4000;         // sakana L-028: randomized jitter so pacing is non-deterministic
const HTTP_TIMEOUT_MS = 60000;  // gonka gateway is slow; <30s => false failures
const CHAT_TIMEOUT_MS = 60000;  // inference test timeout
const MAIL_POLL_INTERVAL_MS = 9000;
const MAIL_POLL_TIMEOUT_MS = parseInt(process.env.GONKA_MAIL_TIMEOUT || "420000", 10); // 7 min max per account (env-tunable: GONKA_MAIL_TIMEOUT ms)
const RESEND_AFTER_MS = parseInt(process.env.GONKA_RESEND_AFTER || "120000", 10); // resend after 2 min (env-tunable)
const BONUS_POLL_INTERVAL_MS = 15000; // $10 grant is lazy (~1 min after email verify, observed)
const BONUS_POLL_TIMEOUT_MS = 240000; // 4 min max wait for the $10 auto-grant
// sakana L-028 doctrine: NEVER hammer a dead window. Abort the whole run after 3
// consecutive throttle-classified failures (429 / rate-limit / blocked / banned).
const THROTTLE_ABORT_AFTER = 3;
// Per-IP window cap: hard stop once this many accounts exist in the registry from this
// lane (sakana measured ~100-150/IP/window on Firebase; gonkagate is custom auth + REAL
// $10 grants, so stay conservative). Override via env GONKAGATE_IP_CAP (e.g. GH egress).
const IP_CAP = parseInt(process.env.GONKAGATE_IP_CAP || "100", 10);
let lastMintAt = 0;
let lastRegisterAt = 0;
let consecutiveThrottles = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pace = async (gap, ref) => {
  const wait = gap + Math.floor(Math.random() * JITTER_MS) - (Date.now() - ref);
  if (wait > 0) await sleep(wait);
};
// classify an error/status as a throttle signature (429, rate limit, blocked, banned,
// or gonkagate's soft anti-abuse 404 "Application not found" — observed 2026-09-30 when
// GH runner egress IPs collided at parallel-12: register returned 404 repeatedly).
function isThrottle(status, text) {
  const t = text || "";
  return status === 429
    || status === 404 && /application not found|not found/i.test(t)
    || /rate|limit|too many|try again|temporar|blocked|banned|cooldown/i.test(t);
}

// ---- run-log (module scope, lazy append) ----
let _logMd = null;

// ---- logging ----
const logLines = [];
// GONKA_QUIET=1: redact emails/keys from stdout — MANDATORY when running on a PUBLIC
// repo (run logs are public!). Registry file still keeps full data (never leaves runner).
const QUIET = process.env.GONKA_QUIET === "1";
function log(msg) {
  let line = `[${new Date().toISOString()}] ${msg}`;
  if (QUIET) {
    line = line
      .replace(/[a-zA-Z0-9._+-]+@gmail\.com/g, "<email>")
      .replace(/(gp|sk)-[A-Za-z0-9_-]{20,}/g, "<key>")
      .replace(/key=\S+/g, "key=<redacted>");
  }
  console.log(line);
  logLines.push(line);
}

// ---- HTTP helper ----
async function f(url, opts = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    return { status: r.status, ok: r.ok, j, text };
  } catch (e) {
    return { status: 0, ok: false, j: null, text: `network: ${e.message}` };
  } finally { clearTimeout(t); }
}

const BROWSER_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://gonkagate.com",
  "Referer": "https://gonkagate.com/",
};

// ---- registry ----
function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return [];
  let raw;
  try { raw = readFileSync(REGISTRY_PATH, "utf8").replace(/^\uFEFF/, ""); } // BOM-strip
  catch (e) { throw new Error(`registry unreadable: ${e.message}`); }
  try { return JSON.parse(raw); }
  catch (e) {
    // NEVER return [] on corruption â€” that would overwrite the fleet on next save.
    throw new Error(`REGISTRY CORRUPT at ${REGISTRY_PATH} (${e.message}). Refusing to proceed â€” restore .bak or rebuild, then re-run.`);
  }
}
function saveRegistry(reg) {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  if (existsSync(REGISTRY_PATH)) {
    try { copyFileSync(REGISTRY_PATH, `${REGISTRY_PATH}.bak`); } catch {}
  }
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), "utf8");
}
function runLogWrite(markdown) {
  mkdirSync(dirname(RUN_LOG_PATH), { recursive: true });
  writeFileSync(RUN_LOG_PATH, markdown, "utf8");
}

// ---- password ----
function makePassword() {
  const rnd = randomBytes(4).toString("hex");
  return `GnkGate!${rnd}`;
}

// ---- step 1: mint Emailnator dotGmail (retry 2x + rate-limit backoff) ----
async function mintEmail() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pace(MINT_MIN_GAP_MS, lastMintAt);
      const r = await f(`${EMAILNATOR}/api/generate-email`, { method: "POST", headers: EMAILNATOR_HDRS, body: JSON.stringify({ ids: [3] }) });
      lastMintAt = Date.now();
      if (r.j?.email) return r.j.email;
      const body = r.text.slice(0, 200);
      const looksRateLimited = /rate|limit|too many|try again|temporar|429/i.test(body) || r.status === 429;
      if (looksRateLimited) {
        log(`  emailnator rate-limited (${r.status}: ${body}) â€” backing off 45s`);
        await sleep(45000);
        lastMintAt = 0;
        continue;
      }
      if (attempt < 3) {
        log(`  emailnator mint transient fail (${r.status}: ${body}) â€” retry ${attempt} in 5s`);
        await sleep(5000);
        continue;
      }
      throw new Error(`emailnator mint failed after 3 tries: ${r.status} ${body}`);
    } catch (e) {
      if (attempt < 3 && /network|fetch failed/i.test(e.message)) {
        log(`  emailnator network error (${e.message}) â€” retry ${attempt} in 5s`);
        await sleep(5000);
        continue;
      }
      throw e;
    }
  }
  throw new Error("emailnator mint exhausted");
}

// ---- step 2: register ----
async function register(email, password) {
  await pace(REGISTER_MIN_GAP_MS, lastRegisterAt);
  const r = await f(`${AUTH_HOST}/api/v1/auth/register`, {
    method: "POST",
    headers: BROWSER_HEADERS,
    body: JSON.stringify({ email, password }),
  });
  lastRegisterAt = Date.now();
  if (r.status === 201 || r.status === 200) {
    consecutiveThrottles = 0; // healthy â€” reset the abort counter
    return r.j;
  }
  const text = r.text.slice(0, 250);
  if (isThrottle(r.status, text)) {
    consecutiveThrottles++;
    log(`  âš  THROTTLE #${consecutiveThrottles}/${THROTTLE_ABORT_AFTER} on register (HTTP ${r.status}: ${text})`);
    if (consecutiveThrottles >= THROTTLE_ABORT_AFTER) {
      throw new Error(`ABORT: ${THROTTLE_ABORT_AFTER} consecutive throttles on register â€” IP risk. STOPPING run (never hammer a dead window). Last: HTTP ${r.status} ${text}`);
    }
    await sleep(30000); // cool down between throttle retries
  } else {
    consecutiveThrottles = 0;
  }
  throw new Error(`register failed: HTTP ${r.status} ${text}`);
}

// ---- emailnator inbox helpers ----
async function emailnatorMessages(email) {
  const r = await f(`${EMAILNATOR}/api/message-list`, { method: "POST", headers: EMAILNATOR_HDRS, body: JSON.stringify({ email, limit: 20 }) });
  return r.j?.messages || [];
}
async function emailnatorRead(id) {
  const r = await f(`${EMAILNATOR}/api/message/${encodeURIComponent(id)}`);
  return r.j || {};
}
function extractVerifyToken(content) {
  if (!content) return null;
  const c = String(content);
  const m = c.match(/verify-email\?token=([A-Za-z0-9_-]{20,})/) ||
            c.match(/verify-email[^"'<>\s]*token[=:]([A-Za-z0-9_-]{20,})/) ||
            c.match(/token[=:]["']?([A-Za-z0-9_-]{40,})["']?/);
  return m ? m[1] : null;
}

// ---- step 3: poll inbox for GonkaGate verification token ----
async function waitVerifyToken(email, timeoutMs = MAIL_POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let resent = false;
  while (Date.now() < deadline) {
    await sleep(MAIL_POLL_INTERVAL_MS);
    try {
      const msgs = await emailnatorMessages(email);
      const hit = msgs.find((m) => /gonkagate|confirm.*email|verify.*email/i.test(`${m.from || ""} ${m.subject || ""}`));
      if (hit) {
        const full = await emailnatorRead(hit.id);
        const token = extractVerifyToken(full.content || "");
        if (token) return { token, subject: hit.subject, from: hit.from };
      }
    } catch {}
    if (!resent && Date.now() - (deadline - timeoutMs) >= RESEND_AFTER_MS) {
      resent = true;
      try {
        await f(`${AUTH_HOST}/api/v1/auth/resend-verification`, { method: "POST", headers: BROWSER_HEADERS, body: JSON.stringify({ email }) });
        log(`  [mail] no mail after 90s â€” resend-verification triggered`);
      } catch {}
    }
  }
  return null;
}

// ---- step 4: verify email ----
async function verifyEmail(token) {
  const r = await f(`${AUTH_HOST}/api/v1/auth/verify-email`, { method: "POST", headers: BROWSER_HEADERS, body: JSON.stringify({ token }) });
  if (r.status !== 200 && r.status !== 201) throw new Error(`verify-email failed: HTTP ${r.status} ${r.text.slice(0, 250)}`);
  return r.j;
}

// ---- step 5: login ----
async function login(email, password) {
  const r = await f(`${AUTH_HOST}/api/v1/auth/login`, { method: "POST", headers: BROWSER_HEADERS, body: JSON.stringify({ email, password }) });
  if (r.status !== 200 && r.status !== 201) throw new Error(`login failed: HTTP ${r.status} ${r.text.slice(0, 250)}`);
  const d = r.j?.data || r.j || {};
  const token = d.token || d.accessToken || d.jwt || r.j?.token;
  if (!token) throw new Error(`login: no token in response: ${r.text.slice(0, 200)}`);
  return token;
}

// ---- step 6: dashboard user (balance) ----
async function dashboardUser(jwt) {
  const r = await f(`${AUTH_HOST}/api/v1/dashboard/user`, { headers: { ...BROWSER_HEADERS, Authorization: `Bearer ${jwt}` } });
  if (r.status !== 200) return { status: r.status, usd: null, text: r.text.slice(0, 200) };
  return { status: 200, usd: r.j?.data?.balance?.usd ?? null, text: "" };
}

// ---- step 7: create API key ----
async function createKey(jwt, name) {
  const r = await f(`${AUTH_HOST}/api/v1/dashboard/api-keys`, {
    method: "POST",
    headers: { ...BROWSER_HEADERS, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ name }),
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`create key failed: HTTP ${r.status} ${r.text.slice(0, 250)}`);
  const key = r.j?.data?.apiKey || r.j?.apiKey;
  if (!key) throw new Error(`create key: no apiKey in response: ${r.text.slice(0, 200)}`);
  return { key, masked: r.j?.data?.maskedKey || "", id: r.j?.data?.id || "" };
}

// ---- step 8: chat smoke test (60s timeout) ----
async function chatTest(key, model = "deepseek-ai/deepseek-v4-flash-0731") {
  const t0 = Date.now();
  const r = await f(`${API_HOST}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "say OK" }], max_tokens: 32 }),
  }, CHAT_TIMEOUT_MS);
  return { status: r.status, ms: Date.now() - t0, body: r.j, text: r.text };
}

// ---- one full account ----
async function createOne(index, opts = {}) {
  const t0 = Date.now();
  const steps = {};

  let email;
  let ts = Date.now();
  email = await mintEmail();
  steps.mintMs = Date.now() - ts;
  log(`[acct ${index}] email=${email} (mint ${(steps.mintMs / 1000).toFixed(1)}s)`);

  const password = opts.password || makePassword();

  ts = Date.now();
  await register(email, password);
  steps.registerMs = Date.now() - ts;
  log(`[acct ${index}] register â†’ 201 (${(steps.registerMs / 1000).toFixed(1)}s)`);

  ts = Date.now();
  const vt = await waitVerifyToken(email);
  steps.mailMs = Date.now() - ts;
  if (!vt) throw new Error(`no verification email within ${Math.round(MAIL_POLL_TIMEOUT_MS/1000/60)}min (email=${email})`);
  log(`[acct ${index}] verify token received (${vt.subject}) after ${(steps.mailMs / 1000).toFixed(1)}s`);

  ts = Date.now();
  await verifyEmail(vt.token);
  steps.verifyMs = Date.now() - ts;
  log(`[acct ${index}] email verified (${(steps.verifyMs / 1000).toFixed(1)}s)`);

  ts = Date.now();
  const jwt = await login(email, password);
  steps.loginMs = Date.now() - ts;
  log(`[acct ${index}] login â†’ JWT (${(steps.loginMs / 1000).toFixed(1)}s)`);

  ts = Date.now();
  let bal = await dashboardUser(jwt);
  steps.balanceMs = Date.now() - ts;
  let balanceUsd = bal.usd;
  // $10 auto-grant is LAZY (observed ~1 min after email verify). Wait for it.
  if (balanceUsd === null || parseFloat(balanceUsd) <= 0) {
    const bDeadline = Date.now() + BONUS_POLL_TIMEOUT_MS;
    let waitedS = 0;
    while (Date.now() < bDeadline && (balanceUsd === null || parseFloat(balanceUsd) <= 0)) {
      await sleep(BONUS_POLL_INTERVAL_MS);
      waitedS += BONUS_POLL_INTERVAL_MS / 1000;
      bal = await dashboardUser(jwt);
      balanceUsd = bal.usd;
      log(`  [acct ${index}] bonus-wait ${waitedS.toFixed(0)}s â†’ balance=$ ${balanceUsd ?? "n/a"} (${bal.status})`);
    }
    steps.bonusWaitMs = waitedS * 1000;
  }
  log(`[acct ${index}] balance=$ ${balanceUsd ?? "n/a"} (${bal.status})`);

  ts = Date.now();
  const kk = await createKey(jwt, `lane-${index}`);
  steps.keyMs = Date.now() - ts;
  log(`[acct ${index}] key created (${kk.key.slice(0, 6)}...${kk.key.slice(-4)})`);

  const record = {
    email,
    password,
    jwt,
    key: kk.key,
    keyId: kk.id,
    balance: balanceUsd ? `$${balanceUsd}` : "$0",
    balanceUsd: balanceUsd ?? null,
    verified: true,           // email-verified + funded ($10 auto-grant)
    chatVerified: null,       // filled by `verify`
    createdAt: new Date().toISOString(),
    source: "gonkagate-factory",
  };
  return { record, ms: Date.now() - t0, steps, balanceStatus: bal.status };
}

// ---- CLI ----
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "create") {
  const n = parseInt(args[1] || "1", 10);
  const fromIdx = (() => {
    const i = args.indexOf("--from");
    return i >= 0 ? parseInt(args[i + 1] || "0", 10) : 0;
  })();
  const outFile = (() => {
    const i = args.indexOf("--out");
    return i >= 0 ? args[i + 1] : null;
  })();
  const reg = loadRegistry();
  const startT = Date.now();
  const results = [];

  runLogWrite(`# GonkaGate Factory Run â€” ${new Date().toISOString()}\n\n` +
    `Target: ${n} accounts total Â· mode: sequential + paced Â· host ${AUTH_HOST}\n` +
    `Registry at start: ${reg.length} accounts\n\n`);
  _logMd = `# GonkaGate Factory Run â€” ${new Date().toISOString()}\n\n` +
    `Target: ${n} accounts total Â· mode: sequential + paced Â· host ${AUTH_HOST}\n` +
    `Registry at start: ${reg.length} accounts\n\n`;

let idx = fromIdx || reg.length + 1;
  // SAFETY BOUND: if the target is unreachable (e.g. mail provider blocking/failing),
  // the loop must NOT spin forever minting emails. Cap total attempts generously.
  const MAX_ATTEMPTS = Math.max(n * 3, 15);
  let attempts = 0;
  while (reg.length < n) {
    if (++attempts > MAX_ATTEMPTS) {
      log(`\nABORT: ${MAX_ATTEMPTS} attempts without reaching target ${n} (registry ${reg.length}) — mail/provider likely failing. STOPPING (never hammer a dead window).`);
      runLogWrite(runLogMarkdown() + `\n## ABORTED (attempt cap)\n\nReached ${MAX_ATTEMPTS} attempts, registry ${reg.length}/${n}.\n`);
      break;
    }
    if (reg.length >= IP_CAP) {
      log(`\nIP CAP reached: ${reg.length} >= ${IP_CAP} accounts this lane/window â€” STOPPING (IP safety). Use a fresh egress lane for more (sakana L-028).`);
      break;
    }
    let acct = null;
    try {
      acct = await createOne(idx);
    } catch (e) {
      if (/^ABORT:/.test(e.message)) {
        log(`\n${e.message}`);
        runLogWrite(runLogMarkdown() + `\n## ABORTED\n\n${e.message}\n`);
        process.exit(3);
      }
      log(`FAILED #${idx}: ${e.message}`);
      results.push({ index: idx, error: e.message });
      runLogWrite(runLogMarkdown({ index: idx, email: "(mint/failed)", error: e.message, ms: 0, steps: {}, balance: null }));
      idx++;
      continue;
    }

    // never duplicate an existing email in the registry
    if (reg.some((a) => a.email === acct.record.email)) {
      log(`  WARN email ${acct.record.email} already in registry â€” skipping (not re-creating)`);
      idx++;
      continue;
    }

    reg.push(acct.record);
    saveRegistry(reg);
    results.push({ index: idx, email: acct.record.email, ms: acct.ms, ok: true });
    log(`CREATED #${idx} ${acct.record.email} key=${acct.record.key.slice(0, 6)}... balance=${acct.record.balance} in ${(acct.ms / 1000).toFixed(1)}s`);
    runLogWrite(runLogMarkdown({ index: idx, email: acct.record.email, ms: acct.ms, steps: acct.steps, balance: acct.record.balance, keyHint: acct.record.key.slice(0, 6) }));
    // batch-egress mode (sakana L-028 multi-egress lane): --out <file> writes each new
    // account to an append-only JSONL so a GH/fresh-IP worker can ship results home
    // without touching the shared registry (merged locally afterwards).
    if (outFile) {
      appendFileSync(outFile, JSON.stringify(acct.record) + "\n", "utf8");
    }
    idx++;
  }

  const totalMs = Date.now() - startT;
  const ok = results.filter((r) => r.ok).length;
  const summary =
    `\n## Summary\n\n- Created: ${ok}/${reg.length} in registry (${(totalMs / 1000).toFixed(0)}s total, avg ${(totalMs / 1000 / Math.max(1, ok)).toFixed(0)}s/acct)\n` +
    `- Registry: ${REGISTRY_PATH}\n` +
    `- Failures: ${results.filter((r) => !r.ok).length}\n`;
  log(`\nDONE: ${ok} accounts in registry of ${n} target in ${(totalMs / 1000).toFixed(0)}s (avg ${(totalMs / 1000 / Math.max(1, ok)).toFixed(0)}s/acct). Registry: ${REGISTRY_PATH}`);
  runLogWrite(runLogMarkdown() + "\n" + summary);
} else if (cmd === "verify") {
  const email = args[1];
  if (!email) { console.error("usage: verify <email>"); process.exit(1); }
  const reg = loadRegistry();
  const acct = reg.find((a) => a.email === email);
  if (!acct) { console.error(`account not in registry: ${email}`); process.exit(1); }
  console.log(`key=${acct.key.slice(0, 6)}... chat test (60s)...`);
  const chat = await chatTest(acct.key);
  console.log(`chat â†’ ${chat.status} (${chat.ms}ms)`);
  if (chat.status === 200) {
    console.log(`reply: ${(chat.body?.choices?.[0]?.message?.content || "").slice(0, 80)}`);
    acct.chatVerified = true;
    saveRegistry(reg);
    console.log(`registry updated: chatVerified=true`);
    process.exitCode = 0;
  } else {
    console.log(`error: ${chat.body?.error?.message || chat.text.slice(0, 200)}`);
    acct.chatVerified = false;
    saveRegistry(reg);
    process.exitCode = 1;
  }
} else if (cmd === "status") {
  const reg = loadRegistry();
  const funded = reg.filter((a) => a.balanceUsd && parseFloat(a.balanceUsd) > 0).length;
  const total = reg.reduce((s, a) => s + (parseFloat(a.balanceUsd) || 0), 0);
  console.log(`registry: ${REGISTRY_PATH}`);
  console.log(`count: ${reg.length}`);
  console.log(`funded: ${funded}  unfunded: ${reg.length - funded}  total balance: $${total.toFixed(2)}`);
  for (const a of reg) {
    console.log(`  #${reg.indexOf(a) + 1} ${a.email}  balance=${a.balance}  verified=${a.verified}  chat=${a.chatVerified ?? "â€”"}  key=${a.key.slice(0, 6)}...`);
  }
} else {
  console.error(`usage:
  node gonkagate-factory.mjs create <n> [--from <startIdx>] [--out <jsonl-file>]
  node gonkagate-factory.mjs verify <email>
  node gonkagate-factory.mjs status`);
  process.exit(1);
}

// ---- run-log helpers ----
function runLogMarkdown(entry) {
  if (entry) {
    const steps = entry.steps || {};
    _logMd = (_logMd || "") + `\n## Account ${entry.index} â€” ${entry.email}\n\n` +
      (entry.error
        ? `- **FAILED**: ${entry.error}\n`
        : `- steps: mint ${((steps.mintMs || 0) / 1000).toFixed(1)}s Â· register ${((steps.registerMs || 0) / 1000).toFixed(1)}s Â· mail-wait ${((steps.mailMs || 0) / 1000).toFixed(1)}s Â· verify ${((steps.verifyMs || 0) / 1000).toFixed(1)}s Â· login ${((steps.loginMs || 0) / 1000).toFixed(1)}s Â· bonus-wait ${((steps.bonusWaitMs || 0) / 1000).toFixed(1)}s Â· key ${((steps.keyMs || 0) / 1000).toFixed(1)}s\n` +
        `- total: ${(entry.ms / 1000).toFixed(1)}s Â· balance: ${entry.balance} Â· key: ${entry.keyHint}...\n`);
    return _logMd;
  }
  return _logMd || "";
}
