#!/usr/bin/env node
// glm-mint-worker.mjs — FRESH-IP Aliyun captcha minter for the GLM fleet bridge.
// Runs on a GitHub Actions ubuntu runner (its own egress IP), mints chat.z.ai
// captcha params with playwright chromium, and pushes each param to the local
// relay (cloudflared quick tunnel -> glm-fleet gateway pool).
//
// Usage: node scripts/glm-mint-worker.mjs [cycles=120] [gapS=10]
// Env:   RELAY_URL (required), MINT_RELAY_TOKEN (required),
//        FORCE=1 to mint regardless of relay /need,
//        HEADFUL=1 for headful (wrap with xvfb-run).
// Logs NEVER print full params (fingerprint + length only).
import crypto from "node:crypto";

const CYCLES = Math.max(1, Math.min(1000, Number(process.argv[2] || 120) || 120));
const GAP_S = Math.max(2, Math.min(600, Number(process.argv[3] || 10) || 10));
const RELAY = (process.env.RELAY_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.MINT_RELAY_TOKEN || "";
const FORCE = process.env.FORCE === "1";
const SRC = `gh-${process.env.GITHUB_RUN_ID || "local"}-${process.env.GITHUB_RUN_ATTEMPT || "0"}`;

if (!RELAY || !TOKEN) {
  console.error("RELAY_URL and MINT_RELAY_TOKEN are required");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fp = (p) => crypto.createHash("sha256").update(String(p)).digest("hex").slice(0, 10);
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

const MINT_FIRE = `
(async () => {
  try {
    if (!window.initAliyunCaptcha) {
      window.AliyunCaptchaConfig = { region: "sgp", prefix: "no8xfe" };
      await new Promise((res2, rej2) => {
        const SDK = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
        const r = document.querySelector('script[src="' + SDK + '"]');
        if (r && window.initAliyunCaptcha) return res2();
        if (r) { r.addEventListener("load", () => res2()); r.addEventListener("error", () => rej2(new Error("load failed"))); return; }
        const n = document.createElement("script"); n.src = SDK;
        n.onload = () => res2(); n.onerror = () => rej2(new Error("load failed"));
        document.head.appendChild(n);
      });
    }
    if (!window.initAliyunCaptcha) return JSON.stringify({ started: false, why: "initAliyunCaptcha missing" });
    const EL = "glm-mint-element2", BT = "glm-mint-trigger2";
    if (!document.getElementById(EL)) {
      const d = document.createElement("div"); d.id = EL;
      d.style.cssText = "position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none;";
      document.body.appendChild(d);
    }
    if (!document.getElementById(BT)) {
      const b = document.createElement("button"); b.id = BT; b.type = "button";
      b.setAttribute("aria-hidden", "true"); b.tabIndex = -1;
      b.style.cssText = "position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;";
      document.body.appendChild(b);
    }
    try { const old = window.__glmMintInst2; if (old && old.destroy) old.destroy(); } catch (e) {}
    window.__glmMint = null;
    window.initAliyunCaptcha({
      SceneId: (location.hostname === "chat.z.ai" ? "didk33e0" : "xswyjefn"),
      mode: "popup",
      element: "#" + EL,
      button: "#" + BT,
      captchaLogoImg: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
      language: "en",
      timeout: 10000,
      delayBeforeSuccess: false,
      success: (p) => { window.__glmMint = { ok: true, param: typeof p === "string" ? p : JSON.stringify(p), elapsed: Date.now() - window.__glmMintT0 }; },
      fail: (e) => { window.__glmMint = { ok: false, err: "fail:" + (typeof e === "string" ? e : JSON.stringify(e ?? null)) }; },
      onError: (e) => { window.__glmMint = { ok: false, err: "onError:" + (typeof e === "string" ? e : JSON.stringify(e ?? null)) }; },
      onClose: () => { window.__glmMint = window.__glmMint || { ok: false, err: "onClose" }; },
      getInstance: (i) => { window.__glmMintInst2 = i; },
    });
    window.__glmMintT0 = Date.now();
    let waits = 0;
    const iv = setInterval(() => {
      waits += 1;
      if (window.__glmMintInst2 && document.getElementById(BT)) { clearInterval(iv); document.getElementById(BT).click(); }
      else if (waits > 80) { clearInterval(iv); window.__glmMint = { ok: false, err: "getInstance never fired" }; }
    }, 100);
    return JSON.stringify({ started: true });
  } catch (e) { return JSON.stringify({ started: false, why: String((e && e.message) || e) }); }
})()`;

async function getNeed() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(`${RELAY}/need`, { headers: { "x-relay-token": TOKEN }, signal: ctl.signal });
    clearTimeout(t);
    if (r.status !== 200) return { need: true, http: r.status };
    return await r.json();
  } catch (e) {
    return { need: true, error: String(e.cause || e).slice(0, 120) };
  }
}

