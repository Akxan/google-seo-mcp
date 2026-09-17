import { test } from "node:test";
import assert from "node:assert/strict";
import { collectAttachments, collectBodyParts, htmlToText } from "../../dist/gmail.js";
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

test("collectBodyParts finds the text parts in a nested payload and ignores attachments", () => {
  const payload = { mimeType: "multipart/mixed", filename: "", parts: [
    { mimeType: "multipart/alternative", filename: "", parts: [
      { mimeType: "text/plain", filename: "", body: { size: 12, data: "aGVsbG8" } },
      { mimeType: "text/html", filename: "", body: { size: 30, attachmentId: "B1" } },
    ] },
    { mimeType: "text/plain", filename: "notes.txt", body: { attachmentId: "A1", size: 5 } },
    { mimeType: "image/png", filename: "x.png", body: { attachmentId: "A2", size: 5 } },
  ] };
  assert.deepEqual(collectBodyParts(payload), [
    { mimeType: "text/plain", size: 12, data: "aGVsbG8", attachmentId: undefined },
    { mimeType: "text/html", size: 30, data: undefined, attachmentId: "B1" },
  ]);
  // A plain, non-multipart message keeps its body on the payload itself.
  assert.deepEqual(collectBodyParts({ mimeType: "text/plain", filename: "", body: { size: 3, data: "eA" } }), [{ mimeType: "text/plain", size: 3, data: "eA", attachmentId: undefined }]);
  assert.deepEqual(collectBodyParts(undefined), []);
});

test("htmlToText keeps the text, turns block tags into newlines and decodes entities", () => {
  const html = "<html><head><style>p{color:red}</style></head><body><h1>T&iacute;tulo &Ntilde;</h1><p>Uno<br>Dos</p><ul><li>a</li><li>b</li></ul><p>caf&#233; &amp; m&#xe1;s&nbsp;&hellip; &unknownentity;</p></body></html>";
  assert.equal(htmlToText(html), "Título Ñ\nUno\nDos\n- a\n- b\ncafé & más … &unknownentity;");
  assert.equal(htmlToText("<p>a</p>\n\n\n\n<p>b</p>"), "a\n\nb");
});

test("auditSummary keeps identifiers and counts, never content", () => {
  const s = auditSummary({ site: "blog", id: 515, title: "SECRET TITLE", content: "x".repeat(500), dryRun: true, files: [{ path: "a.js", content: "…" }, { path: "b.png" }], urls: ["https://a/", "https://b/"], edits: [{ find: "x", replace: "y" }], ids: [1, 2] });
  assert.deepEqual(s, { site: "blog", id: 515, dryRun: true, files: ["a.js", "b.png"], urls: ["https://a/", "https://b/"], edits: "[1]", ids: [1, 2] });
  assert.equal(JSON.stringify(s).includes("SECRET"), false);
  assert.deepEqual(auditSummary(null), {});
});

test("auditSummary keeps wp_run command tokens but not stdin", () => {
  const s = auditSummary({ site: "mysite", args: ["plugin", "list", "--status=active"], stdin: "secret content" });
  assert.deepEqual(s, { site: "mysite", args: ["plugin", "list", "--status=active"] });
});

test("auditSummary lists ids of bulk items", () => {
  const s = auditSummary({ site: "mysite", items: [{ id: 5, title: "secret" }, { id: 9, description: "x" }], edits: [{ find: "a", replace: "b" }] });
  assert.equal(s.items, "[2] ids=5,9");
  assert.equal(s.edits, "[1]");
});
