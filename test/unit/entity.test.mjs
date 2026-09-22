import { test } from "node:test";
import assert from "node:assert/strict";
import { phoneKey, classifyLink, idWiring } from "../../dist/tools/geo.js";

test("phoneKey matches the same number written in different formats", () => {
  assert.equal(phoneKey("+34 954 22 33 44"), phoneKey("954223344"));
  assert.equal(phoneKey("(954) 22-33-44"), phoneKey("+34954223344"));
  assert.equal(phoneKey("123"), null, "too short to be a phone number");
  assert.equal(phoneKey(null), null);
});

test("a profile that refuses bots is blocked, not broken", () => {
  assert.equal(classifyLink(403), "blocked", "Instagram and Facebook answer 403 to servers");
  assert.equal(classifyLink(429), "blocked");
  assert.equal(classifyLink(404), "missing");
  assert.equal(classifyLink(410), "missing");
  assert.equal(classifyLink(200), "ok");
  assert.equal(classifyLink(301), "ok");
  assert.equal(classifyLink(500), "unreachable");
  assert.equal(classifyLink(null), "unreachable", "DNS failure or timeout");
});

test("idWiring tells a referenced organization from one retyped on every page", () => {
  const referenced = [
    { "@type": "Organization", "@id": "https://example.com/#org", name: "Casa" },
    { "@type": "BlogPosting", headline: "x", publisher: { "@id": "https://example.com/#org" }, author: { "@id": "https://example.com/#org" } },
  ];
  assert.deepEqual(idWiring(referenced), { organizationId: "https://example.com/#org", referencedById: 2, inlineRepeats: 0 });

  const retyped = [
    { "@type": "Organization", name: "Casa" },
    { "@type": "BlogPosting", headline: "x", publisher: { "@type": "Organization", name: "Casa", url: "https://example.com" } },
  ];
  const w = idWiring(retyped);
  assert.equal(w.organizationId, null, "nothing to merge on");
  assert.equal(w.inlineRepeats, 1);
  assert.equal(w.referencedById, 0);
});

test("idWiring ignores nodes with no organization at all", () => {
  assert.deepEqual(idWiring([{ "@type": "WebPage", name: "x" }]), { organizationId: null, referencedById: 0, inlineRepeats: 0 });
});
