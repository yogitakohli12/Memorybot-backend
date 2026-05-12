#!/usr/bin/env node
/**
 * Connectivity / config doctor.
 * Run with:  npm run doctor   (from /backend)
 *
 * Tests every layer separately so you can see which layer breaks:
 *   1. Are the env vars actually loaded?
 *   2. Can DNS resolve the hosts?
 *   3. Can a raw TCP socket reach :443?
 *   4. Can Node's *native* fetch GET the API root (no custom dispatcher)?
 *   5. Can our undici dispatcher GET the API root?
 *   6. Does an actual auth'd /v1/models call succeed?
 */
require("dotenv").config();
// Apply httpAgent so doctor uses the SAME transport as the live server
// (otherwise the doctor could pass while the server still fails)
require("../utils/httpAgent");

const dns = require("dns").promises;
const net = require("net");
const tls = require("tls");

const HOSTS = [
  { host: "api.openai.com", probe: "https://api.openai.com/v1/models", keyEnv: "OPENAI_API_KEY" },
  { host: "api.groq.com", probe: "https://api.groq.com/openai/v1/models", keyEnv: "GROQ_API_KEY" },
  { host: "api.elevenlabs.io", probe: "https://api.elevenlabs.io/v1/voices", keyEnv: "ELEVENLABS_API_KEY", header: "xi-api-key" },
];

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const tick = (ok) => (ok ? c.green("✔") : c.red("✘"));

const dnsLookup = async (host) => {
  try {
    const r = await dns.resolve4(host);
    return { ok: true, ips: r.slice(0, 3) };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
};

const tcpConnect = (ip, port = 443, timeout = 5000) =>
  new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(r);
    };
    s.setTimeout(timeout);
    s.once("connect", () => finish({ ok: true }));
    s.once("timeout", () => finish({ ok: false, error: "timeout" }));
    s.once("error", (e) => finish({ ok: false, error: e.code || e.message }));
    s.connect(port, ip);
  });

const tlsHandshake = (host, port = 443, timeout = 8000, insecure = false) =>
  new Promise((resolve) => {
    const opts = { host, port, servername: host, timeout };
    if (insecure) opts.rejectUnauthorized = false;
    const s = tls.connect(opts, () => {
      const cert = s.getPeerCertificate();
      s.end();
      resolve({
        ok: true,
        issuer: cert?.issuer?.O || cert?.issuer?.CN || "?",
        subject: cert?.subject?.CN || "?",
      });
    });
    s.once("timeout", () => {
      s.destroy();
      resolve({ ok: false, error: "tls timeout" });
    });
    s.once("error", (e) =>
      resolve({ ok: false, error: e.code || e.message })
    );
  });

const nativeFetchTest = async (url, headers = {}) => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(t);
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e.cause?.code || e.code || e.message };
  }
};

const undiciFetchTest = async (url, headers = {}) => {
  try {
    const { fetch: ufetch } = require("undici");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const res = await ufetch(url, { headers, signal: ctrl.signal });
    clearTimeout(t);
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e.cause?.code || e.code || e.message };
  }
};

(async () => {
  console.log("\n" + c.bold("Memorybot Doctor"));
  console.log(c.dim("─".repeat(60)));

  // 1. Env
  console.log(c.bold("\n1. Environment"));
  const ev = (k) => {
    const v = process.env[k];
    if (!v) return c.red("missing");
    if (v.includes("your_") || v.includes("_here"))
      return c.yellow("placeholder — replace with real key");
    return c.green(`set (len=${v.length})`);
  };
  for (const k of [
    "OPENAI_API_KEY",
    "GROQ_API_KEY",
    "ELEVENLABS_API_KEY",
    "MONGO_URI",
    "AI_PROVIDER",
    "HTTPS_PROXY",
    "DISABLE_CUSTOM_HTTP",
    "USE_MOCK_AI",
  ]) {
    console.log(`   ${k.padEnd(22)} ${ev(k)}`);
  }
  console.log(`   ${"node version".padEnd(22)} ${process.version}`);

  // 2-6. Network per host
  for (const h of HOSTS) {
    console.log(c.bold(`\n${h.host}`));

    const d = await dnsLookup(h.host);
    console.log(
      `   ${tick(d.ok)} DNS lookup           ${
        d.ok ? d.ips.join(", ") : c.red(d.error)
      }`
    );
    if (!d.ok) continue;

    const tcp = await tcpConnect(d.ips[0]);
    console.log(
      `   ${tick(tcp.ok)} TCP :443 to ${d.ips[0].padEnd(15)} ${
        tcp.ok ? "" : c.red(tcp.error)
      }`
    );

    const tlsR = await tlsHandshake(h.host);
    console.log(
      `   ${tick(tlsR.ok)} TLS handshake        ${
        tlsR.ok
          ? c.dim(`cert from ${tlsR.issuer}`)
          : c.red(tlsR.error)
      }`
    );
    // If strict TLS failed, retry with rejectUnauthorized:false to see if it's
    // a cert problem (= antivirus/proxy intercepting) vs a real network drop.
    if (!tlsR.ok) {
      const tlsInsecure = await tlsHandshake(h.host, 443, 8000, true);
      console.log(
        `   ${tick(tlsInsecure.ok)} TLS (insecure mode)  ${
          tlsInsecure.ok
            ? c.yellow(
                `OK with cert from ${tlsInsecure.issuer} — confirms antivirus/proxy interception. Set INSECURE_TLS=true in .env.`
              )
            : c.red(tlsInsecure.error)
        }`
      );
    }

    const nF = await nativeFetchTest(h.probe);
    console.log(
      `   ${tick(nF.ok)} native fetch unauth  ${
        nF.ok ? `HTTP ${nF.status}` : c.red(nF.error)
      }`
    );

    const uF = await undiciFetchTest(h.probe);
    console.log(
      `   ${tick(uF.ok)} undici fetch unauth  ${
        uF.ok ? `HTTP ${uF.status}` : c.red(uF.error)
      }`
    );

    const key = process.env[h.keyEnv];
    if (key) {
      const headers = h.header
        ? { [h.header]: key }
        : { Authorization: `Bearer ${key}` };
      const auth = await nativeFetchTest(h.probe, headers);
      console.log(
        `   ${tick(auth.ok && auth.status === 200)} authed fetch         ${
          auth.ok
            ? auth.status === 200
              ? c.green("HTTP 200 — key works")
              : c.yellow(`HTTP ${auth.status}`)
            : c.red(auth.error)
        }`
      );
    }
  }

  console.log(c.dim("\n─".repeat(60)));
  console.log(c.bold("Reading the results:"));
  console.log("  · TCP ✘                   → ISP/firewall blocks the host. VPN or hotspot.");
  console.log("  · TCP ✔ + TLS ✘ + insecure-TLS ✔  → " + c.yellow("antivirus is intercepting HTTPS."));
  console.log("    " + c.bold("FIX: set INSECURE_TLS=true in backend/.env and restart."));
  console.log("  · native fetch ✔ + undici fetch ✘ → set DISABLE_CUSTOM_HTTP=true");
  console.log("  · authed fetch HTTP 401   → wrong/revoked key.");
  console.log("  · authed fetch HTTP 200   → that provider works.\n");
})();
