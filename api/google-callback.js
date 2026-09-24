// ============================================================
// GET /api/google-callback — Google's OAuth redirect target.
// Add this exact URL as an "Authorized redirect URI" on the OAuth
// client:  https://<your-app>.vercel.app/api/google-callback
// ============================================================
import { COOKIE, STATE_COOKIE, config, redirectUri, parseCookies, cookie, seal, unseal, tokenRequest } from './_google.js';

function back(res, path, status) {
  const sep = path.indexOf('?') === -1 ? '?' : '&';
  res.statusCode = 302;
  res.setHeader('Location', path + sep + 'google=' + status);
  return res.end();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const cfg = config();
  const q = req.query || {};
  const cookies = parseCookies(req);
  const [expectedState, returnTo] = String(cookies[STATE_COOKIE] || '').split('|');
  const target = returnTo || '/';
  const clearState = cookie(STATE_COOKIE, '', { maxAge: 0 });

  if (!cfg.ok) { res.setHeader('Set-Cookie', clearState); return back(res, target, 'not-configured'); }
  if (q.error) { res.setHeader('Set-Cookie', clearState); return back(res, target, 'denied'); }
  if (!q.code || !q.state || q.state !== expectedState) { res.setHeader('Set-Cookie', clearState); return back(res, target, 'bad-state'); }

  const r = await tokenRequest({
    code: String(q.code),
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code',
  });

  // Google only returns a refresh token on first consent; `prompt=consent`
  // forces it, but keep any previous one if it's somehow missing.
  const previous = cookies[COOKIE] ? unseal(cookies[COOKIE], cfg.cookieSecret) : null;
  const rt = (r.json && r.json.refresh_token) || (previous && previous.rt);
  if (!r.ok || !rt) { res.setHeader('Set-Cookie', clearState); return back(res, target, 'failed'); }

  res.setHeader('Set-Cookie', [
    clearState,
    cookie(COOKIE, seal({ rt, at: Date.now() }, cfg.cookieSecret), { maxAge: 60 * 60 * 24 * 400 }),
  ]);
  return back(res, target, 'connected');
}
