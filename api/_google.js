// ============================================================
// Shared helpers for the Google OAuth endpoints (not a route —
// Vercel skips files that start with an underscore).
//
// The long-lived refresh token is kept in an AES-256-GCM encrypted,
// HttpOnly cookie on this device only. It is never written to
// Supabase (whose app_state table is readable with the public key)
// and never exposed to page JavaScript — pages only ever receive
// short-lived access tokens from /api/google?action=token.
//
// Env vars (Vercel → Settings → Environment Variables):
//   GOOGLE_CLIENT_ID      OAuth 2.0 Web client ID
//   GOOGLE_CLIENT_SECRET  its secret
//   EFI_COOKIE_SECRET     optional; defaults to GOOGLE_CLIENT_SECRET
// ============================================================
import crypto from 'node:crypto';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/tasks',
].join(' ');

export const COOKIE = 'efi_g';
export const STATE_COOKIE = 'efi_g_state';

export function config() {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const cookieSecret = process.env.EFI_COOKIE_SECRET || clientSecret;
  return { clientId, clientSecret, cookieSecret, ok: !!(clientId && clientSecret) };
}

export function origin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host;
}

export function redirectUri(req) { return origin(req) + '/api/google-callback'; }

export function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export function cookie(name, value, opts) {
  opts = opts || {};
  const parts = [name + '=' + encodeURIComponent(value), 'Path=' + (opts.path || '/api'), 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (opts.maxAge != null) parts.push('Max-Age=' + opts.maxAge);
  return parts.join('; ');
}

function key(secret) { return crypto.createHash('sha256').update('efi:' + secret).digest(); }

export function seal(obj, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(secret), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}

export function unseal(str, secret) {
  try {
    const buf = Buffer.from(String(str), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', key(secret), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch (e) { return null; }
}

export async function tokenRequest(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json };
}
