/**
 * Pure DNS + TCP reachability probe — no HTTP, no auth.
 * Tells the user whether the *network* can reach a host:port at all,
 * separate from any API-level error.
 */
const dns = require("dns").promises;
const net = require("net");

const probe = async (host, port = 443, timeoutMs = 5000) => {
  const out = { host, port, dns: null, tcp: null };

  // DNS — try IPv4 explicitly
  try {
    const records = await dns.resolve4(host);
    out.dns = { ok: true, addresses: records.slice(0, 3) };
  } catch (err) {
    out.dns = { ok: false, error: err.code || err.message };
    return out;
  }

  // TCP connect
  await new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      out.tcp = result;
      resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ ok: true }));
    socket.once("timeout", () => finish({ ok: false, error: "timeout" }));
    socket.once("error", (e) =>
      finish({ ok: false, error: e.code || e.message })
    );
    socket.connect(port, out.dns.addresses[0]);
  });

  return out;
};

const probeAll = async () =>
  Promise.all([
    probe("api.openai.com"),
    probe("api.groq.com"),
    probe("api.elevenlabs.io"),
  ]);

module.exports = { probe, probeAll };
