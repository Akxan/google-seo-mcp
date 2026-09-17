import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenNodes, auditNode, isQuestion, parseAgentOutput, parseSearchResults, rankSources } from "../../dist/tools/geo.js";

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

test("parseAgentOutput reads answer text and cites in-text sources first", () => {
  const { answer, citations } = parseAgentOutput({
    output: [
      { type: "search_results", results: [{ url: "https://c.example/" }, { url: "https://a.example/" }] },
      {
        type: "message",
        content: [
          { type: "output_text", text: "Seville has ", annotations: [{ type: "url_citation", url: "https://a.example/" }] },
          { type: "output_text", text: "many tours.", annotations: [{ type: "url_citation", url: "https://b.example/" }] },
        ],
      },
    ],
  });
  assert.equal(answer, "Seville has many tours.");
  // cited-in-answer URLs lead, search results follow, no duplicates
  assert.deepEqual(citations, ["https://a.example/", "https://b.example/", "https://c.example/"]);
});

test("parseAgentOutput tolerates an empty or unknown output array", () => {
  assert.deepEqual(parseAgentOutput({}), { answer: "", citations: [] });
  assert.deepEqual(parseAgentOutput({ output: [{ type: "reasoning" }] }), { answer: "", citations: [] });
});

test("parseSearchResults reads a flat result list and keeps the rank", () => {
  const out = parseSearchResults({ results: [
    { title: "A", url: "https://a.example/one", snippet: "s", date: "2026-01-02" },
    { title: "B", url: "https://b.example/two", last_updated: "2026-02-03" },
    { title: "no url" },
  ] }, ["best tour"]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { query: "best tour", rank: 1, title: "A", url: "https://a.example/one", snippet: "s", date: "2026-01-02" });
  assert.equal(out[1].date, "2026-02-03");
  assert.equal(out[1].rank, 2);
  assert.deepEqual(parseSearchResults({}, ["q"]), []);
});

test("parseSearchResults attributes one list per query when several queries were batched", () => {
  const out = parseSearchResults({ results: [
    [{ title: "A", url: "https://a.example/" }],
    [{ title: "B", url: "https://b.example/" }, { title: "C", url: "https://a.example/deep" }],
  ] }, ["q1", "q2"]);
  assert.deepEqual(out.map((r) => [r.query, r.rank]), [["q1", 1], ["q2", 1], ["q2", 2]]);
});

test("rankSources counts domains and finds your own position, including subdomains", () => {
  const sources = parseSearchResults({ results: [
    [{ title: "A", url: "https://competitor.example/x" }, { title: "B", url: "https://www.mysite.com/es/tour" }],
    [{ title: "C", url: "https://competitor.example/y" }, { title: "D", url: "https://other.example/z" }],
  ] }, ["q1", "q2"]);
  const r = rankSources(sources, "https://www.mysite.com/");
  assert.equal(r.domains[0].domain, "competitor.example");
  assert.equal(r.domains[0].results, 2);
  assert.deepEqual(r.domains[0].queries, ["q1", "q2"]);
  assert.equal(r.yours.length, 1);
  assert.equal(r.bestRank, 2);
  assert.deepEqual(r.missedQueries, ["q2"]);
  // no domain given: no "yours" section, but the domain ranking still works
  assert.deepEqual(rankSources(sources).yours, []);
  assert.equal(rankSources(sources).bestRank, null);
});
