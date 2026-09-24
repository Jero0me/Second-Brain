// =============================================================
// E.F.I. sign-in — one shared, signed-in Supabase client for every
// page, plus the full-screen sign-in gate.
//
// Security is enforced by Supabase row-level security (see SETUP.md §2):
// only the owner account can read/write app_state. This file just makes
// sure the app talks to Supabase *as* that account.
//
//   EFIAuth.client()        → the shared supabase client (or null if not configured)
//   EFIAuth.whenReady()     → resolves once signed in (or immediately if Supabase isn't configured)
//   EFIAuth.accessToken()   → current JWT, for raw fetch()es (keepalive flushes)
//   EFIAuth.user()          → the signed-in user, or null
//   EFIAuth.signOut()
//
// Load WITHOUT defer, right after supabase-js and /api/config:
//   <script src="efi-auth.js"></script>
// =============================================================
(function () {
  'use strict';

  const URL_ = (window.DASH_SUPABASE_URL) || 'https://srajryooffirbroltjmg.supabase.co';
  const KEY = (window.DASH_SUPABASE_KEY) || 'sb_publishable_5142ZwTLF_DkSVRzciNuRA_bHwRAu4c';
  const enabled = !!window.supabase && !!URL_ && !!KEY && URL_.indexOf('PASTE-') !== 0 && KEY.indexOf('PASTE-') !== 0;
  const OWNER_CACHE = 'efi_local:owner_ok';

  let client = null;
  let session = null;
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  let readyDone = false;
  const listeners = [];

  function getClient() {
    if (!enabled) return null;
    if (!client) {
      try {
        client = window.supabase.createClient(URL_, KEY, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'efi-auth' },
        });
      } catch (e) { return null; }
    }
    return client;
  }

  function markReady() {
    if (readyDone) return;
    readyDone = true;
    resolveReady(session);
    listeners.forEach((fn) => { try { fn(session); } catch (e) {} });
  }

  // ---------- ownership ----------
  // The first account to sign in after the SQL in SETUP.md runs becomes the
  // owner. Anyone else who signs in gets nothing from the database (RLS) and
  // is shown this message. Offline / SQL-not-yet-run → allowed through (the
  // database still enforces the real rule).
  async function checkOwner(s) {
    const uid = s && s.user && s.user.id;
    try { if (uid && sessionStorage.getItem(OWNER_CACHE) === uid) return true; } catch (e) {}
    const { data, error } = await getClient().rpc('claim_app_ownership');
    // Function missing (SQL not run yet) or offline: let the app in — RLS in
    // the database is what actually protects the data.
    if (error) return true;
    if (data === true) { try { sessionStorage.setItem(OWNER_CACHE, uid); } catch (e) {} }
    return data === true;
  }

  async function afterSignIn(s) {
    session = s;
    const owner = await checkOwner(s);
    if (!owner) {
      gate.show('This account doesn\'t own this E.F.I. — sign in with the owner account.');
      try { await getClient().auth.signOut(); } catch (e) {}
      session = null;
      return;
    }
    gate.hide();
    markReady();
  }

  // ---------- gate UI ----------
  const gate = (function () {
    let el = null, pendingMsg = null;
    const css = `
.efi-gate { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: radial-gradient(120% 60% at 0% 0%, rgba(40,170,120,0.30), transparent 55%), radial-gradient(90% 50% at 100% 0%, rgba(24,110,120,0.22), transparent 60%), #05090A;
  font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #A7B6B3; }
.efi-gate[hidden] { display: none !important; }
.efi-gate-card { width: 100%; max-width: 360px; text-align: center; }
.efi-gate-orb { width: 96px; height: 96px; margin: 0 auto 22px; border-radius: 50%;
  background: radial-gradient(circle at 36% 28%, rgba(255,255,255,0.9), rgba(255,255,255,0) 30%), radial-gradient(circle at 50% 40%, #B9FFE6 0%, #5FF0BF 30%, #22C08D 62%, #0B5E47 100%);
  box-shadow: 0 0 60px 6px rgba(52,216,160,0.35); animation: efi-gate-b 5s ease-in-out infinite; }
@keyframes efi-gate-b { 0%,100% { transform: scale(1); } 50% { transform: scale(1.04); } }
.efi-gate h1 { margin: 0; color: #F2F7F6; font-size: 25px; font-weight: 800; letter-spacing: -0.02em; }
.efi-gate p { margin: 8px 0 24px; font-size: 13.5px; line-height: 1.5; }
.efi-gate button, .efi-gate input { width: 100%; font: inherit; border-radius: 16px; padding: 14px 16px; font-size: 15px; }
.efi-gate .g-btn { border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06); color: #F2F7F6; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; }
.efi-gate .or { display: flex; align-items: center; gap: 10px; margin: 18px 0; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #6B7C79; }
.efi-gate .or::before, .efi-gate .or::after { content: ''; flex: 1; height: 1px; background: rgba(255,255,255,0.08); }
.efi-gate input { border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.3); color: #F2F7F6; outline: none; margin-bottom: 10px; text-align: center; }
.efi-gate input:focus { border-color: rgba(52,216,160,0.55); }
.efi-gate input.code { letter-spacing: 0.4em; font-size: 22px; font-weight: 700; }
.efi-gate .p-btn { border: 0; background: linear-gradient(180deg, #5EF0BC, #1FB58A); color: #03140E; font-weight: 800; cursor: pointer; box-shadow: 0 8px 26px rgba(52,216,160,0.35); }
.efi-gate button:disabled { opacity: 0.55; cursor: default; }
.efi-gate .msg { min-height: 18px; margin-top: 12px; font-size: 12.5px; }
.efi-gate .msg.err { color: #FF9A90; } .efi-gate .msg.ok { color: #34D8A0; }
.efi-gate .link { background: none; border: 0; color: #6B7C79; font-size: 12px; padding: 8px; cursor: pointer; width: auto; }
body.efi-gated { overflow: hidden; }`;

    function build() {
      if (el) return el;
      const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
      el = document.createElement('div');
      el.className = 'efi-gate'; el.hidden = true;
      el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Sign in to E.F.I.');
      el.innerHTML =
        '<div class="efi-gate-card"><div class="efi-gate-orb"></div>' +
        '<h1>Sign in to E.F.I.</h1><p>Your data is private to your account.</p>' +
        '<div data-step="start">' +
          '<input type="email" data-f="email" placeholder="you@email.com" autocomplete="username" inputmode="email">' +
          '<input type="password" data-f="password" placeholder="Password" autocomplete="current-password">' +
          '<button type="button" class="p-btn" data-a="password">Sign in</button>' +
          '<div class="or">or</div>' +
          '<button type="button" class="g-btn" data-a="google"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Continue with Google</button>' +
          '<button type="button" class="link" data-a="send">Email me a sign-in link instead</button>' +
        '</div>' +
        '<div data-step="code" hidden>' +
          '<p style="margin:0 0 14px">Open the email on <b>this device</b> and tap the link. If the email shows a code instead, enter it here:</p>' +
          '<input type="text" class="code" data-f="code" placeholder="••••••" inputmode="numeric" autocomplete="one-time-code" maxlength="10">' +
          '<button type="button" class="p-btn" data-a="verify">Sign in with code</button>' +
          '<button type="button" class="link" data-a="back">Back</button>' +
        '</div>' +
        '<div class="msg" data-f="msg"></div></div>';
      document.body.appendChild(el);

      const $ = (s) => el.querySelector(s);
      const msg = (t, cls) => {
        if (cls === 'err' && /failed to fetch|network|load failed/i.test(t || '')) t = 'Can\'t reach the server — check your connection and try again.';
        const m = $('[data-f=msg]'); m.textContent = t || ''; m.className = 'msg' + (cls ? ' ' + cls : '');
      };
      const step = (s) => { el.querySelectorAll('[data-step]').forEach((d) => { d.hidden = d.dataset.step !== s; }); };
      let email = '';

      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-a]'); if (!b) return;
        const c = getClient();
        // Email + password: no email or redirect involved, so it works the same
        // in Safari and in the iPhone home-screen app.
        if (b.dataset.a === 'password') {
          email = $('[data-f=email]').value.trim();
          const password = $('[data-f=password]').value;
          if (!/^\S+@\S+\.\S+$/.test(email)) { msg('Enter your email address.', 'err'); return; }
          if (!password) { msg('Enter your password.', 'err'); $('[data-f=password]').focus(); return; }
          b.disabled = true; msg('Signing in…');
          const { data, error } = await c.auth.signInWithPassword({ email, password });
          b.disabled = false;
          if (error) {
            msg(/invalid login credentials/i.test(error.message) ? 'Wrong email or password.'
              : /not confirmed/i.test(error.message) ? 'This account isn\'t confirmed yet — in Supabase → Authentication → Users, create it with "Auto Confirm User" ticked.'
              : error.message, 'err');
            return;
          }
          msg('');
          if (data && data.session) afterSignIn(data.session);
        }
        if (b.dataset.a === 'google') {
          msg('Opening Google…');
          const { error } = await c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
          if (error) msg(/provider is not enabled/i.test(error.message) ? 'Google sign-in isn\'t enabled in Supabase — use your email and password.' : error.message, 'err');
        }
        if (b.dataset.a === 'send') {
          email = $('[data-f=email]').value.trim();
          if (!/^\S+@\S+\.\S+$/.test(email)) { msg('Enter your email address first.', 'err'); $('[data-f=email]').focus(); return; }
          b.disabled = true; msg('Sending…');
          const { error } = await c.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
          b.disabled = false;
          if (error) { msg(error.message, 'err'); return; }
          step('code'); msg('Sent to ' + email + '.', 'ok');
          setTimeout(() => $('[data-f=code]').focus(), 50);
        }
        if (b.dataset.a === 'verify') {
          const token = $('[data-f=code]').value.replace(/\s/g, '');
          if (token.length < 6) { msg('Enter the code from the email.', 'err'); return; }
          b.disabled = true; msg('Signing in…');
          const { data, error } = await c.auth.verifyOtp({ email, token, type: 'email' });
          b.disabled = false;
          if (error) { msg(/expired|invalid/i.test(error.message) ? 'That code is wrong or expired — request a new one.' : error.message, 'err'); return; }
          msg('');
          if (data && data.session) afterSignIn(data.session);
        }
        if (b.dataset.a === 'back') { step('start'); msg(''); }
      });
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (e.target.matches('[data-f=email]')) $('[data-f=password]').focus();
        if (e.target.matches('[data-f=password]')) $('[data-a=password]').click();
        if (e.target.matches('[data-f=code]')) $('[data-a=verify]').click();
      });
      return el;
    }

    function withBody(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn, { once: true }); }
    return {
      show(message) {
        pendingMsg = message || null;
        withBody(() => {
          build(); el.hidden = false; document.body.classList.add('efi-gated');
          const m = el.querySelector('[data-f=msg]');
          if (pendingMsg) { m.textContent = pendingMsg; m.className = 'msg err'; }
        });
      },
      hide() { withBody(() => { if (el) el.hidden = true; document.body.classList.remove('efi-gated'); }); },
    };
  })();

  // ---------- boot ----------
  (async function boot() {
    if (!enabled || !getClient()) { markReady(); return; }
    const c = getClient();
    c.auth.onAuthStateChange((event, s) => {
      if (s) session = s;
      // First sign-in, or signing back in after a sign-out on this page.
      if (event === 'SIGNED_IN' && s && (!readyDone || document.body.classList.contains('efi-gated'))) afterSignIn(s);
      if (event === 'SIGNED_OUT') { session = null; try { sessionStorage.removeItem(OWNER_CACHE); } catch (e) {} gate.show(); }
    });
    // A failed email link / Google redirect lands here with the reason in the
    // URL (e.g. "Email link is invalid or has expired") — show it, don't swallow it.
    const urlParams = new URLSearchParams(location.hash.replace(/^#/, '') + '&' + location.search.replace(/^\?/, ''));
    const linkError = urlParams.get('error_description');
    let s = null;
    try { s = (await c.auth.getSession()).data.session; } catch (e) {}
    if (s) afterSignIn(s);
    else gate.show(linkError ? 'Sign-in link failed: ' + linkError.replace(/\+/g, ' ') + '. Use your email and password instead.' : null);
    // Clean the OAuth/magic-link tokens out of the address bar.
    if (/access_token=|error_description=|error=/.test(location.hash + location.search)) history.replaceState(null, '', location.pathname);
  })();

  window.EFIAuth = {
    enabled,
    client: getClient,
    whenReady: () => ready,
    onReady(fn) { if (readyDone) fn(session); else listeners.push(fn); },
    accessToken: () => (session && session.access_token) || KEY,
    user: () => (session && session.user) || null,
    // Revokes the session server-side when online; if that fails (offline),
    // still forgets it on this device so sign-out always works.
    async signOut() {
      const c = getClient(); if (!c) return;
      let res = null;
      try { res = await c.auth.signOut(); } catch (e) { res = { error: e }; }
      if (res && res.error) await c.auth.signOut({ scope: 'local' });
    },
  };
})();
