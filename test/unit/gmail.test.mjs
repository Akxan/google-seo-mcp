import { test } from "node:test";
import assert from "node:assert/strict";
import { collectAttachments } from "../../dist/gmail.js";
import { auditSummary } from "../../dist/server.js";

test("collectAttachments walks nested multipart payloads and skips inline parts without attachmentId", () => {
  const payload = { mimeType: "multipart/mixed", parts: [
    { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", filename: "", body: { size: 10 } }] },
    { mimeType: "image/jpeg", filename: "foto.jpg", body: { attachmentId: "A1", size: 12345 } },
    { mimeType: "application/pdf", filename: "doc.pdf", body: { attachmentId: "A2", size: 999 } },
    { mimeType: "image/png", filename: "inline.png", body: { size: 5 } },
  ] };
  assert.deepEqual(collectAttachments(payload), [
    { attachmentId: "A1", filename: "foto.jpg", mimeType: "image/jpeg", size: 12345 },
    { attachmentId: "A2", filename: "doc.pdf", mimeType: "application/pdf", size: 999 },
  ]);
  assert.deepEqual(collectAttachments(undefined), []);
});

test("auditSummary keeps identifiers and counts, never content", () => {
  const s = auditSummary({ site: "blog", id: 515, title: "SECRET TITLE", content: "x".repeat(500), dryRun: true, files: [{ path: "a.js", content: "…" }, { path: "b.png" }], urls: ["https://a/", "https://b/"], edits: [{ find: "x", replace: "y" }], ids: [1, 2] });
  assert.deepEqual(s, { site: "blog", id: 515, dryRun: true, files: ["a.js", "b.png"], urls: ["https://a/", "https://b/"], edits: "[1]", ids: [1, 2] });
  assert.equal(JSON.stringify(s).includes("SECRET"), false);
  assert.deepEqual(auditSummary(null), {});
});