async function pushParam(param, mintMs) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(`${RELAY}/push`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-token": TOKEN },
      body: JSON.stringify({ param, ts: Date.now(), src: SRC }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    return r.status === 200 ? { ok: true, pool_size: j.pool_size } : { ok: false, error: `relay ${r.status} ${JSON.stringify(j).slice(0, 120)}` };
  } catch (e) {
    return { ok: false, error: String(e.cause || e).slice(0, 120) };
  }
}

async function mintOnce(page) {
  const t0 = Date.now();
  try {
    await page.goto("https://chat.z.ai/robots.txt", { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(900 + Math.floor(Math.random() * 500));
    // fresh page session each mint (freshness law: one reliable solve per session)
    await page.evaluate("window.__glmMint = null; window.__glmMintInst2 = null;");
    const fire = await page.evaluate(MINT_FIRE);
    const st = JSON.parse(typeof fire === "string" ? fire : "{}");
    if (!st.started) return { ok: false, err: `start failed: ${st.why}` };
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(400);
      const v = await page.evaluate("window.__glmMint ? JSON.stringify(window.__glmMint) : null").catch(() => null);
      if (v) {
        const m = JSON.parse(v);
        if (m.ok) return { ok: true, param: m.param, ms: m.elapsed ?? Date.now() - t0 };
        return { ok: false, err: String(m.err || "unknown").slice(0, 200) };
      }
    }
    return { ok: false, err: "mint timeout 25s" };
  } catch (e) {
    return { ok: false, err: `nav/eval: ${String(e.message || e).slice(0, 160)}` };
  }
}

(async () => {
  log(`glm-mint-worker start relay=${RELAY} cycles=${CYCLES} gap=${GAP_S}s force=${FORCE} src=${SRC}`);
  const { chromium } = await import("playwright");
  const headful = process.env.HEADFUL === "1";
  const browser = await chromium.launch({
    headless: !headful,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--lang=en-US"],
  });
  const ver = browser.version();
  const chromeVer = (ver.match(/(\d+\.\d+\.\d+\.\d+)/) || [, "131.0.0.0"])[1];
  const UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    timezoneId: "Asia/Singapore",
    userAgent: UA,
  });
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      if (!window.chrome) window.chrome = { runtime: {} };
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5].map((i) => ({ name: `Plugin ${i}`, filename: `plugin${i}.so` })) });
    } catch { /* best-effort stealth */ }
  });
  const page = await context.newPage();
  let minted = 0, pushed = 0, failed = 0, f011 = 0, idleSkips = 0;
  for (let i = 1; i <= CYCLES; i++) {
    if (f011 >= 4) { log("F011 x4 consecutive — runner IP looks flagged, exiting early"); break; }
    if (!FORCE) {
      const need = await getNeed();
      if (need && need.need === false) {
        idleSkips++;
        log(`[${i}] pool satisfied (size=${need.pool_size}) — idling ${GAP_S * 4}s`);
        await sleep(GAP_S * 4000);
        continue;
      }
    }
    const res = await mintOnce(page);
    if (res.ok) {
      minted++;
      f011 = 0;
      const p = await pushParam(res.param, res.ms);
      if (p.ok) { pushed++; log(`[${i}] mint ok solve_ms=${res.ms} len=${res.param.length} fp=${fp(res.param)} -> push ok pool=${p.pool_size}`); }
      else log(`[${i}] mint ok fp=${fp(res.param)} but PUSH FAILED: ${p.error}`);
    } else {
      failed++;
      if (/F011/.test(res.err)) { f011++; log(`[${i}] mint FAIL (F011 streak ${f011}): ${res.err.slice(0, 140)}`); }
      else log(`[${i}] mint FAIL: ${res.err.slice(0, 140)}`);
    }
    await sleep(Math.floor(GAP_S * 1000 * (0.6 + Math.random() * 0.8)));
  }
  await browser.close().catch(() => {});
  const summary = { minted, pushed, failed, f011, idleSkips, cycles: CYCLES, src: SRC };
  log(`MINT-BRIDGE-RESULT ${JSON.stringify(summary)}`);
})().catch((e) => { console.error("worker fatal:", e); process.exit(1); });
