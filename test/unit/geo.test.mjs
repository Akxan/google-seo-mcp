import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenNodes, auditNode, isQuestion } from "../../dist/tools/geo.js";

test("flattenNodes walks arrays and @graph", () => {
  const nodes = flattenNodes([{ "@context": "https://schema.org", "@graph": [{ "@type": "WebSite", name: "x" }, { "@type": ["Organization", "LocalBusiness"], name: "y" }] }, { "@type": "FAQPage", mainEntity: [] }]);
  assert.equal(nodes.length, 3);
});

test("auditNode reports missing required fields and FAQ structure problems", () => {
  const a = auditNode({ "@type": "Article", headline: "h" });
  assert.deepEqual(a.missingRequired.sort(), ["author", "datePublished"]);
  const f = auditNode({ "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?" }] });
  assert.ok(f.problems.some((p) => /acceptedAnswer/.test(p)));
  const bad = auditNode({ "@type": "BlogPosting", headline: "h", author: { "@type": "Person", name: "a" }, datePublished: "yesterday" });
  assert.ok(bad.problems.some((p) => /not a valid ISO date/.test(p)));
  assert.equal(auditNode({ "@type": "Thing" }).known, false);
});

test("isQuestion recognises English and Spanish question forms", () => {
  assert.equal(isQuestion("How far is Ronda from Seville?"), true);
  assert.equal(isQuestion("Cuánto cuesta un tour privado"), true);
  assert.equal(isQuestion("Tips for your trip"), false);
});
