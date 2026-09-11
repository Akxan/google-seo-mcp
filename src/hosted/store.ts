/**
 * Hosted (multi-tenant) mode: users sign in with Google on the web UI, the server keeps their
 * OAuth refresh token encrypted in SQLite and issues personal bearer tokens for /mcp.
 * Pure helpers (crypto, token format, cookie signing) are exported for unit tests; the store
 * takes a database path (":memory:" in tests).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---------- crypto ----------

/** 32-byte key derived from the operator's secret (any length string). */
export function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

/** AES-256-GCM, output `base64url(iv).base64url(tag).base64url(ciphertext)`. */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(blob: string, key: Buffer): string {
  const [iv, tag, ct] = blob.split(".").map((s) => Buffer.from(s, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export const TOKEN_PREFIX = "seo_";

/** Fresh bearer token: `seo_` + 32 random bytes (base64url). Only its hash is stored. */
export function newToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Sign a small JSON payload for a cookie: `base64url(json).base64url(hmac)`. */
export function signPayload(payload: Record<string, unknown>, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyPayload<T = Record<string, unknown>>(value: string | undefined, key: Buffer): T | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const body = value.slice(0, dot), mac = value.slice(dot + 1);
  const expected = createHmac("sha256", key).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (typeof parsed.exp === "number" && parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------- store ----------

export interface User { id: string; googleSub: string; email: string; name: string | null; picture: string | null; scopes: string[]; createdAt: string; lastSeenAt: string | null }
export interface TokenRow { hash: string; userId: string; prefix: string; label: string | null; createdAt: string; lastUsedAt: string | null; calls: number; revokedAt: string | null }

export class HostedStore {
  private db: DatabaseSync;
  constructor(file: string, private key: Buffer) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, email TEXT NOT NULL, name TEXT, picture TEXT,
        refresh_token TEXT NOT NULL, scopes TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT);
      CREATE TABLE IF NOT EXISTS tokens (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, prefix TEXT NOT NULL, label TEXT,
        created_at TEXT NOT NULL, last_used_at TEXT, calls INTEGER NOT NULL DEFAULT 0, revoked_at TEXT);
      CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
      CREATE TABLE IF NOT EXISTS connections (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL, external_id TEXT NOT NULL,
        label TEXT, meta TEXT, created_at TEXT NOT NULL, PRIMARY KEY (user_id, provider));
    `);
  }

  close() { this.db.close(); }

  /** Insert or update a user after a Google sign-in. A missing refresh token keeps the stored one. */
  upsertUser(u: { googleSub: string; email: string; name?: string | null; picture?: string | null; refreshToken?: string | null; scopes: string[] }): User {
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT id FROM users WHERE google_sub = ?").get(u.googleSub) as { id: string } | undefined;
    if (existing) {
      if (u.refreshToken) {
        this.db.prepare("UPDATE users SET email=?, name=?, picture=?, refresh_token=?, scopes=?, last_seen_at=? WHERE id=?")
          .run(u.email, u.name ?? null, u.picture ?? null, encrypt(u.refreshToken, this.key), u.scopes.join(" "), now, existing.id);
      } else {
        this.db.prepare("UPDATE users SET email=?, name=?, picture=?, last_seen_at=? WHERE id=?").run(u.email, u.name ?? null, u.picture ?? null, now, existing.id);
      }
      return this.getUser(existing.id)!;
    }
    if (!u.refreshToken) throw new Error("Google did not return a refresh token; remove the app under myaccount.google.com/permissions and sign in again.");
    const id = randomBytes(8).toString("hex");
    this.db.prepare("INSERT INTO users (id, google_sub, email, name, picture, refresh_token, scopes, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, u.googleSub, u.email, u.name ?? null, u.picture ?? null, encrypt(u.refreshToken, this.key), u.scopes.join(" "), now, now);
    return this.getUser(id)!;
  }

  getUser(id: string): User | null {
    const r = this.db.prepare("SELECT id, google_sub, email, name, picture, scopes, created_at, last_seen_at FROM users WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    return r ? { id: r.id!, googleSub: r.google_sub!, email: r.email!, name: r.name, picture: r.picture, scopes: (r.scopes ?? "").split(" ").filter(Boolean), createdAt: r.created_at!, lastSeenAt: r.last_seen_at } : null;
  }

  refreshTokenOf(userId: string): string | null {
    const r = this.db.prepare("SELECT refresh_token FROM users WHERE id = ?").get(userId) as { refresh_token: string } | undefined;
    return r ? decrypt(r.refresh_token, this.key) : null;
  }

  deleteUser(id: string) { this.db.prepare("DELETE FROM users WHERE id = ?").run(id); }

  countUsers(): number { return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n; }

  /** Create a bearer token for a user; the clear-text token is returned once and never stored. */
  createToken(userId: string, label?: string | null): { token: string; row: TokenRow } {
    const token = newToken();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO tokens (hash, user_id, prefix, label, created_at) VALUES (?,?,?,?,?)").run(hashToken(token), userId, token.slice(0, 10), label ?? null, now);
    return { token, row: this.listTokens(userId).find((t) => t.prefix === token.slice(0, 10))! };
  }

  listTokens(userId: string): TokenRow[] {
    return (this.db.prepare("SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Record<string, string | number | null>[]).map(rowToToken);
  }

  revokeToken(userId: string, hash: string) {
    this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND hash = ? AND revoked_at IS NULL").run(new Date().toISOString(), userId, hash);
  }

  /** Resolve a presented bearer token to its user; null when unknown or revoked. Updates usage counters. */
  resolveToken(token: string): { user: User; token: TokenRow } | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const hash = hashToken(token);
    const row = this.db.prepare("SELECT * FROM tokens WHERE hash = ? AND revoked_at IS NULL").get(hash) as Record<string, string | number | null> | undefined;
    if (!row) return null;
    const user = this.getUser(String(row.user_id));
    if (!user) return null;
    this.db.prepare("UPDATE tokens SET last_used_at = ?, calls = calls + 1 WHERE hash = ?").run(new Date().toISOString(), hash);
    return { user, token: rowToToken(row) };
  }

  /** Third-party connections (e.g. a GitHub App installation), one per provider and user; `meta` holds non-secret details. */
  setConnection(userId: string, c: { provider: string; externalId: string; label?: string | null; meta?: Record<string, unknown> }) {
    this.db.prepare("INSERT INTO connections (user_id, provider, external_id, label, meta, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, provider) DO UPDATE SET external_id=excluded.external_id, label=excluded.label, meta=excluded.meta, created_at=excluded.created_at")
      .run(userId, c.provider, c.externalId, c.label ?? null, JSON.stringify(c.meta ?? {}), new Date().toISOString());
  }

  getConnection(userId: string, provider: string): Connection | null {
    const r = this.db.prepare("SELECT * FROM connections WHERE user_id = ? AND provider = ?").get(userId, provider) as Record<string, string | null> | undefined;
    return r ? { provider: r.provider!, externalId: r.external_id!, label: r.label, meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {}, createdAt: r.created_at! } : null;
  }

  deleteConnection(userId: string, provider: string) {
    this.db.prepare("DELETE FROM connections WHERE user_id = ? AND provider = ?").run(userId, provider);
  }
}

export interface Connection { provider: string; externalId: string; label: string | null; meta: Record<string, unknown>; createdAt: string }

function rowToToken(r: Record<string, string | number | null>): TokenRow {
  return { hash: String(r.hash), userId: String(r.user_id), prefix: String(r.prefix), label: (r.label as string | null) ?? null, createdAt: String(r.created_at), lastUsedAt: (r.last_used_at as string | null) ?? null, calls: Number(r.calls ?? 0), revokedAt: (r.revoked_at as string | null) ?? null };
}
