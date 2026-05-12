/**
 * Prints a clear startup banner showing what's loaded and runs a quick
 * connectivity check so you know on boot whether AI calls will actually work.
 */
const fs = require("fs");
const path = require("path");
const tls = require("tls");
const { mode: httpMode, proxyUrl, insecureTls } = require("./httpAgent");

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const status = (env) => {
  const v = process.env[env];
  if (!v) return c.red("missing");
  if (v.includes("your_") || v.includes("_here"))
    return c.yellow("placeholder");
  return c.green(`set (${v.length} chars)`);
};

const printBanner = async () => {
  console.log("\n" + c.bold("Memory Voice Avatar — backend"));
  console.log(c.dim("─".repeat(56)));

  // .env file presence check
  const envPath = path.join(__dirname, "..", ".env");
  const envExamplePath = path.join(__dirname, "..", ".env.example");
  const hasEnv = fs.existsSync(envPath);
  const hasExample = fs.existsSync(envExamplePath);
  if (!hasEnv && hasExample) {
    console.log(
      c.red("⚠  No .env file found, only .env.example — your keys are NOT loaded.")
    );
    console.log(
      c.yellow("   Run:  copy .env.example .env   (Windows)  or  cp .env.example .env  (mac/linux)")
    );
  } else if (!hasEnv) {
    console.log(c.red("⚠  No .env file found. Create one with your API keys."));
  }

  console.log(`  OPENAI_API_KEY    ${status("OPENAI_API_KEY")}`);
  console.log(`  GROQ_API_KEY      ${status("GROQ_API_KEY")}`);
  console.log(`  ELEVENLABS_API_KEY ${status("ELEVENLABS_API_KEY")}`);
  console.log(`  MONGO_URI         ${status("MONGO_URI")}`);
  console.log(
    `  AI_PROVIDER       ${c.green(process.env.AI_PROVIDER || "auto")}`
  );
  console.log(`  HTTP transport    ${c.dim(httpMode)}`);
  if (proxyUrl) console.log(`  Proxy             ${proxyUrl}`);
  if (String(process.env.USE_MOCK_AI || "").toLowerCase() === "true") {
    console.log(c.yellow("  USE_MOCK_AI=true  → no real AI calls will be made"));
  }

  // Layered probe: TCP → TLS → HTTPS GET
  // (TCP works but TLS fails ⇒ antivirus is intercepting HTTPS)
  console.log(c.dim("\n  Connectivity probe (TCP → TLS → HTTPS):"));
  const { probe } = require("./netProbe");
  if (insecureTls) {
    console.log(
      c.yellow("    ⚠ INSECURE_TLS=true — cert verification is OFF")
    );
  }

  const tlsCheck = (host) =>
    new Promise((resolve) => {
      const opts = { host, port: 443, servername: host, timeout: 5000 };
      if (insecureTls) opts.rejectUnauthorized = false;
      const s = tls.connect(opts, () => {
        s.end();
        resolve({ ok: true });
      });
      s.once("timeout", () => {
        s.destroy();
        resolve({ ok: false, error: "tls timeout" });
      });
      s.once("error", (e) =>
        resolve({ ok: false, error: e.code || e.message })
      );
    });

  const httpsCheck = async (host, pathname) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`https://${host}${pathname}`, {
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, error: e.cause?.code || e.code || e.message };
    }
  };

  const probes = [
    { host: "api.openai.com", path: "/v1/models" },
    { host: "api.groq.com", path: "/openai/v1/models" },
    { host: "api.elevenlabs.io", path: "/v1/voices" },
  ];

  for (const p of probes) {
    const r = await probe(p.host, 443, 4000);
    const tcpOk = r.dns?.ok && r.tcp?.ok;
    const tlsR = tcpOk ? await tlsCheck(p.host) : { ok: false, error: "skipped" };
    const httpsR = tlsR.ok ? await httpsCheck(p.host, p.path) : { ok: false, error: "skipped" };

    const t1 = tcpOk ? c.green("TCP✔") : c.red("TCP✘");
    const t2 = tlsR.ok ? c.green("TLS✔") : c.red(`TLS✘ ${tlsR.error}`);
    const t3 = httpsR.ok
      ? c.green(`HTTPS✔ ${httpsR.status}`)
      : c.red(`HTTPS✘ ${httpsR.error}`);
    console.log(`    ${p.host.padEnd(20)} ${t1}  ${t2}  ${t3}`);
  }

  // Synthesize a single recommendation
  console.log("");
  const { probeAll } = require("./netProbe");
  const results = await probeAll().catch(() => null);
  if (results) {
    const openai = results.find((r) => r.host === "api.openai.com");
    const groq = results.find((r) => r.host === "api.groq.com");
    const openaiOk = openai?.dns?.ok && openai?.tcp?.ok;
    const groqOk = groq?.dns?.ok && groq?.tcp?.ok;

    if (!openaiOk && !groqOk) {
      console.log(
        c.red("  ✘ Both AI providers unreachable on TCP.")
      );
      console.log(c.yellow("    Look at the TLS line above:"));
      console.log(
        "      • TCP✔ but TLS✘  → antivirus/firewall is intercepting HTTPS."
      );
      console.log(
        c.bold("        ⇒ Set INSECURE_TLS=true in backend/.env and restart.")
      );
      console.log(
        "      • TCP✘            → ISP/firewall blocks the host. Try mobile hotspot or VPN."
      );
      console.log(
        c.dim("    Fast fallback: USE_MOCK_AI=true in .env to test the UI.")
      );
      console.log(
        c.dim("    Run  npm run doctor  for a layer-by-layer breakdown.")
      );
    } else if (!openaiOk && groqOk) {
      console.log(
        c.green("  ✔ Groq reachable, OpenAI not — failover will use Groq.")
      );
    } else if (openaiOk && !groqOk) {
      console.log(
        c.green("  ✔ OpenAI reachable, Groq not — chat will use OpenAI.")
      );
    } else {
      console.log(c.green("  ✔ Both providers reachable. Ready to chat."));
    }
  }
  console.log(c.dim("─".repeat(56)) + "\n");
};

module.exports = { printBanner };
