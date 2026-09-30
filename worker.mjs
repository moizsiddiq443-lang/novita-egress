#!/usr/bin/env node
// novita-egress worker -- runs on a GHA ubuntu-latest public runner (fresh IP + fresh device).
// usage: node worker.mjs <mode> <referral_code> <seed> <email_source>
//   mode: recon | full | hub
// Output: result.json.enc (AES-256-GCM, key = sha256(ENC_KEY env)) + log.txt (redacted).
import { writeFileSync, existsSync } from "node:fs";
import { createHash, createCipheriv, randomBytes } from "node:crypto";

const MODE = process.argv[2] || "recon";
const REFERRAL = process.argv[3] || "";
const SEED = process.argv[4] || Math.random().toString(36).slice(2, 10);
const EMAIL_SRC = process.argv[5] || "auto";
const ENC_KEY = process.env.ENC_KEY || "";
const RUN_ID = process.env.GITHUB_RUN_ID || ("local-" + Date.now());
const HEADLESS = (process.env.HEADLESS || "1") === "1";

const STARTED = new Date().toISOString();
const EMAILNATOR = "https://www.emailnator.com";
const EH = { "Content-Type": "application/json", Accept: "application/json" };
const NOVITA = "https://novita.ai";

const logLines = [];
function log() {
  const s = Array.from(arguments).join(" ");
  logLines.push(s);
  console.log(s);
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function redact(s) {
  return String(s)
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g, "<email>")
    .replace(/NovitaF_2026![A-Za-z0-9]{8}/g, "<pw>");
}

async function f(url, opts, timeoutMs) {
  if (opts === undefined) opts = {};
  if (timeoutMs === undefined) timeoutMs = 60000;
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  try {
    const r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    return { status: r.status, ok: r.ok, j: j, text: text };
  } catch (e) {
    return { status: 0, ok: false, j: null, text: ("network: " + e.message) };
  } finally {
    clearTimeout(t);
  }
}

// ---------- encryption ----------
function encrypt(plain) {
  const k = createHash("sha256").update(ENC_KEY || "dev").digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}

// ---------- email sources ----------
const PREFIXES = ["aurora", "nimbus", "vela", "orion", "lyra", "zephyr", "astra", "nova", "ember", "solace", "kestrel", "lumia", "quasar", "sable", "tindra", "ventus", "wren", "xylo", "yara", "zelda"];

async function mintEmailnator() {
  for (let attempt = 1; attempt <=  3; attempt++) {
    try {
      const r = await f(EMAILNATOR + "/api/generate-email", { method: "POST", headers: EH, body: JSON.stringify({ ids: [3] }) });
      if (r.j && r.j.email) return r.j.email;
      const body = r.text.slice(0, 150);
      if (/rate|limit|temporar|429/i.test(body)) { log("  emailnator rate-limited " + r.status + " -- backing off 30s"); await sleep(30000); continue; }
      if (attempt < 3) { await sleep(5000); continue; }
      throw new Error("emailnator mint failed: " + r.status + " " + body);
    } catch (e) {
      if (attempt < 3 && /network|fetch failed/i.test(e.message)) { await sleep(5000); continue; }
      throw e;
    }
  }
}

async function emailnatorMessages(email) {
  const r = await f(EMAILNATOR + "/api/message-list", { method: "POST", headers: EH, body: JSON.stringify({ email: email, limit: 20 }) });
  return (r.j && r.j.messages) ? r.j.messages : [];
}
async function emailnatorRead(id) {
  const r = await f(EMAILNATOR + "/api/message/" + encodeURIComponent(id));
  return r.j ? r.j : {};
}

function makePassword() { return "NovitaF_2026!" + randomBytes(4).toString("hex"); }

