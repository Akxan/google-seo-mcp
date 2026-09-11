/**
 * Gmail attachment tools: find emailed files and commit them to a GitHub repo without touching the client machine.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tool } from "../util.js";
import { collectAttachments, getGmail, header } from "../gmail.js";
import { commitBlobs, imageOptionShape, renderImageOutputs } from "./github.js";

const repoParam = z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe("Repository as 'owner/name'.");

export function registerGmailTools(server: McpServer) {
  server.registerTool(
    "gmail_find_attachments",
    {
      title: "Find emails with attachments",
      description:
        "Search the authorized Gmail mailbox (read-only) and list matching messages with their attachments (name, type, size), so a photo or document someone emailed can be committed to GitHub with github_commit_attachment. Gmail search syntax: from:, subject:, newer_than:7d, filename:jpg; 'has:attachment' is added automatically.",
      inputSchema: {
        query: z.string().default("newer_than:30d").describe("Gmail search query, e.g. 'from:alba newer_than:14d'."),
        max: z.number().int().min(1).max(50).default(10),
      },
    },
    tool(async (a) => {
      const gmail = getGmail();
      const q = /\bhas:attachment\b/.test(a.query) ? a.query : `${a.query} has:attachment`.trim();
      const list = await gmail.users.messages.list({ userId: "me", q, maxResults: a.max });
      const ids = (list.data.messages ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
      const messages = await Promise.all(ids.map(async (id) => {
        const m = (await gmail.users.messages.get({ userId: "me", id, format: "full" })).data;
        return { messageId: id, date: header(m, "date"), from: header(m, "from"), subject: header(m, "subject"), snippet: m.snippet, attachments: collectAttachments(m.payload).map(({ attachmentId: _a, ...rest }) => rest) };
      }));
      return { query: q, count: messages.length, messages };
    }),
  );

  server.registerTool(
    "github_commit_attachment",
    {
      title: "Commit an email attachment to GitHub",
      description:
        "Take an attachment from a Gmail message (found with gmail_find_attachments), optionally convert/resize it on the server when it is an image (webp by default, cover-crop, variants), and commit the result to a branch. Nothing passes through the client. dryRun reports the attachment and the resulting dimensions and bytes without committing.",
      inputSchema: {
        messageId: z.string().describe("Gmail message id from gmail_find_attachments."),
        filename: z.string().optional().describe("Attachment file name as listed; omit when the message has exactly one attachment."),
        repo: repoParam,
        branch: z.string().describe("Branch to commit to, e.g. 'main'."),
        message: z.string().describe("Commit message in the repository's conventions."),
        path: z.string().describe("Destination path in the repo, e.g. 'public/assets/img/blog/cover.webp'."),
        convert: z.boolean().default(true).describe("Images: convert/resize on the server with the options below; false commits the original bytes unchanged."),
        ...imageOptionShape,
        createBranch: z.boolean().default(false),
        dryRun: z.boolean().default(false),
      },
    },
    tool(async (a) => {
      const gmail = getGmail();
      const m = (await gmail.users.messages.get({ userId: "me", id: a.messageId, format: "full" })).data;
      const all = collectAttachments(m.payload);
      if (!all.length) throw new Error("That message has no attachments.");
      const pick = a.filename ? all.find((x) => x.filename.toLowerCase() === a.filename!.toLowerCase()) : all.length === 1 ? all[0] : undefined;
      if (!pick) throw new Error(`Say which attachment: ${all.map((x) => `${x.filename} (${x.mimeType}, ${x.size} bytes)`).join("; ")}`);
      const att = (await gmail.users.messages.attachments.get({ userId: "me", messageId: a.messageId, id: pick.attachmentId })).data;
      const src = Buffer.from(att.data ?? "", "base64url");
      if (!src.length) throw new Error("Empty attachment data.");
      const attachment = { filename: pick.filename, mimeType: pick.mimeType, bytes: src.length, subject: header(m, "subject"), from: header(m, "from") };
      const isImage = pick.mimeType.startsWith("image/");
      let outputs: { path: string; width?: number; height?: number; bytes: number; base64: string }[];
      let source: Record<string, unknown> = {};
      let notes: string[] = [];
      if (a.convert && isImage) {
        const r = await renderImageOutputs(src, a);
        outputs = r.outputs; source = r.source; notes = r.notes;
      } else {
        if (a.convert && !isImage) notes.push("Not an image, committed as-is.");
        outputs = [{ path: a.path.replace(/^\//, ""), bytes: src.length, base64: src.toString("base64") }];
      }
      const report = outputs.map(({ base64: _b, ...rest }) => rest);
      if (a.dryRun) return { dryRun: true, attachment, source, outputs: report, notes, note: "No commit was made." };
      const done = await commitBlobs(a.repo, a.branch, a.message, outputs.map((o) => ({ path: o.path, base64: o.base64 })), a.createBranch);
      return { repo: a.repo, branch: a.branch, ...done, attachment, source, outputs: report, notes };
    }),
  );
}
