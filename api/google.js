// ============================================================
// GET /api/google?action=status      → { configured, connected }
// GET /api/google?action=auth        → 302 to Google's consent screen
// GET /api/google?action=token       → { access_token, expires_in } (uses the refresh cookie)
// GET /api/google?action=disconnect  → revokes + clears the cookie
//
// The consent screen redirects back to /api/google-callback.
// See api/_google.js for how the refresh token is stored.
// ============================================================
import crypto from 'node:crypto';
import { SCOPES, COOKIE, STATE_COOKIE, config, redirectUri, parseCookies, cookie, unseal, tokenRequest } from './_google.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = String((req.query && req.query.action) || 'status');
  const cfg = config();
  const cookies = parseCookies(req);
  const session = cookies[COOKIE] ? unseal(cookies[COOKIE], cfg.cookieSecret) : null;

  if (action === 'status') {
    return res.status(200).json({ configured: cfg.ok, connected: !!(cfg.ok && session && session.rt) });
  }

  if (!cfg.ok) return res.status(500).json({ error: 'Google is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel.' });

  if (action === 'auth') {
    const ret = String((req.query && req.query.return) || '/');
    const state = crypto.randomBytes(16).toString('hex');
    // Only same-site relative paths may be used as the post-login return target.
    const safeReturn = /^\/(?!\/)[\w\-./?=&%]*$/.test(ret) ? ret : '/';
    res.setHeader('Set-Cookie', cookie(STATE_COOKIE, state + '|' + safeReturn, { maxAge: 600 }));
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri(req),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    }).toString();
    res.statusCode = 302;
    res.setHeader('Location', url);
    return res.end();
  }

  if (action === 'token') {
    if (!session || !session.rt) return res.status(401).json({ connected: false });
    const r = await tokenRequest({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: session.rt,
      grant_type: 'refresh_token',
    });
    if (!r.ok) {
      // invalid_grant = revoked, expired (7-day limit while the OAuth app is in
      // "Testing"), or password changed. Drop the cookie so the UI shows "Connect".
      if (r.json && r.json.error === 'invalid_grant') {
        res.setHeader('Set-Cookie', cookie(COOKIE, '', { maxAge: 0 }));
        return res.status(401).json({ connected: false, error: 'Google access expired or was revoked — reconnect.' });
      }
      return res.status(502).json({ error: (r.json && (r.json.error_description || r.json.error)) || 'token refresh failed' });
    }
    return res.status(200).json({ access_token: r.json.access_token, expires_in: r.json.expires_in || 3600, scope: r.json.scope || '' });
  }

  if (action === 'disconnect') {
    if (session && session.rt) {
      try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(session.rt), { method: 'POST' }); } catch (e) {}
    }
    res.setHeader('Set-Cookie', cookie(COOKIE, '', { maxAge: 0 }));
    return res.status(200).json({ connected: false });
  }

  return res.status(400).json({ error: 'unknown action' });
}