function extractVerifyLink(content, subject) {
  if (!content) return null;
  const c = String(content);
  const urls = c.match(/https?:\/\/[^"'<>\s]+/g) || [];
  const scored = [];
  for (const u of urls) {
    if (/verify|confirm|activate|token|email/i.test(u + " " + (subject || ""))) scored.push(u);
  }
  if (scored.length) return scored.sort(function (a, b) { return b.length - a.length; })[0];
  const nv = [];
  for (const u of urls) {
    if (/novita\.ai/.test(u) && !/^https?:\/\/novita\.ai\/?$/.test(u)) nv.push(u);
  }
  return nv.length ? nv.sort(function (a,b) { return b.length - a.length; })[0] : null;
}

// ---------- result envelope ----------
const OUT = { mode: MODE, run_id: RUN_ID, startedAt: STARTED, seed: SEED, email_source_used: null, ok: false, verify_status: null, errors: [], warnings: [], referral_code: null, referral_link: null, balance_text: null, api_key: null, finishedAt: null };
function done(code) {
  OUT.finishedAt = new Date().toISOString();
  const plain = JSON.stringify(OUT, null, 2);
  try {
    writeFileSync("result.json.enc", encrypt(plain));
    log("result written (encrypted, " + plain.length + " bytes plaintext)");
  } catch (e) { log("encrypt/write fail: " + e.message); }
  try { writeFileSync("log.txt", logLines.map(redact).join("\n")); } catch (e) {}
  log("done.");
  process.exit(code);
}
process.on("uncaughtException", function (e) { log("FATAL: " + e.message); OUT.errors.push("fatal: " + e.message); done(1); });

// ---------- browser layer ----------
let browser = null;
let CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CHROME_CANDIDATES = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"];
function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    try { if (existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

async function launch() {
  const puppeteer = (await import("puppeteer-core")).default;
  let exe = findChrome();
  if (!exe) {
    const { execSync } = await import("node:child_process");
    try { exe = execSync("which google-chrome chromium-browser chromium 2>/dev/null | head -1").toString().trim(); } catch (e) { exe = null; }
  }
  if (!exe) throw new Error("no chrome binary found on runner");
  browser = await puppeteer.launch({
    executablePath: exe,
    headless: HEADLESS ? "new" : false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled", "--window-size=1280,900", "--lang=en-US", "--disable-features=IsolateOrigins,site-per-process"],
    defaultViewport: { width: 1280, height: 900 }
  });
  log("chrome launched headless=" + HEADLESS + " exe=" + exe);
  // match UA to the REAL chrome version (UA mismatch is a CF flag)
  try {
    const v = await browser.version();
    const m = v.match(/Chrome\/(\d+)/);
    if (m) {
      CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + m[1] + ".0.0.0 Safari/537.36";
      log("chrome version: " + m[1]);
    }
  } catch (e) {}
  return puppeteer;
}

async function makePage() {
  const page = await browser.newPage();
  await page.setUserAgent(CHROME_UA);
  await page.evaluateOnNewDocument(function () {
    Object.defineProperty(navigator, "webdriver", { get: function () { return undefined; } });
    Object.defineProperty(Navigator.prototype, "webdriver", { get: function () { return undefined; } });
    window.chrome = window.chrome || { runtime: {} };
    try {
      Object.defineProperty(navigator, "plugins", { get: function () { return [1, 2, 3, 4, 5]; } });
      Object.defineProperty(navigator, "languages", { get: function () { return ["en-US", "en"]; } });
    } catch (e) {}
    const origQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (origQuery) {
      window.navigator.permissions.query = function (p) {
        return (p && p.name === "notifications") ? Promise.resolve({ state: Notification.permission }) : origQuery(p);
      };
    }
  });
  await page.setViewport({ width: 1280, height: 900 });
  return page;
}

async function pageText(page) {
  const r = await page.evaluate(function () { return document.body ? document.body.innerText : ""; });
  return r ? r : "";
}

async function clickCreateWithEmail(page) {
  const selectors = ["button:not([type=submit])", "a", "div[role=button]", "button"];
  for (const sel of selectors) {
    try {
      const els = await page.$$(sel);
      for (const el of els) {
        try {
          const tx = (await page.evaluate(function (e) { return e.innerText || e.textContent || ""; }, el)).replace(/\s+/g, " ").trim();
          if (/create with an email|sign up with email|continue with email/i.test(tx) && !/google|github|hugging/i.test(tx)) {
            await el.click();
            log("clicked create-with-email: " + tx.slice(0, 40));
            return true;
          }
        } catch (e) {}
      }
    } catch (e) {}
    if (await page.$$(sel).length === 0) continue;
  }
  return false;
}

async function clickSubmit(page) {
  try {
    return await page.evaluate(function () {
      const btns = Array.from(document.querySelectorAll("button[type=submit], button")).filter(function (b) { return /create|sign ?up|register|continue/i.test(b.innerText || ""); });
      if (btns.length) { btns[btns.length - 1].click(); return true; }
      return false;
    });
  } catch (e) { return false; }
}

async function dismissCookieModal(page) {
  try {
    const done = await page.evaluate(function () {
      // remove the Cybot overlay + dialog entirely, and click "Allow all" if present
      const overlay = document.querySelector("#CybotCookiebotDialogBodyUnderlay, .CookiebotWidget, #CybotCookiebotDialog");
      const btns = Array.from(document.querySelectorAll("button")).filter(function (b) { return /allow all|accept all|deny|reject all/i.test(b.innerText || ""); });
      if (btns.length) { btns[0].click(); }
      if (overlay) { overlay.remove(); }
      return btns.length > 0;
    });
    await sleep(800);
    return done;
  } catch (e) { return false; }
}

async function clickTermsCheckbox(page) {
  // Novita: custom (non-native) terms checkbox -- click by text, then native fallbacks
  try {
    const clickedText = await page.evaluate(function () {
      // 1) element whose text mentions the terms agreement
      const cands = Array.from(document.querySelectorAll("label, span, div, p")).filter(function (el) {
        const t = (el.innerText || "").trim();
        return /i agree to the terms|agree to the terms of service|terms of service and privacy/i.test(t) && t.length < 400;
      });
      for (const c of cands) {
        // click the label or its nearest clickable ancestor (NOT a huge container)
        let target = c;
        if (c.tagName === "DIV" && c.children.length) {
          const clickable = c.querySelector("label, span[role=checkbox], [role=checkbox], input[type=checkbox], a");
          if (clickable) target = clickable;
        }
        try {
          target.click();
          return true;
        } catch (e) {}
      }
      // 2) native checkbox inside any form
      const forms = Array.from(document.querySelectorAll("form"));
      for (const f of forms) {
        const boxes = Array.from(f.querySelectorAll("input[type=checkbox]"));
        for (const b of boxes) {
          const label = (b.closest("label") ? b.closest("label").innerText : "") + " " + (f.innerText || "").slice(0, 200);
          if (/agree|terms|privacy|accept/i.test(label)) {
            if (!b.checked) { b.click(); return true; }
            return true;
          }
        }
        if (boxes.length) { if (!boxes[0].checked) { boxes[0].click(); } return true; }
      }
      // 3) any [role=checkbox]
      const rc = document.querySelector("[role=checkbox]");
      if (rc) { const t = rc.getAttribute("aria-checked"); if (t !== "true") { rc.click(); } return true; }
      // 4) last native checkbox on page
      const all = Array.from(document.querySelectorAll("input[type=checkbox]"));
      if (all.length) { if (!all[all.length - 1].checked) { all[all.length - 1].click(); } return true; }
      return false;
    });
    await sleep(600);
    return clickedText;
  } catch (e) { return false; }
}

async function turnstileResponseValue(page) {
  try {
    return await page.evaluate(function () {
      const inp = document.querySelector("input[name='cf-turnstile-response'], [name='cf-turnstile-response']");
      return inp && inp.value ? inp.value : "";
    });
  } catch (e) { return ""; }
}

async function handleTurnstile(page) {
  try {
    // verify engine stealth first
    const wd = await page.evaluate(function () { return navigator.webdriver; });
    log("turnstile: navigator.webdriver=" + wd);
    await sleep(1500);
    const has = await page.evaluate(function () {
      return !!document.querySelector("iframe[src*='turnstile'], [id*='cf-chl-widget'], input[name='cf-turnstile-response']");
    });
    if (!has) { log("turnstile: none found"); return false; }
    log("turnstile: widget present");
    // scroll widget into view (visibility helps auto-solve)
    await page.evaluate(function () {
      const el = document.querySelector("iframe[src*='turnstile']");
      if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
    });
    await sleep(500);
    // PHASE 1: wait for auto-solve (non-interactive / clean IP) -- do NOT touch it
    for (let w = 0; w < 10; w++) {
      await sleep(2000);
      const v = await turnstileResponseValue(page);
      if (v && v.length > 20) { log("turnstile: AUTO-SOLVED"); return true; }
    }
    // PHASE 1b: did an interactive iframe appear during the wait?
    const ifr1 = await page.$("iframe[src*='turnstile'], iframe[src*='challenges.cloudflare']");
    if (ifr1) {
      log("turnstile: iframe appeared during wait -- clicking");
      try {
        const box = await ifr1.boundingBox();
        if (box) {
          await page.mouse.move(box.x + 30, box.y + box.height - 18, { steps: 3 });
          await sleep(200);
          await page.mouse.click(box.x + 30, box.y + box.height - 18);
          await sleep(3000);
          const v = await turnstileResponseValue(page);
          if (v && v.length > 20) { log("turnstile: SOLVED via wait-iframe"); return true; }
        }
      } catch (e) { log("turnstile: wait-iframe click err " + e.message); }
    }
    // PHASE 2: real-mouse click on the checkbox inside the iframe
    const iframe = await page.$("iframe[src*='turnstile']");
    if (iframe) {
      try {
        const box = await iframe.boundingBox();
        if (box) {
          // the checkbox is bottom-left inside the widget (standard turnstile)
          const cx = box.x + 22;
          const cy = box.y + box.height - 20;
          // human-ish movement: several steps with jitter
          for (let s = 1; s <= 6; s++) {
            await page.mouse.move(box.x + 60, box.y + 30, { steps: 2 });
            await page.mouse.move(box.x + 40 + Math.random() * 20, box.y + 20 + Math.random() * 15, { steps: 2 });
            await sleep(60 + Math.random() * 120);
          }
          await page.mouse.move(cx, cy, { steps: 3 });
          await sleep(250);
          await page.mouse.click(cx, cy);
          log("turnstile: mouse-clicked checkbox at " + Math.round(cx) + "," + Math.round(cy));
        }
      } catch (e) { log("turnstile: mouse click err " + e.message); }
      await sleep(3000);
      const v = await turnstileResponseValue(page);
      if (v && v.length > 20) { log("turnstile: SOLVED after mouse click"); return true; }
      // PHASE 3: frame DOM click fallback
      try {
        const fr = await iframe.contentFrame();
        if (fr) {
          const cb = await fr.$("input[type=checkbox], .cf-turnstile, button");
          if (cb) { await cb.click(); log("turnstile: frame-click fallback"); }
        }
      } catch (e) { log("turnstile: frame err " + e.message); }
      await sleep(3000);
      const v2 = await turnstileResponseValue(page);
      if (v2 && v2.length > 20) { log("turnstile: SOLVED after frame click"); return true; }
    }
    log("turnstile: NOT solved");
    // diagnostic: dump iframe content snippet
    try {
      const fr2 = await iframe.contentFrame();
      if (fr2) {
        const t = await fr2.evaluate(function () { return document.body ? document.body.innerText.slice(0, 200) : ""; });
        log("turnstile: frame text=" + t.replace(/\s+/g, " "));
      }
    } catch (e) {}
    return false;
  } catch (e) { log("turnstile err: " + e.message); return false; }
}

async function getVisibleError(page) {
  try {
    return await page.evaluate(function () {
      const sels = ["[role=alert]", ".error", ".alert", "[class*=error]", "[class*=message]", "small"];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.innerText && el.innerText.trim()) return el.innerText.trim().slice(0, 220);
      }
      return null;
    });
  } catch (e) { return null; }
}

// ---------- recon ----------
async function runRecon() {
  log("RECON: launching browser...");
  const puppeteer = await launch();
  const page = await makePage();
  const net = [];
  page.on("request", function (req) {
    const u = req.url();
    if (/\/api\/|auth|register|login|verify|user|account/i.test(u)) net.push({ m: req.method(), u: u.slice(0, 220), body: (req.postData() || "").slice(0, 300) });
  });
  await page.goto(NOVITA + "/user/register", { waitUntil: "networkidle2", timeout: 60000 }).catch(function (e) { log("recon: goto timeout"); });
  await sleep(2500);
  log("recon: title=" + (await page.title()));
  const hasCaptcha = await page.evaluate(function () {
    return !!document.querySelector("iframe[src*='turnstile'], .g-recaptcha, iframe[src*='recaptcha'], [id*='turnstile']");
  });
  log("recon: captcha-iframe-present=" + hasCaptcha);
  const t0 = await pageText(page);
  log("recon: page-text-head=" + t0.slice(0, 300).replace(/\s+/g, " "));
  await clickCreateWithEmail(page);
  await sleep(2500);
  const inputs = await page.evaluate(function () {
    return Array.from(document.querySelectorAll("input")).map(function (i) { return { type: i.type, name: i.name || "", placeholder: i.placeholder || "", id: i.id || "" }; });
  });
  log("recon: inputs=" + JSON.stringify(inputs));
  const buttons = await page.evaluate(function () {
    return Array.from(document.querySelectorAll("button")).map(function (b) { return (b.innerText || "").replace(/\s+/g, " ").trim(); }).filter(Boolean);
  });
  log("recon: buttons=" + JSON.stringify(buttons));
  try {
    const emailInput = await page.$("input[type=email], input[name*=email], input[placeholder*=mail]");
    if (emailInput) { await emailInput.click({ clickCount: 3 }); await emailInput.type("dummy.user.9731@gmail.com", { delay: 25 }); }
    const pwInputs = await page.$$("input[type=password]");
    for (let i = 0; i < pwInputs.length; i++) await pwInputs[i].type("DummyPass!" + i, { delay: 25 });
    await sleep(600);
    await page.evaluate(function () { const c = document.querySelector("input[type=checkbox]"); if (c && !c.checked) c.click(); });
    await sleep(400);
    const clickedSubmit = await clickSubmit(page);
    log("recon: submit-clicked=" + clickedSubmit);
    await sleep(4500);
  } catch (e) { log("recon: form-fill/submit err: " + e.message); }
  log("recon: captured-api-calls=" + JSON.stringify(net.slice(0, 15)));
  const afterErr = await getVisibleError(page);
  log("recon: post-submit-error=" + afterErr);
  const bodyText = (await pageText(page)).replace(/\s+/g, " ").slice(0, 400);
  log("recon: body-after=" + bodyText);
  try { await page.screenshot({ path: "recon.png", fullPage: true }); } catch (e) {}
  await browser.close();
  OUT.ok = true;
  OUT.warnings.push("recon done; api-hint=" + JSON.stringify(net.slice(0, 6)));
  done(0);
}

// ---------- full flow ----------
async function mintEmail() {
  if (EMAIL_SRC === "mailtm") {
    try { const m = await mintMailtm(); OUT.email_source_used = "mailtm"; return m; } catch (e) { log("mailtm fail: " + e.message); if (EMAIL_SRC === "mailtm") throw e; }
  }
  try {
    const addr = await mintEmailnator();
    OUT.email_source_used = "emailnator";
    return { addr: addr, pw: makePassword(), inboxKind: "emailnator" };
  } catch (e) {
    log("emailnator fail: " + e.message);
    if (EMAIL_SRC === "emailnator") throw e;
  }
  const m = await mintMailtm();
  OUT.email_source_used = "mailtm";
  return m;
}

async function mintMailtm() {
  const d = await f("https://api.mail.tm/domains");
  const doms = (d.j && d.j["hydra:member"]) ? d.j["hydra:member"].map(function (x) { return x.domain; }) : [];
  if (!doms.length) throw new Error("mail.tm: no domains");
  const domain = doms[Math.floor(Math.random() * doms.length)];
  const prefix = PREFIXES[Math.floor(Math.random() * PREFIXES.length)] + (1000 + Math.floor(Math.random() * 9000));
  const addr = prefix + "@" + domain;
  const pw = makePassword();
  const ac = await f("https://api.mail.tm/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: addr, password: pw }) });
  if (ac.status !== 201 && ac.status !== 200) throw new Error("mail.tm account fail: " + ac.status + " " + ac.text.slice(0, 150));
  const tk = await f("https://api.mail.tm/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: addr, password: pw }) });
  const token = (tk.j && tk.j.token) ? tk.j.token : null;
  if (!token) throw new Error("mail.tm: no token");
  return { addr: addr, pw: pw, token: token, inboxKind: "mailtm" };
}

async function pollNovitaMail(acct, timeoutMs) {
  if (timeoutMs === undefined) timeoutMs = 240000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(9000);
    try {
      let msgs = [];
      if (acct.inboxKind === "emailnator") msgs = await emailnatorMessages(acct.addr);
      else msgs = await mailtmMessages(acct.token);
      for (const m of msgs) {
        if (/novita/i.test((m.from || "") + " " + (m.subject || ""))) {
          let full = {};
          if (acct.inboxKind === "emailnator") full = await emailnatorRead(m.id);
          else full = await mailtmRead(acct.token, m.id);
          const content = full.content || (full.html && full.html.join("\n")) || full.text || "";
          const link = extractVerifyLink(content, m.subject);
          if (link) return { subject: m.subject, from: m.from || "", link: link };
        }
      }
    } catch (e) { log("poll mail err: " + e.message); }
  }
  return null;
}

async function mailtmMessages(token) {
  const r = await f("https://api.mail.tm/messages", { headers: { Authorization: "Bearer " + token } });
  return (r.j && r.j["hydra:member"]) ? r.j["hydra:member"] : [];
}
async function mailtmRead(token, id) {
  const r = await f("https://api.mail.tm/messages/" + id, { headers: { Authorization: "Bearer " + token } });
  return r.j ? r.j : {};
}

async function runFull(isHub) {
  const email = await mintEmail();
  const pw = email.pw;
  log("email source: " + OUT.email_source_used + " (mint ok)");
  const puppeteer = await launch();
  const page = await makePage();
  try {
    log("opening register page...");
    await page.goto(NOVITA + "/user/register", { waitUntil: "networkidle2", timeout: 60000 }).catch(function () { log("goto register timeout"); });
    await sleep(2000);
    await dismissCookieModal(page);
    log("cookie modal dismissed");
    // terms FIRST -- Novita gates the email form behind the agreement
    const termsFirst = await clickTermsCheckbox(page);
    log("terms clicked (pre): " + termsFirst);
    const clicked = await clickCreateWithEmail(page);
    log("create-with-email clicked: " + clicked);
    let emailInput = null;
    for (let w = 0; w < 15 && !emailInput; w++) {
      await sleep(700);
      emailInput = await page.$("input[type=email], input[name*=email], input[placeholder*=mail]");
    }
    if (!emailInput) throw new Error("no email input found after create-with-email");
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(email.addr, { delay: 22 });
    const pwInputs = await page.$$("input[type=password]");
    for (let i = 0; i < pwInputs.length; i++) await pwInputs[i].type(pw, { delay: 22 });
    await sleep(500);
    const termsOk = await clickTermsCheckbox(page);
    log("terms checkbox clicked: " + termsOk);
    await sleep(400);
    const turnstileOk = await handleTurnstile(page);
    log("turnstile solved: " + turnstileOk);
    OUT.warnings.push(turnstileOk ? "turnstile-solved" : "turnstile-NOT-solved");
    // submit with retries: invisible widgets often issue the token on/after submit
    let submitted = false;
    let outcome = "unknown";
    let errText = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      submitted = await clickSubmit(page);
      log("submitted=" + submitted + " (attempt " + (attempt + 1) + ")");
      await sleep(4000);
      const v = await turnstileResponseValue(page);
      if (v && v.length > 20) log("turnstile: response present after submit (len " + v.length + ")");
      const err = await getVisibleError(page);
      if (err && /agree to the terms|please agree|accept the terms/i.test(err)) {
        log("terms error after submit -- retrying terms checkbox");
        await clickTermsCheckbox(page);
        await sleep(600);
        continue;
      }
      // after a captcha error, the invisible widget sometimes materializes an interactive iframe
      if (err && /captcha/i.test(err)) {
        log("captcha error -- looking for challenge iframe");
        const v = await turnstileResponseValue(page);
        if (!(v && v.length > 20)) {
          const ifr = await page.$("iframe[src*='turnstile'], iframe[src*='challenges.cloudflare']");
          if (ifr) {
            try {
              const box = await ifr.boundingBox();
              if (box) {
                await page.mouse.move(box.x + 30, box.y + box.height - 18, { steps: 3 });
                await sleep(200);
                await page.mouse.click(box.x + 30, box.y + box.height - 18);
                log("turnstile: clicked challenge iframe after submit error");
                await sleep(4000);
              }
            } catch (e) { log("turnstile: post-submit iframe err " + e.message); }
          }
        }
      }
      // check for success signals
      const state = await page.evaluate(function () {
        return { u: location.href, b: (document.body ? document.body.innerText : "").slice(0, 300) };
      });
      if (/verify|check your email|verification/i.test(state.b)) { outcome = "awaiting-verification"; break; }
      if (/dashboard|home|overview/i.test(state.u)) { outcome = "auto-logged-in"; break; }
      if (/login/i.test(state.u)) { outcome = "needs-login"; break; }
      if (err) { errText = err; }
      if (attempt < 2) { log("no success signal yet -- retrying submit in 3s"); await sleep(3000); }
    }
    log("signup outcome: " + outcome + (errText ? (" | err: " + errText) : ""));
    if (errText && !/awaiting|verify/i.test(errText)) {
      OUT.errors.push("signup: " + errText);
      if (/domain|email.*(invalid|not allowed|unsupported|reject)/i.test(errText)) OUT.warnings.push("EMAIL-DOMAIN-REJECTED");
      await browser.close();
      done(1);
      return;
    }
    if (outcome === "awaiting-verification" || outcome === "unknown") {
      log("polling inbox for verification mail (up to 4 min)...");
      const v = await pollNovitaMail(email);
      if (v) {
        log("verify mail from " + v.from + " [" + v.subject + "] -- visiting link");
        OUT.verify_status = "link-received";
        await page.goto(v.link, { waitUntil: "networkidle2", timeout: 45000 }).catch(function () { log("verify-link goto timeout"); });
        await sleep(3000);
        const vs = await page.evaluate(function () { return { u: location.href, b: (document.body ? document.body.innerText : "").slice(0, 200) }; });
        log("post-verify url=" + vs.u + " text=" + vs.b.replace(/\s+/g, " "));
        OUT.verify_status = (/verified|success|dashboard/i.test(vs.b + vs.u)) ? "verified" : "verify-link-visited";
      } else {
        log("NO verify mail within 4 min");
        OUT.verify_status = "no-mail-seen";
        OUT.warnings.push("verify mail not observed within timeout");
      }
    }
    await page.goto(NOVITA + "/user/dashboard", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(function () { log("dashboard goto timeout"); });
    await sleep(3000);
    const cur = await page.evaluate(function () { return { u: location.href, b: (document.body ? document.body.innerText : "").slice(0, 200) }; });
    log("after dashboard nav: " + cur.u);
    if (/login/i.test(cur.u)) {
      log("needs login -- logging in");
      OUT.verify_status = OUT.verify_status || "manual-login";
      const ei = await page.$("input[type=email], input[name*=email], input[placeholder*=mail]");
      if (ei) {
        await ei.click({ clickCount: 3 });
        await ei.type(email.addr, { delay: 20 });
        const pi = await page.$$("input[type=password]");
        for (const p of pi) await p.type(pw, { delay: 20 });
        const ok = await page.evaluate(function () {
          const btns = Array.from(document.querySelectorAll("button[type=submit], button")).filter(function (b) { return /log ?in|sign ?in|continue/i.test(b.innerText || ""); });
          if (btns.length) { btns[btns.length - 1].click(); return true; }
          return false;
        });
        log("login-submit=" + ok);
        await sleep(5000);
      }
    }
    // referral code
    let refCode = null;
    let refLink = null;
    const paths = ["/user/referral", "/user/invite", "/user/account", "/user/profile"];
    for (const path of paths) {
      try {
        await page.goto(NOVITA + path, { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(2200);
        const txt = await pageText(page);
        const hrefs = await page.evaluate(function () {
          return Array.from(document.querySelectorAll("a")).map(function (a) { return a.href; }).filter(function (h) { return /ref|invite|register/i.test(h); }).slice(0, 5);
        });
        log(path + ": hrefs=" + JSON.stringify(hrefs));
        const m1 = txt.match(/(?:referral|invite|coupon)[^\n]{0,80}[^A-Za-z0-9]([A-Z0-9]{6,16})/i);
        const m2 = txt.match(/(?:code|code:)[^\n]{0,60}\b([A-Z0-9]{6,16})\b/i);
        const m3 = hrefs.find(function (h) { return /ref=|invite\//i.test(h); });
        let cand = null;
        if (m1) cand = m1[1];
        if (!cand && m2) cand = m2[1];
        if (!cand && m3) {
          const a = m3.match(/ref=([A-Za-z0-9_-]+)/);
          const b = m3.match(/\/invite\/([A-Za-z0-9_-]+)/);
          cand = (a && a[1]) ? a[1] : ((b && b[1]) ? b[1] : null);
        }
        if (cand) { refCode = cand; refLink = m3 || (NOVITA + "/register?ref=" + cand); log(path + ": found referral code " + refCode); break; }
      } catch (e) { log(path + ": err " + e.message); }
    }
    if (!refCode) { OUT.warnings.push("referral code not found on profile pages"); log("referral code NOT found"); }
    OUT.referral_code = refCode;
    OUT.referral_link = refLink;

    // balance snapshot (best effort
    try {
      await page.goto(NOVITA + "/user/billing", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(function () {});
      await sleep(2200);
      const bt = await pageText(page);
      const bm = bt.match(/\$[\d.,]+\s*(?:credit|balance)|(?:credit|balance)[^\n]{0,40}\$[\d.,]+/i);
      log("billing snapshot: " + (bm ? bm[0] : "no balance text"));
      OUT.balance_text = bm ? bm[0].slice(0, 120) : null;
    } catch (e) { log("billing scrape err: " + e.message); }
    // api key (best effort
    try {
      await page.goto(NOVITA + "/user/account", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(function () {});
      await sleep(2000);
      const ak = await page.evaluate(function () {
        const all = document.body ? document.body.innerText : "";
        const m = all.match(/\b(sk|nv|novita)-[A-Za-z0-9_-]{16,}\b/);
        return m ? m[0] : null;
      });
      if (ak) { OUT.api_key = ak.slice(0, 80); log("api key captured"); }
    } catch (e) { log("api-key scrape err: " + e.message); }
    await browser.close();
    OUT.ok = true;
    log("FULL DONE ok=true" + (isHub ? " (hub)" : ""));
    done(0);
  } catch (e) {
    log("FULL FAIL: " + e.message);
    OUT.errors.push(e.message);
    try { await browser.close(); } catch (e2) {}
    done(1);
  }
}

// ---------- main ----------
(async function () {
  log("worker v2 mode=" + MODE + " seed=" + SEED + " email_src=" + EMAIL_SRC + " run=" + RUN_ID + " started=" + STARTED);
  if (MODE === "recon") { await runRecon(); } else { await runFull(MODE === "hub"); }
})().catch(function (e) { console.error("MAIN FATAL:", e); process.exit(2); });