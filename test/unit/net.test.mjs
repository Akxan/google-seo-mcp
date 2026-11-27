import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isPrivateAddress, privateAddressesBlocked, setNetworkTransport, assertFetchableUrl, guardedLookup, safeFetch, sniffCharset, decodeBody, BlockedUrlError } from "../../dist/net.js";
import { fetchWithTimeout } from "../../dist/tools/web.js";
import { collectBodyParts, decodeBodyPart } from "../../dist/gmail.js";

/** Run fn with the given transport and env, then restore the stdio defaults. */
async function withPolicy(mode, env, fn) {
  const saved = { allow: process.env.SEO_MCP_ALLOW_PRIVATE_URLS, block: process.env.SEO_MCP_BLOCK_PRIVATE_URLS };
  delete process.env.SEO_MCP_ALLOW_PRIVATE_URLS;
  delete process.env.SEO_MCP_BLOCK_PRIVATE_URLS;
  Object.assign(process.env, env);
  setNetworkTransport(mode);
  try { return await fn(); } finally {
    setNetworkTransport("stdio");
    for (const [k, v] of [["SEO_MCP_ALLOW_PRIVATE_URLS", saved.allow], ["SEO_MCP_BLOCK_PRIVATE_URLS", saved.block]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** A loopback server for one test; handler(req, res, url). */
async function serve(handler) {
  const srv = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://x")));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

test("isPrivateAddress flags every non-public IPv4 range", () => {
  for (const ip of ["0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.8.9.10", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "169.253.1.1", "192.169.0.1", "192.0.1.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", "11.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("isPrivateAddress flags IPv6 loopback, ULA, link-local, multicast and embedded private IPv4", () => {
  for (const ip of ["::", "::1", "[::1]", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456:789a::1", "fe80::1", "fe80::1%en0", "febf::1", "fec0::1", "ff02::1", "ff05::fb", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.1.2.3", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::127.0.0.1", "::192.168.0.1", "64:ff9b::10.0.0.1", "2002:c0a8:0101::1", "2001:db8::1", "100::1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::8.8.8.8", "2002:0808:0808::1", "fbff::1", "fe00::1"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  for (const notIp of ["example.com", "", "1.2.3", "1.2.3.256", ":::", "1::2::3", "gggg::1"]) assert.equal(isPrivateAddress(notIp), false, notIp);
});

test("the policy blocks private addresses over HTTP unless allowed, and allows them on stdio unless blocked", async () => {
  await withPolicy("stdio", {}, () => assert.equal(privateAddressesBlocked(), false));
  await withPolicy("stdio", { SEO_MCP_BLOCK_PRIVATE_URLS: "1" }, () => assert.equal(privateAddressesBlocked(), true));
  await withPolicy("http", {}, () => assert.equal(privateAddressesBlocked(), true));
  await withPolicy("http", { SEO_MCP_ALLOW_PRIVATE_URLS: "1" }, () => assert.equal(privateAddressesBlocked(), false));
  // Docker's env_file passes `KEY=` through as an empty string: that is "unset", not "allow".
  await withPolicy("http", { SEO_MCP_ALLOW_PRIVATE_URLS: " " }, () => assert.equal(privateAddressesBlocked(), true));
  await withPolicy("http", { SEO_MCP_ALLOW_PRIVATE_URLS: "0" }, () => assert.equal(privateAddressesBlocked(), true));
});

test("assertFetchableUrl refuses other schemes always and literal private IPs when the policy blocks", async () => {
  for (const u of ["file:///etc/passwd", "ftp://example.com/x", "data:text/plain,hi", "gopher://example.com/"]) assert.throws(() => assertFetchableUrl(new URL(u)), BlockedUrlError, u);
  await withPolicy("http", {}, () => {
    // The URL parser canonicalises decimal, hex and short IPv4 forms first, so they cannot slip past.
    for (const u of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://127.1:8080/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fd00::1]/", "http://10.0.0.5/", "https://192.168.0.1/"]) {
      assert.throws(() => assertFetchableUrl(new URL(u)), /Refused to fetch .*SSRF/, u);
    }
    assertFetchableUrl(new URL("https://93.184.215.14/"));
    assertFetchableUrl(new URL("https://example.com/")); // names are checked at connect time instead
  });
  await withPolicy("stdio", {}, () => assertFetchableUrl(new URL("http://127.0.0.1:4321/")));
});

test("a literal private IP URL is refused by the safe fetch before any connection", async () => {
  await withPolicy("http", {}, async () => {
    await assert.rejects(fetchWithTimeout("http://127.0.0.1:9/"), (e) => e instanceof BlockedUrlError && /SEO_MCP_ALLOW_PRIVATE_URLS/.test(e.message));
    await assert.rejects(safeFetch("http://[::1]:9/"), BlockedUrlError);
    await assert.rejects(safeFetch("http://169.254.169.254/latest/meta-data/"), BlockedUrlError);
  });
  await withPolicy("stdio", { SEO_MCP_BLOCK_PRIVATE_URLS: "1" }, async () => {
    await assert.rejects(safeFetch("http://10.0.0.1/"), /unset SEO_MCP_BLOCK_PRIVATE_URLS/);
  });
});

test("guardedLookup refuses a name that resolves to loopback, at connect time", async () => {
  const lookup = (opts) => new Promise((resolve) => guardedLookup("localhost", opts, (err, address, family) => resolve({ err, address, family })));
  await withPolicy("http", {}, async () => {
    const r = await lookup({ all: true });
    assert.ok(r.err instanceof BlockedUrlError);
    assert.match(r.err.message, /localhost \(resolves to /);
  });
  await withPolicy("stdio", {}, async () => {
    const all = await lookup({ all: true });
    assert.equal(all.err, null);
    assert.ok(Array.isArray(all.address) && all.address.every((x) => isPrivateAddress(x.address)));
    const one = await lookup({});
    assert.equal(typeof one.address, "string");
    assert.ok([4, 6].includes(one.family));
  });
});

test("a hostname pointing at a private address is refused when connecting", async () => {
  const srv = await serve((_req, res) => res.end("secret"));
  try {
    await withPolicy("http", {}, async () => {
      await assert.rejects(fetchWithTimeout(`http://localhost:${srv.port}/`), (e) => e instanceof BlockedUrlError && /localhost/.test(e.message));
    });
    await withPolicy("http", { SEO_MCP_ALLOW_PRIVATE_URLS: "1" }, async () => {
      assert.equal(await (await fetchWithTimeout(`http://localhost:${srv.port}/`)).text(), "secret");
    });
  } finally { await srv.close(); }
});

test("redirects are followed hop by hop: final url and redirected kept, manual mode untouched, every hop re-checked", async () => {
  const srv = await serve((req, res, u) => {
    if (u.pathname === "/a") { res.writeHead(301, { Location: "/b?x=1" }); return res.end(); }
    if (u.pathname === "/b") { res.writeHead(302, { Location: "/c" }); return res.end(); }
    if (u.pathname === "/loop") { res.writeHead(302, { Location: "/loop" }); return res.end(); }
    if (u.pathname === "/to-file") { res.writeHead(302, { Location: "file:///etc/passwd" }); return res.end(); }
    if (u.pathname === "/to-metadata") {
      // The first hop was allowed; the policy now blocks, so the redirect target must be refused.
      process.env.SEO_MCP_BLOCK_PRIVATE_URLS = "1";
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    }
    if (u.pathname === "/post") { res.writeHead(303, { Location: "/echo" }); return res.end(); }
    if (u.pathname === "/echo") return res.end(req.method);
    res.end(`at ${u.pathname}`);
  });
  try {
    await withPolicy("stdio", {}, async () => {
      const r = await fetchWithTimeout(`${srv.base}/a`);
      assert.equal(r.status, 200);
      assert.equal(r.url, `${srv.base}/c`);
      assert.equal(r.redirected, true);
      assert.equal(await r.text(), "at /c");
      const direct = await fetchWithTimeout(`${srv.base}/c#frag`);
      assert.equal(direct.url, `${srv.base}/c`);
      assert.equal(direct.redirected, false);
      const manual = await fetchWithTimeout(`${srv.base}/a`, { redirect: "manual" });
      assert.equal(manual.status, 301);
      assert.equal(manual.headers.get("location"), "/b?x=1");
      assert.equal(manual.url, `${srv.base}/a`);
      await assert.rejects(fetchWithTimeout(`${srv.base}/loop`), /More than 10 redirects/);
      await assert.rejects(fetchWithTimeout(`${srv.base}/to-file`), /only http and https/);
      await assert.rejects(fetchWithTimeout(`${srv.base}/to-metadata`), (e) => e instanceof BlockedUrlError && /169\.254\.169\.254/.test(e.message));
      delete process.env.SEO_MCP_BLOCK_PRIVATE_URLS;
      assert.equal(await (await fetchWithTimeout(`${srv.base}/post`, { method: "POST", body: "x" })).text(), "GET");
    });
  } finally { await srv.close(); }
});

test("the timeout covers the body, the body is size-capped, and odd status codes survive", async () => {
  const srv = await serve((_req, res, u) => {
    if (u.pathname === "/slow-body") { res.writeHead(200, { "Content-Type": "text/plain" }); res.write("first bytes"); return; } // never ends
    if (u.pathname === "/big") { res.writeHead(200); res.end(Buffer.alloc(3 * 1024 * 1024, 97)); return; }
    if (u.pathname === "/999") { res.writeHead(999, "Request denied"); return res.end("no"); }
    if (u.pathname === "/204") { res.writeHead(204); return res.end(); }
    res.end("ok");
  });
  try {
    const slow = await fetchWithTimeout(`${srv.base}/slow-body`, {}, 300);
    assert.equal(slow.status, 200); // headers arrived in time
    await assert.rejects(slow.text(), /Timed out after 0\.3 s/);
    const big = await fetchWithTimeout(`${srv.base}/big`, {}, 10_000, { maxBytes: 1024 * 1024 });
    await assert.rejects(big.arrayBuffer(), /larger than 1 MB/);
    const fits = await fetchWithTimeout(`${srv.base}/big`, {}, 10_000, { maxBytes: 4 * 1024 * 1024 });
    assert.equal((await fits.arrayBuffer()).byteLength, 3 * 1024 * 1024);
    // A status-only check never has to read the body, however big.
    assert.equal((await fetchWithTimeout(`${srv.base}/big`, {}, 10_000, { maxBytes: 10 })).status, 200);
    const odd = await fetchWithTimeout(`${srv.base}/999`);
    assert.equal(odd.status, 999);
    assert.equal(odd.ok, false);
    assert.equal(await odd.text(), "no");
    const empty = await fetchWithTimeout(`${srv.base}/204`);
    assert.equal(empty.status, 204);
    assert.equal(await empty.text(), "");
  } finally { await srv.close(); }
});

const latin1 = (s) => Uint8Array.from(Buffer.from(s, "latin1"));
const concat = (...parts) => Uint8Array.from(Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p)))));

test("decodeBody honours the Content-Type charset (windows-1252, Shift_JIS, GBK)", () => {
  assert.equal(decodeBody(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), "text/html; charset=windows-1252").text, "café");
  assert.equal(decodeBody(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), 'text/plain; charset="ISO-8859-1"').text, "café");
  assert.equal(decodeBody(Uint8Array.from([0x93, 0xfa, 0x96, 0x7b]), "text/html; charset=Shift_JIS").text, "日本");
  assert.equal(decodeBody(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]), "text/html;charset=gbk").text, "中文");
  assert.equal(decodeBody(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]), "text/html; charset=gb2312").charset, "gbk");
  assert.equal(decodeBody(Buffer.from("café ✓"), "text/html; charset=utf-8").text, "café ✓");
});

