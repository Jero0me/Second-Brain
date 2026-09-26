// =============================================================
// Shared cloud-sync helper for the dashboard.
//
// Every module's data lives in one row of public.app_state (keyed by
// appKey). A page registers the rows it reads/writes:
//
//   CloudSync.init('goals', { onApplied })          // row from ROWS below
//   initCloudSync({ appKey, syncedKeys, syncedPrefixes, onApplied })  // legacy form
//
// E.F.I. writes into several modules at once (goals, finance, notes…),
// so a page may register many rows — localStorage is patched ONCE and
// each write is routed to every row whose keys/prefixes match it.
//
// CloudSync.ready(appKey) resolves after that row's initial pull, so
// writers can wait for it instead of racing (and losing to) the pull.
//
// Requires:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="sync.js" defer></script>
// =============================================================
(function () {
  'use strict';

  // Prefer Vercel env vars (served via /api/config → window.DASH_*),
  // otherwise fall back to these defaults.
  const SUPABASE_URL = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || 'https://srajryooffirbroltjmg.supabase.co';
  const SUPABASE_KEY = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || 'sb_publishable_5142ZwTLF_DkSVRzciNuRA_bHwRAu4c';

  // Single source of truth for which localStorage keys belong to which row.
  // Anything prefixed `efi_local:` (API keys, OAuth tokens, chat history)
  // is deliberately NOT here — it must never leave the device.
  const ROWS = {
    goals:    { syncedPrefixes: ['goals:', 'habits:', 'templates:', 'plan:'], syncedKeys: ['goal_streak_v1'] },
    finance:  { syncedPrefixes: ['nw:'], syncedKeys: ['subs', 'wishlist', 'incoming_orders'] },
    mealprep: { syncedPrefixes: ['mealprep:'], syncedKeys: [] },
    efi:      { syncedPrefixes: [], syncedKeys: ['profile:v1', 'efi:events', 'efi:notes', 'efi:caffeine', 'efi:settings'] },
  };

  const enabled = typeof window !== 'undefined' && !!window.supabase && !!SUPABASE_URL && !!SUPABASE_KEY &&
    SUPABASE_URL.indexOf('PASTE-') !== 0 && SUPABASE_KEY.indexOf('PASTE-') !== 0;

  // Postgres jsonb re-orders object keys, so a plain JSON.stringify of what
  // we pushed never equals what comes back over realtime. Comparing with a
  // key-sorted stringify stops our own echoes from being "applied" again
  // (which used to re-render lists mid-edit after every save).
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  function parseMaybe(s) { try { return JSON.parse(s); } catch (e) { return s; } }

  // One signed-in client shared with the rest of the app (efi-auth.js).
  function sharedClient() {
    return (window.EFIAuth && window.EFIAuth.client()) || window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }

  const rows = {};      // appKey -> row state
  let supa = null;
  let suppress = 0;
  let origSet = null, origRemove = null;

  function rowsMatching(k) {
    const out = [];
    if (!k) return out;
    for (const appKey in rows) if (rows[appKey].matches(k)) out.push(rows[appKey]);
    return out;
  }

  function patchStorage() {
    if (origSet) return;
    origSet = localStorage.setItem.bind(localStorage);
    origRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { if (!suppress) rowsMatching(k).forEach((r) => r.schedulePush()); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppress) rowsMatching(k).forEach((r) => r.schedulePush()); } catch (e) {}
    };
    window.addEventListener('storage', (e) => {
      if (e.key) rowsMatching(e.key).forEach((r) => r.schedulePush());
    });
    const flushAll = () => { for (const k in rows) rows[k].flushOnUnload(); };
    window.addEventListener('pagehide', flushAll);
    window.addEventListener('beforeunload', flushAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll(); });
  }

  function makeRow(appKey, cfg) {
    const syncedKeys = cfg.syncedKeys || [];
    const syncedPrefixes = cfg.syncedPrefixes || [];
    const listeners = [];
    let pushTimer = null;
    let pulled = false;      // initial cloud pull succeeded
    let lastSynced = null;   // stable() of last state pushed or received
    let resolveReady;
    const ready = new Promise((r) => { resolveReady = r; });

    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v != null) out[k] = parseMaybe(v);
      }
      return out;
    }
    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      let changed = false;
      suppress++;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const local = localStorage.getItem(k);
          if (local != null && stable(parseMaybe(local)) === stable(remote[k])) continue;
          try { origSet(k, JSON.stringify(remote[k])); changed = true; } catch (e) {}
        }
        for (const k of listAllKeys()) {
          if (!(k in remote)) { try { origRemove(k); changed = true; } catch (e) {} }
        }
      } finally { suppress--; }
      if (changed) listeners.forEach((fn) => { try { fn(appKey); } catch (e) {} });
      return changed;
    }
    async function pushNow() {
      // Never push before this device has seen the cloud copy — pushing
      // stale local data first would overwrite newer edits from elsewhere.
      if (!supa || !pulled) return;
      const state = collect();
      const sig = stable(state);
      if (sig === lastSynced) return;
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) lastSynced = sig;
      } catch (e) {}
    }
    function schedulePush() {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushNow, 250);
    }
    function flushOnUnload() {
      if (!supa || !pulled) return;
      const state = collect();
      const sig = stable(state);
      if (sig === lastSynced) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + (window.EFIAuth ? window.EFIAuth.accessToken() : SUPABASE_KEY),
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSynced = sig;
      } catch (e) {}
    }
    async function start() {
      // Signed-in session first — the database only answers the owner.
      if (window.EFIAuth) await window.EFIAuth.whenReady();
      async function pull() {
        for (let attempt = 0; attempt < 4 && !pulled; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
          try {
            const { data, error } = await supa.from('app_state').select('data').eq('key', appKey).maybeSingle();
            if (error) continue;
            pulled = true;
            if (data && data.data && Object.keys(data.data).length > 0) {
              lastSynced = stable(data.data);
              applyRemote(data.data);
            } else if (Object.keys(collect()).length > 0) {
              schedulePush();
            }
          } catch (e) {}
        }
      }
      await pull();
      resolveReady();
      // Opened offline: keep trying when the connection returns (and every
      // minute) instead of staying unsynced until the next reload.
      if (!pulled) {
        const retry = async () => {
          if (pulled) return;
          await pull();
          if (pulled) { window.removeEventListener('online', retry); clearInterval(timer); }
        };
        window.addEventListener('online', retry);
        const timer = setInterval(retry, 60000);
      }
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const sig = stable(payload.new.data);
          if (sig === lastSynced) return; // echo of our own push
          lastSynced = sig;
          applyRemote(payload.new.data);
        })
        .subscribe();
    }

    return { appKey, matches, schedulePush, flushOnUnload, listeners, ready, start, resolveReady };
  }

  function init(appKey, opts) {
    opts = opts || {};
    if (!appKey) return Promise.resolve();
    let row = rows[appKey];
    if (!row) {
      const def = ROWS[appKey] || { syncedKeys: opts.syncedKeys, syncedPrefixes: opts.syncedPrefixes };
      row = rows[appKey] = makeRow(appKey, def);
      if (!enabled) { row.resolveReady(); }
      else {
        patchStorage();
        if (!supa) supa = sharedClient();
        row.start();
      }
    }
    if (typeof opts.onApplied === 'function') row.listeners.push(opts.onApplied);
    return row.ready;
  }

  // Resolves once the named rows (default: every row registered so far)
  // have finished their initial pull. Never rejects; times out after 6s so
  // a flaky connection can't block the UI forever.
  function ready(appKeys) {
    const keys = appKeys ? [].concat(appKeys) : Object.keys(rows);
    const all = Promise.all(keys.map((k) => (rows[k] ? rows[k].ready : Promise.resolve())));
    return Promise.race([all, new Promise((r) => setTimeout(r, 6000))]);
  }

  // Read-only fetch of any row (e.g. the gym page's own 'po-coach' row or
  // the 'apple_health' row) without subscribing to it.
  async function fetchRow(appKey) {
    if (!enabled) return null;
    if (!supa) supa = sharedClient();
    if (window.EFIAuth) await window.EFIAuth.whenReady();
    try {
      const { data, error } = await supa.from('app_state').select('data, updated_at').eq('key', appKey).maybeSingle();
      if (error || !data) return null;
      return data;
    } catch (e) { return null; }
  }

  window.CloudSync = {
    ROWS, enabled, init, ready, fetchRow,
    initAll(opts) { return Promise.all(Object.keys(ROWS).map((k) => init(k, opts))); },
  };

  // Legacy entry point — older pages call this with an inline config.
  window.initCloudSync = function (config) {
    if (!config || !config.appKey) return Promise.resolve();
    return init(config.appKey, config);
  };
})();
