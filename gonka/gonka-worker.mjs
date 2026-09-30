#!/usr/bin/env node
// gonka-worker.mjs -- runs on a GHA public runner (fresh IP). Spawns the gonkagate
// factory against a temp registry, encrypts the result with ENC_KEY (AES-256-GCM),
// writes result.json.enc + log.txt, deletes ALL plaintext. Safe for a public repo.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const FACTORY = join(__dir, "gonkagate-factory.mjs");
const count = parseInt(process.argv[2] || "6", 10);
const RUN_ID = process.env.GITHUB_RUN_ID || ("local-" + Date.now());
const TMP_REG = join(__dir, ".tmp-gonka-registry.json");
const ENC_KEY = process.env.ENC_KEY || "";
const OUT_ENC = "result.json.enc";
const LOG = [];

function log(m) { const s = "[" + new Date().toISOString() + "] " + m; LOG.push(s); console.log(s); }
function redact(s) {
  return String(s)
    .replace(/[a-zA-Z0-9._%+-]+@gmail\.com/g, "<email>")
    .replace(/(gp|sk)-[A-Za-z0-9_-]{20,}/g, "<key>")
    .replace(/key=\S+/g, "key=<redacted>");
}
function encrypt(plain) {
  const k = createHash("sha256").update(ENC_KEY || "dev").digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}

if (existsSync(TMP_REG)) { try { rmSync(TMP_REG, { force: true }); } catch (e) {} }
writeFileSync(TMP_REG, "[]", "utf8");
log("gonka-worker: creating " + count + " accounts on fresh egress IP (encrypted output)");

const r = spawnSync(process.execPath, [FACTORY, "create", String(count)], {
  cwd: __dir,
  env: Object.assign({}, process.env, {
    GONKAGATE_REGISTRY: TMP_REG,
    GONKAGATE_RUNLOG: join(__dir, ".tmp-runlog.md"),
    GONKAGATE_IP_CAP: String(count + 2),
    GONKA_QUIET: "1",
  }),
  encoding: "utf8",
  timeout: 600000, // 10 min watchdog
});
log("factory exit=" + r.status + " (stdout tail: " + (r.stdout || "").split("\n").slice(-6).join(" | ").slice(0, 500) + ")");

let results = [];
if (existsSync(TMP_REG)) {
  try { results = JSON.parse(readFileSync(TMP_REG, "utf8").replace(/^\uFEFF/, "")); } catch (e) { log("registry parse fail: " + e.message); }
}
if (results.length) {
  try {
    writeFileSync(OUT_ENC, encrypt(JSON.stringify(results, null, 2)));
    log("ENCRYPTED " + results.length + " accounts -> " + OUT_ENC);
  } catch (e) { log("encrypt/write fail: " + e.message); }
} else {
  log("0 accounts -- no result written");
}
try { writeFileSync("log.txt", LOG.map(redact).join("\n")); } catch (e) {}
for (const f of [TMP_REG, join(__dir, ".tmp-runlog.md")]) { try { rmSync(f, { force: true }); } catch (e) {} }
log("gonka-worker done.");
process.exit(r.status === 0 ? 0 : 1);