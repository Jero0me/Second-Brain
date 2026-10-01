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
// Merging: rows are merged KEY BY KEY, not overwritten whole. Every local
// change records when it happened (efi_local:sync:<row>, never synced) and
// the row carries the same stamps in data.__meta.ts — so two devices that
// edit different things (say the phone offline, the laptop online) both
// keep their edits; for the same key the latest edit wins. A deleted key
// keeps its stamp as a tombstone (pruned after 60 days) so it stays deleted.
// Writes are conditional on the row's updated_at: if another device wrote
// in between, we re-read, merge again and retry.
//
// Writes made in the first moments of a page load, before the first pull
// (daily setup, migrations), are not stamped: the cloud copy wins for those,
// as it always has, and pages re-run their setup after the pull. Anything
// later is the user's — stamped even while the pull is still running (slow
// sign-in, weak signal), or the pull would quietly undo it.
//
// Also: CloudSync.reader(rowKey, opts) — read-only access to a row the
// server writes (apple_health, hevy, wallet), with a per-device cache.
//
// CloudSync.log() — the last sync events on this device (pulls, edits,
// pushes, cloud overwrites), kept in efi_local:sync_log for troubleshooting.
// CloudSync.status(appKey) → { pulled, lastPush, lastError, pending }.
//
// Requires (efi-auth.js provides the client and the project config):
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js"></script>
//   <script src="efi-auth.js"></script>
//   <script src="sync.js" defer></script>
// =============================================================
(function () {
  'use strict';

  const CFG = (window.EFIAuth && window.EFIAuth.config) || { url: '', key: '' };
  const SUPABASE_URL = CFG.url;
  const SUPABASE_KEY = CFG.key;

  // Single source of truth for which localStorage keys belong to which row.
  // Anything prefixed `efi_local:` (API keys, OAuth tokens, chat history)
  // is deliberately NOT here — it must never leave the device.
  const ROWS = {
    goals:    { syncedPrefixes: ['goals:', 'habits:', 'templates:', 'plan:'], syncedKeys: ['goal_streak_v1'] },
    // spend_meta = categories + removed Apple Pay payments; fin:manual = hand-logged
    // expenses; fin:budget = monthly/category budgets (all read by wallet.js).
    finance:  { syncedPrefixes: ['nw:', 'fin:'], syncedKeys: ['subs', 'wishlist', 'incoming_orders', 'spend_meta'] },
    mealprep: { syncedPrefixes: ['mealprep:'], syncedKeys: [] },
    efi:      { syncedPrefixes: [], syncedKeys: ['profile:v1', 'efi:events', 'efi:notes', 'efi:caffeine', 'efi:symptoms', 'efi:settings', 'fitness:targets'] },
    // The Fitness page's own row. po_coach_v1 / _workout_done are the old
    // in-app lift log (workouts now come from Hevy) — kept so that history
    // isn't wiped from the cloud. Photos are stored as Storage URLs only.
    'po-coach': { syncedPrefixes: [], syncedKeys: ['po_coach_v1', 'po_coach_workout_done', 'po_coach_weights', 'po_coach_photos'] },
  };

  const META = '__meta';                  // per-key change stamps inside the row
  const TOMBSTONE_MS = 60 * 864e5;
  const BOOT_GRACE_MS = 3000;              // stamp writes once the page has settled, pulled or not
  const bootAt = Date.now();
  const BUILD = '2026-10-01.3';           // shown in the sync log — bump on sync changes
  const LOG_LS = 'efi_local:sync_log', LOG_MAX = 150;
  const pageName = () => { try { return location.pathname.split('/').pop() || 'index.html'; } catch (e) { return '?'; } };

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

  function sharedClient() {
    return (window.EFIAuth && window.EFIAuth.client()) || window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }

  const rows = {};      // appKey -> row state
  let supa = null;
  // The real Storage methods, captured before patching.
  const protoSet = Storage.prototype.setItem, protoRemove = Storage.prototype.removeItem;
  let patched = false;
  const rawSet = (k, v) => protoSet.call(localStorage, k, v);
  const rawRemove = (k) => protoRemove.call(localStorage, k);

  function log(row, ev, detail) {
    try {
      const arr = JSON.parse(localStorage.getItem(LOG_LS) || '[]');
      arr.push({ t: Date.now(), p: pageName(), r: row, e: ev, d: detail == null ? undefined : String(detail).slice(0, 240) });
      if (arr.length > LOG_MAX) arr.splice(0, arr.length - LOG_MAX);
      rawSet(LOG_LS, JSON.stringify(arr));
    } catch (e) {}
  }
  const errText = (e) => (e && typeof e === 'object') ? [e.message, e.code && '[' + e.code + ']', e.status].filter(Boolean).join(' ') || JSON.stringify(e) : String(e);

  function rowsMatching(k) {
    const out = [];
    if (!k) return out;
    for (const appKey in rows) if (rows[appKey].matches(k)) out.push(rows[appKey]);
    return out;
  }

  let suppress = 0;
  // Patched on Storage.prototype, not on the localStorage object: assigning
  // localStorage.setItem = fn may just store an item called "setItem" (the
  // spec says so and some browsers do it) — then no write would ever be
  // noticed or synced. sessionStorage passes straight through.
  function patchStorage() {
    if (patched) return;
    patched = true;
    Storage.prototype.setItem = function (k, v) {
      protoSet.call(this, k, v);
      if (this !== window.localStorage) return;
      try { if (!suppress) rowsMatching(String(k)).forEach((r) => r.changed(String(k))); } catch (e) {}
    };
    Storage.prototype.removeItem = function (k) {
      protoRemove.call(this, k);
      if (this !== window.localStorage) return;
      try { if (!suppress) rowsMatching(String(k)).forEach((r) => r.changed(String(k))); } catch (e) {}
    };
    // Another tab of this app changed something: it stamped the change in the
    // shared meta already — just push.
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
    const META_LS = 'efi_local:sync:' + appKey;
    const listeners = [];
    let pushTimer = null;
    let pulled = false;       // initial cloud pull succeeded
    let remote = null;        // last row seen: { data, updated_at } | { data: null } for "no row yet"
    let pushing = false, pushAgain = false;
    let lastPush = null, lastError = null;
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

    function loadMeta() {
      try { const m = JSON.parse(localStorage.getItem(META_LS) || 'null'); if (m && m.ts) return m; } catch (e) {}
      return { v: 1, ts: {}, migrated: false };
    }
    function saveMeta(m) { try { rawSet(META_LS, JSON.stringify(m)); } catch (e) {} }

    // A local write. Stamp it unless the page is still booting (see header).
    function changed(k) {
      if (pulled || Date.now() - bootAt > BOOT_GRACE_MS) {
        const m = loadMeta();
        m.ts[k] = Math.max(Date.now(), (m.ts[k] || 0) + 1);
        saveMeta(m);
        log(appKey, 'edit', k + (pulled ? '' : ' (before pull)'));
      } else {
        log(appKey, 'edit-boot', k + ' (page still loading, cloud copy wins)');
      }
      schedulePush();
    }

    // Local state + remote row → the merged row, key by key.
    // updatedAt: the row's updated_at — a row pushed by an older version of
    // the app has no stamps, so its keys count as changed at that moment.
    function merge(remoteData, updatedAt) {
      const r = remoteData && typeof remoteData === 'object' ? remoteData : {};
      const legacyTs = !r[META] && updatedAt ? (Date.parse(updatedAt) || 0) : 0;
      const rTs = (r[META] && r[META].ts) || {};
      const lTs = loadMeta().ts;
      const remoteEmpty = !Object.keys(r).some((k) => k !== META);
      const keys = {};
      listAllKeys().forEach((k) => { keys[k] = 1; });
      Object.keys(r).forEach((k) => { if (k !== META) keys[k] = 1; });
      Object.keys(rTs).forEach((k) => { keys[k] = 1; });
      Object.keys(lTs).forEach((k) => { keys[k] = 1; });
      const data = {}, ts = {};
      const cut = Date.now() - TOMBSTONE_MS;
      let localWins = false;
      for (const k in keys) {
        if (!matches(k)) continue;
        const lt = lTs[k] || 0, rt = rTs[k] || legacyTs;
        const raw = localStorage.getItem(k);
        // Newer stamp wins; on a tie the cloud copy wins (it has everything
        // any device pushed) — unless there's no cloud copy at all yet.
        const useLocal = lt !== rt ? lt > rt : remoteEmpty;
        const has = useLocal ? raw != null : (k in r);
        const stamp = useLocal ? lt : rt;
        if (useLocal && lt > rt) localWins = true;
        if (has) data[k] = useLocal ? parseMaybe(raw) : r[k];
        if (stamp && (has || stamp > cut)) ts[k] = stamp;
      }
      data[META] = { ts };
      return { data, localWins, base: Object.assign({}, lTs) };
    }
    const isEmptyRow = (d) => !d || (!Object.keys(d).some((k) => k !== META) && !Object.keys((d[META] && d[META].ts) || {}).length);

    // Make localStorage match a merged row. `base` = the local stamps the
    // merge was computed from: a key edited since (while a push was in
    // flight) keeps its newer local value — the next push sends it.
    function applyLocal(data, base, why) {
      const cur = loadMeta().ts;
      const editedSince = (k) => !!base && (cur[k] || 0) !== (base[k] || 0);
      let changedAny = false;
      const touched = [];
      suppress++;
      try {
        for (const k of Object.keys(data)) {
          if (k === META || !matches(k) || editedSince(k)) continue;
          const local = localStorage.getItem(k);
          if (local != null && stable(parseMaybe(local)) === stable(data[k])) continue;
          try { rawSet(k, JSON.stringify(data[k])); changedAny = true; touched.push(k); } catch (e) { log(appKey, 'local-write-failed', k + ': ' + errText(e)); }
        }
        for (const k of listAllKeys()) {
          if (!(k in data) && !editedSince(k)) { try { rawRemove(k); changedAny = true; touched.push('-' + k); } catch (e) {} }
        }
      } finally { suppress--; }
      if (touched.length) log(appKey, 'cloud-applied', (why || '?') + ': ' + touched.join(', '));
      const m = loadMeta();
      m.ts = Object.assign({}, (data[META] && data[META].ts) || {});
      Object.keys(cur).forEach((k) => { if (editedSince(k)) m.ts[k] = cur[k]; });
      m.migrated = true;
      saveMeta(m);
      if (changedAny) listeners.forEach((fn) => { try { fn(appKey); } catch (e) {} });
      return changedAny;
    }

    // First pull on a device that ran the old whole-row sync: the cloud copy
    // is the truth (as it always was), including deletions.
    function adoptRemote(data) {
      const clean = {};
      Object.keys(data).forEach((k) => { if (k !== META) clean[k] = data[k]; });
      clean[META] = { ts: (data[META] && data[META].ts) || {} };
      applyLocal(clean, null, 'first sync on this device');
    }

    const sameRow = (a, b) => stable(a || {}) === stable(b || {});

    // Received a row (pull or realtime): merge it in, push back if we hold newer edits.
    function receive(row, why) {
      remote = { data: row && row.data ? row.data : null, updated_at: row ? row.updated_at : null };
      const hasRemote = remote.data && Object.keys(remote.data).some((k) => k !== META);
      const m = loadMeta();
      if (hasRemote && !m.migrated && !Object.keys(m.ts).length) { adoptRemote(remote.data); return; }
      if (hasRemote && !remote.data[META]) log(appKey, 'legacy-row', 'cloud row has no change stamps: written by an old version of the app at ' + remote.updated_at);
      const merged = merge(remote.data, remote.updated_at);
      applyLocal(merged.data, merged.base, why);
      if (!sameRow(merged.data, remote.data) && !(isEmptyRow(merged.data) && !remote.data)) schedulePush();
    }

    async function writeRow(data, prev) {
      const stamp = new Date().toISOString();
      if (prev && prev.updated_at) {
        const { data: out, error } = await supa.from('app_state').update({ data, updated_at: stamp })
          .eq('key', appKey).eq('updated_at', prev.updated_at).select('updated_at');
        if (error) return { error };
        return out && out.length ? { ok: true, updated_at: out[0].updated_at } : { conflict: true };
      }
      const { data: out, error } = await supa.from('app_state').insert({ key: appKey, data, updated_at: stamp }).select('updated_at');
      if (error) return error.code === '23505' ? { conflict: true } : { error };
      return { ok: true, updated_at: out && out[0] ? out[0].updated_at : stamp };
    }

    async function pushNow() {
      // Never push before this device has seen the cloud copy — pushing
      // stale local data first would overwrite newer edits from elsewhere.
      if (!supa) return;
      if (!pulled) { log(appKey, 'push-wait', 'not pulled yet'); return; }
      if (pushing) { pushAgain = true; return; }
      pushing = true;
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt) {
            // Someone else wrote since we last looked: read it and merge again.
            const { data: row, error } = await supa.from('app_state').select('data, updated_at').eq('key', appKey).maybeSingle();
            if (error) { lastError = errText(error); log(appKey, 'push-reread-error', lastError); return; }
            remote = { data: row ? row.data : null, updated_at: row ? row.updated_at : null };
          }
          const merged = merge(remote && remote.data, remote && remote.updated_at);
          if (sameRow(merged.data, remote && remote.data) || (isEmptyRow(merged.data) && !(remote && remote.data))) { applyLocal(merged.data, merged.base, 'push (nothing new)'); return; }
          const sent = Object.keys(merged.data[META].ts).filter((k) => merged.data[META].ts[k] > ((remote && remote.data && remote.data[META] && remote.data[META].ts[k]) || 0));
          const res = await writeRow(merged.data, remote && remote.updated_at ? remote : null);
          if (res.error) { lastError = errText(res.error); log(appKey, 'push-error', lastError); return; }
          if (res.conflict) { log(appKey, 'push-conflict', 'attempt ' + (attempt + 1)); continue; }
          remote = { data: merged.data, updated_at: res.updated_at };
          lastPush = Date.now(); lastError = null;
          log(appKey, 'push-ok', sent.join(', '));
          applyLocal(merged.data, merged.base, 'push');
          return;
        }
        log(appKey, 'push-gave-up', 'conflicted 4 times');
      } catch (e) { lastError = errText(e); log(appKey, 'push-error', lastError); /* offline — retried on the next change / reconnect */ }
      finally {
        pushing = false;
        if (pushAgain) { pushAgain = false; schedulePush(); }
      }
    }
    function schedulePush() {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => { pushTimer = null; pushNow(); }, 250);
    }
    // The page is going away: no time for read-merge-write, so send our merge
    // on top of the last row we saw (kept current by realtime).
    function flushOnUnload() {
      if (!supa || !pulled || !remote) return;
      const merged = merge(remote.data, remote.updated_at);
      if (!merged.localWins || sameRow(merged.data, remote.data)) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + (window.EFIAuth ? window.EFIAuth.accessToken() : SUPABASE_KEY),
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: merged.data, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        log(appKey, 'flush', 'page closing, sent unsaved edits');
        remote = { data: merged.data, updated_at: null }; // next push re-reads first
      } catch (e) {}
    }
    async function start() {
      // Signed-in session first — the database only answers the owner.
      const t0 = Date.now();
      if (window.EFIAuth) await window.EFIAuth.whenReady();
      const tAuth = Date.now();
      async function pull() {
        for (let attempt = 0; attempt < 4 && !pulled; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
          try {
            const { data, error } = await supa.from('app_state').select('data, updated_at').eq('key', appKey).maybeSingle();
            if (error) { lastError = errText(error); log(appKey, 'pull-error', lastError); continue; }
            pulled = true;
            log(appKey, 'pulled', 'sign-in ' + (tAuth - t0) + 'ms, pull ' + (Date.now() - tAuth) + 'ms' + (data ? '' : ', no cloud row yet'));
            receive(data, 'pull');
          } catch (e) { lastError = errText(e); log(appKey, 'pull-error', lastError); }
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
          if (!payload.new || !payload.new.data || !pulled) return;
          if (remote && sameRow(payload.new.data, remote.data)) { remote.updated_at = payload.new.updated_at || remote.updated_at; return; } // our own echo
          receive(payload.new, 'realtime (another device or page)');
        })
        .subscribe();
    }

    return { appKey, matches, changed, schedulePush, flushOnUnload, listeners, ready, start, resolveReady,
      status: () => ({ pulled, lastPush, lastError, pending: !!pushTimer }),
      _merge: merge, _receive: receive, _push: pushNow, _state: () => ({ pulled, remote }) };
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
        log(appKey, 'start', 'build ' + BUILD);
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

  // Read-only fetch of any row without subscribing to it.
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

  // ---------- read-only rows written by the server ----------
  // opts.normalize(row) → value (row = { data, updated_at })
  // opts.cacheKey       → efi_local:… key for an offline copy (never synced)
  // opts.toCache(value) → what to store there (default: the value)
  // opts.fromCache(v)   → validate a cached copy (default: identity)
  // opts.onValue(value) → side effect whenever a new value arrives
  // Several widgets on one page ask at once — they share one request, and
  // the answer is reused for a minute.
  function reader(rowKey, opts) {
    const CACHE_MS = 60 * 1000;
    let cached = null, cachedAt = 0, inflight = null;
    const client = () => {
      if (!enabled) return null;
      if (!supa) supa = sharedClient();
      return supa;
    };
    function readCache() {
      if (!opts.cacheKey) return null;
      try {
        const v = JSON.parse(localStorage.getItem(opts.cacheKey) || 'null');
        return v == null ? null : (opts.fromCache ? opts.fromCache(v) : v);
      } catch (e) { return null; }
    }
    function remember(value) {
      cached = value; cachedAt = Date.now();
      if (opts.cacheKey) { try { localStorage.setItem(opts.cacheKey, JSON.stringify(opts.toCache ? opts.toCache(value) : value)); } catch (e) { /* quota — the live copy still works */ } }
      if (opts.onValue) { try { opts.onValue(value); } catch (e) {} }
      return value;
    }
    async function get(force) {
      if (!force && cached && Date.now() - cachedAt < CACHE_MS) return cached;
      if (inflight) return inflight;
      const c = client();
      if (!c) { cached = readCache(); cachedAt = Date.now(); if (cached && opts.onValue) opts.onValue(cached); return cached; }
      inflight = (async () => {
        try {
          if (window.EFIAuth) await window.EFIAuth.whenReady();
          const { data, error } = await c.from('app_state').select('data, updated_at').eq('key', rowKey).maybeSingle();
          if (error) return cached || readCache();
          if (!data || !data.data) return null;
          return remember(opts.normalize(data));
        } catch (e) { return cached || readCache(); } finally { inflight = null; }
      })();
      return inflight;
    }
    function subscribe(cb) {
      const c = client();
      if (!c) return function () {};
      let ch = null, stopped = false;
      const start = () => {
        if (stopped) return;
        ch = c.channel('app_state_' + rowKey + '_' + Math.random().toString(36).slice(2, 7))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + rowKey }, (payload) => {
            if (!payload.new || !payload.new.data) return;
            cb(remember(opts.normalize(payload.new)));
          })
          .subscribe();
      };
      // Subscribe only once signed in, so realtime runs with the owner's token.
      if (window.EFIAuth) window.EFIAuth.whenReady().then(start); else start();
      return function () { stopped = true; try { if (ch) c.removeChannel(ch); } catch (e) {} };
    }
    return { get, subscribe, cached: () => cached || readCache(), online: () => !!client() };
  }

  window.CloudSync = {
    ROWS, enabled, init, ready, fetchRow, reader, BUILD,
    log() { try { return JSON.parse(localStorage.getItem(LOG_LS) || '[]'); } catch (e) { return []; } },
    status(appKey) { return rows[appKey] ? rows[appKey].status() : null; },
    initAll(opts) { return Promise.all(Object.keys(ROWS).map((k) => init(k, opts))); },
    _rows: rows,
  };

  // Legacy entry point — older pages call this with an inline config.
  window.initCloudSync = function (config) {
    if (!config || !config.appKey) return Promise.resolve();
    return init(config.appKey, config);
  };
})();