test("sniffCharset falls back to <meta charset> / http-equiv in the first 4 KB, then UTF-8", () => {
  const sjis = concat('<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"></head><body>', [0x93, 0xfa, 0x96, 0x7b], "</body></html>");
  assert.deepEqual(sniffCharset(sjis, "text/html"), { charset: "shift_jis", source: "meta" });
  assert.match(decodeBody(sjis, "text/html").text, /<body>日本<\/body>/);
  const gbk = concat("<!doctype html><meta charset=gbk><title>", [0xd6, 0xd0, 0xce, 0xc4], "</title>");
  assert.match(decodeBody(gbk, null).text, /<title>中文<\/title>/);
  const w1252 = concat("<meta charset='windows-1252'><p>Sevilla, Espa", [0xf1], "a</p>");
  assert.match(decodeBody(w1252, "text/html").text, /España/);
  // The header wins over the meta tag; a BOM wins over both.
  assert.equal(sniffCharset(gbk, "text/html; charset=windows-1252").charset, "windows-1252");
  assert.deepEqual(sniffCharset(concat([0xef, 0xbb, 0xbf], "<meta charset=gbk>"), "text/html; charset=windows-1252"), { charset: "utf-8", source: "bom" });
  assert.equal(decodeBody(concat([0xef, 0xbb, 0xbf], "hi"), "text/plain").text, "hi");
  // A meta tag past the first 4 KB, an unknown label, or a JSON body never switch encodings.
  assert.equal(sniffCharset(concat("x".repeat(5000), "<meta charset=gbk>"), "text/html").source, "default");
  assert.deepEqual(sniffCharset(latin1("<meta charset=klingon>"), "text/html; charset=bogus"), { charset: "utf-8", source: "default" });
  assert.equal(sniffCharset(latin1('{"html":"<meta charset=gbk>"}'), "application/json").charset, "utf-8");
  assert.equal(sniffCharset(latin1('<?xml version="1.0" encoding="ISO-8859-1"?><urlset/>'), "application/xml").charset, "windows-1252");
  // A UTF-16 label found by an ASCII scan cannot be right; the HTML spec reads it as UTF-8.
  assert.equal(sniffCharset(latin1('<meta charset="utf-16">'), "text/html").charset, "utf-8");
});

