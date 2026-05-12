/**
 * Shared HTTP transport for outbound calls.
 *
 *   DISABLE_CUSTOM_HTTP=true → use Node's native fetch instead of our wrapper
 *   INSECURE_TLS=true        → bypass TLS cert validation (set when antivirus
 *                              or corporate firewall is intercepting HTTPS).
 *                              Applied THREE ways for belt-and-suspenders:
 *                                1. NODE_TLS_REJECT_UNAUTHORIZED=0 env var
 *                                2. undici.setGlobalDispatcher with permissive
 *                                   Agent (this is what native fetch uses)
 *                                3. our customFetch dispatcher
 *   HTTPS_PROXY=...          → route through a proxy
 */

const dns = require("dns");

try {
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {
  /* older Node versions */
}

const DISABLED =
  String(process.env.DISABLE_CUSTOM_HTTP || "").toLowerCase() === "true";

const INSECURE =
  String(process.env.INSECURE_TLS || "").toLowerCase() === "true";

// Apply env var BEFORE undici loads so any module that pre-creates TLS
// contexts (some do at require-time) sees the relaxed setting.
if (INSECURE) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

let undici;
try {
  undici = require("undici");
} catch (_) {
  undici = null;
}

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  "";

const tlsOptions = INSECURE ? { rejectUnauthorized: false } : {};

/**
 * Install a GLOBAL undici dispatcher. This is what Node's native `fetch` uses
 * internally, so this is the ONLY way to make `fetch("https://...")` use our
 * relaxed TLS settings without monkey-patching every call site.
 */
let globalDispatcher = null;
if (undici && (INSECURE || proxyUrl)) {
  if (proxyUrl) {
    globalDispatcher = new undici.ProxyAgent({
      uri: proxyUrl,
      connect: { family: 4, timeout: 30_000, ...tlsOptions },
    });
  } else {
    globalDispatcher = new undici.Agent({
      connect: { family: 4, timeout: 30_000, ...tlsOptions },
      headersTimeout: 60_000,
      bodyTimeout: 120_000,
    });
  }
  try {
    undici.setGlobalDispatcher(globalDispatcher);
  } catch (_) {}
}

let mode;
if (!undici) {
  mode = "native-fetch (undici unavailable)";
} else if (INSECURE && DISABLED) {
  mode = "native-fetch · INSECURE_TLS via global dispatcher";
} else if (INSECURE) {
  mode = "undici · INSECURE_TLS";
} else if (DISABLED) {
  mode = "native-fetch (custom http disabled)";
} else if (proxyUrl) {
  mode = `undici proxy ${proxyUrl}`;
} else {
  mode = "undici (ipv4-forced)";
}

if (INSECURE) {
  console.warn(
    "[http] INSECURE_TLS=true — TLS certificate verification disabled (global dispatcher). ONLY use this on a trusted dev machine where antivirus is intercepting HTTPS."
  );
}
if (proxyUrl) {
  console.log(`[http] Outbound proxy: ${proxyUrl}`);
}

const customFetch = async (input, init = {}) => {
  // When DISABLED → use Node's native global fetch (which now picks up our
  //   global dispatcher above when INSECURE_TLS=true).
  // When NOT DISABLED → use undici fetch with our dispatcher explicitly.
  if (DISABLED || !undici) {
    return fetch(input, init);
  }
  if (globalDispatcher) {
    return undici.fetch(input, { ...init, dispatcher: globalDispatcher });
  }
  return undici.fetch(input, init);
};

module.exports = {
  dispatcher: globalDispatcher,
  fetch: customFetch,
  proxyUrl,
  mode,
  insecureTls: INSECURE,
};