test("fetched pages decode with their declared charset through text()", async () => {
  const srv = await serve((_req, res, u) => {
    if (u.pathname === "/sjis") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(Buffer.from(concat('<meta http-equiv="content-type" content="text/html; charset=shift_jis"><h1>', [0x93, 0xfa, 0x96, 0x7b], "</h1>"))); }
    res.writeHead(200, { "Content-Type": "text/html; charset=windows-1252" });
    res.end(Buffer.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9]));
  });
  try {
    assert.equal(await (await fetchWithTimeout(`${srv.base}/w`)).text(), "<p>café");
    assert.match(await (await fetchWithTimeout(`${srv.base}/sjis`)).text(), /<h1>日本<\/h1>/);
  } finally { await srv.close(); }
});

test("Gmail body parts keep their declared charset and decode with it, not always as UTF-8", () => {
  const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
  const payload = { mimeType: "multipart/alternative", filename: "", parts: [
    { mimeType: "text/plain", filename: "", headers: [{ name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"; format=flowed' }], body: { size: 4, data: b64([0x63, 0x61, 0x66, 0xe9]) } },
    { mimeType: "text/html", filename: "", headers: [{ name: "content-type", value: "text/html" }], body: { size: 9, data: "PGI-eDwvYj4" } },
  ] };
  const [plain, html] = collectBodyParts(payload);
  assert.equal(plain.charset, "ISO-8859-1");
  assert.equal("charset" in html, false);
  assert.equal(decodeBodyPart(plain.data, plain), "café");
  assert.equal(decodeBodyPart(b64([0x93, 0xfa, 0x96, 0x7b]), { mimeType: "text/plain", charset: "shift_jis" }), "日本");
  assert.equal(decodeBodyPart(b64([0xd6, 0xd0, 0xce, 0xc4]), { mimeType: "text/plain", charset: "gb2312" }), "中文");
  // No declaration: an HTML part's own <meta charset> is used, otherwise UTF-8.
  const meta = Buffer.concat([Buffer.from("<meta charset=windows-1252><p>Espa"), Buffer.from([0xf1]), Buffer.from("a</p>")]);
  assert.match(decodeBodyPart(b64(meta), { mimeType: "text/html" }), /España/);
  assert.equal(decodeBodyPart(Buffer.from("café ✓").toString("base64url"), { mimeType: "text/plain" }), "café ✓");
  assert.equal(decodeBodyPart(b64([0x63, 0xe9]), { mimeType: "text/plain", charset: "no-such-charset" }), "c�");
});
