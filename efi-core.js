// =============================================================
// E.F.I. core — Enhanced Functional Intelligence.
// Shared by every page: storage + date helpers, the user profile,
// E.F.I. settings, and the Google Gemini client that powers every AI
// feature in the dashboard (chat, auto-schedule, polish, meal prep,
// gym coach).
//
// Load WITHOUT defer, after /api/config:
//   <script src="efi-core.js"></script>
//
// Secrets live under the `efi_local:` prefix, which sync.js never
// mirrors to Supabase — the Gemini key stays on the device it was
// pasted on.
// =============================================================
(function () {
  'use strict';
  const EFI = window.EFI = window.EFI || {};

  // ---------- storage ----------
  function get(k, fallback) {
    try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function getRaw(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function setRaw(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
  EFI.store = { get, set, del, getRaw, setRaw };

  // ---------- dates ----------
  const pad2 = (n) => String(n).padStart(2, '0');
  function dateKey(d) { d = d || new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseKey(k) { const p = String(k).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  // The planner treats 6 AM as the day boundary (a 1 AM task still belongs to "today").
  function activeDateKey() { const now = new Date(); return dateKey(now.getHours() < 6 ? addDays(now, -1) : now); }
  function tomorrowDateKey() { return dateKey(addDays(parseKey(activeDateKey()), 1)); }
  function timeToMin(hhmm) { const p = String(hhmm).split(':').map(Number); return p[0] * 60 + (p[1] || 0); }
  function minToTime(min) {
    min = Math.max(0, Math.min(24 * 60, Math.round(min)));
    if (min === 24 * 60) return '24:00';
    return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60);
  }
  function fmtTime(hhmm) {
    if (!hhmm) return '';
    const m = timeToMin(hhmm);
    const h = Math.floor(m / 60) % 24, mm = m % 60;
    const ap = h >= 12 ? 'PM' : 'AM';
    let h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + (mm ? ':' + pad2(mm) : '') + ' ' + ap;
  }
  function fmtDuration(min) {
    min = Math.round(min);
    const h = Math.floor(min / 60), m = min % 60;
    if (!h) return m + ' min';
    return h + (h === 1 ? ' hr' : ' hrs') + (m ? ' ' + m + ' min' : '');
  }
  // Month overflow-safe month add: Jan 31 + 1 month = Feb 28/29, not Mar 3.
  function addMonthsClamped(d, n, anchorDay) {
    const day = anchorDay || d.getDate();
    const x = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
    x.setDate(Math.min(day, last));
    return x;
  }
  function uid(prefix) { return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();

  EFI.date = { pad2, dateKey, parseKey, addDays, activeDateKey, tomorrowDateKey, timeToMin, minToTime, fmtTime, fmtDuration, addMonthsClamped, uid, tz };

  // ---------- settings (synced — no secrets in here) ----------
  const SETTINGS_KEY = 'efi:settings';
  const SETTINGS_DEFAULTS = { userName: 'Jerome', geminiModel: '', voice: false, googleCalendars: null };
  EFI.settings = {
    get() { return Object.assign({}, SETTINGS_DEFAULTS, get(SETTINGS_KEY, {})); },
    set(patch) { const next = Object.assign({}, this.get(), patch); set(SETTINGS_KEY, next); return next; },
  };

  // ---------- user profile ----------
  // Used to live inside the (now removed) water tracker's po_water_v1 blob.
  // Migrated once into its own synced key.
  const PROFILE_KEY = 'profile:v1';
  EFI.profile = {
    get() {
      let p = get(PROFILE_KEY, null);
      if (!p) {
        const legacy = get('po_water_v1', null);
        p = Object.assign({ weightUnit: 'kg' }, legacy && legacy.profile ? legacy.profile : {});
        if (legacy && legacy.weightUnit) p.weightUnit = legacy.weightUnit;
        if (legacy && legacy.profile) set(PROFILE_KEY, p);
      }
      return p;
    },
    set(patch) { const next = Object.assign({}, this.get(), patch); set(PROFILE_KEY, next); return next; },
  };

  // =============================================================
  // Gemini client
  // =============================================================
  const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const KEY_LS = 'efi_local:gemini_key';
  const AUTO_MODEL_LS = 'efi_local:gemini_auto_model';
  const FALLBACK_MODEL = 'gemini-2.5-flash';

  function apiKey() { return getRaw(KEY_LS).trim(); }

  class AIError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }

  async function listModels(keyOverride) {
    const key = keyOverride || apiKey();
    if (!key) throw new AIError('No Gemini API key set.', 'no-key');
    const res = await fetch(GEMINI_BASE + '/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new AIError((json.error && json.error.message) || ('HTTP ' + res.status), res.status === 400 || res.status === 403 ? 'bad-key' : 'http');
    return (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1)
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((n) => /^gemini-/.test(n) && !/(embedding|image|tts|audio|live|vision|aqa|robotics|computer-use)/i.test(n));
  }

  // Model list, cached for 12 h so fallbacks don't cost an extra request.
  const MODELS_LS = 'efi_local:gemini_models';
  async function cachedModels() {
    const c = get(MODELS_LS, null);
    if (c && Array.isArray(c.names) && Date.now() - c.ts < 12 * 3600 * 1000) return c.names;
    const names = await listModels();
    set(MODELS_LS, { ts: Date.now(), names });
    return names;
  }

  // Ranking: STABLE models first (preview/experimental models are the ones
  // that most often answer "model is overloaded / high demand"), then newest
  // version, then Flash > Pro > Flash-Lite.
  function version(n) { const m = n.match(/^gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; }
  function isPreview(n) { return /preview|exp/.test(n); }
  function score(n) {
    let s = version(n) * 100;
    if (/-flash(?!-lite)/.test(n)) s += 30;
    else if (/-pro/.test(n)) s += 20;
    else if (/-flash-lite/.test(n)) s += 5;
    if (/latest/.test(n)) s += 3;
    if (/\d{3,}$|-\d{2}-\d{2}/.test(n)) s -= 2; // dated snapshots
    if (isPreview(n)) s -= 1000;
    return s;
  }
  function rank(names) { return names.slice().sort((a, b) => score(b) - score(a)); }
  function pickDefault(names) { return rank(names)[0] || null; }

  async function resolveModel() {
    const chosen = EFI.settings.get().geminiModel;
    if (chosen) return chosen;
    const cached = getRaw(AUTO_MODEL_LS);
    // Older versions could auto-pick a preview model; re-pick a stable one.
    if (cached && !isPreview(cached)) return cached;
    try {
      const pick = pickDefault(await cachedModels());
      if (pick) { setRaw(AUTO_MODEL_LS, pick); return pick; }
    } catch (e) { if (e.code === 'no-key' || e.code === 'bad-key') throw e; }
    return FALLBACK_MODEL;
  }

  // Models to try, in order: the chosen/auto model first, then the best
  // alternatives (at most 4 in total).
  async function candidates(first) {
    let names = [];
    try { names = await cachedModels(); } catch (e) { names = []; }
    const out = [first];
    rank(names).forEach((n) => { if (out.indexOf(n) === -1) out.push(n); });
    if (out.indexOf(FALLBACK_MODEL) === -1) out.push(FALLBACK_MODEL);
    return out.slice(0, 4);
  }

  // "Overloaded", "high demand", quota and 5xx errors are temporary and
  // model-specific — worth retrying and then trying another model.
  function transient(status, msg) {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 ||
      /overloaded|high demand|high usage|try again later|unavailable|resource.?exhausted/i.test(msg || '');
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Low-level call with automatic retry + model fallback.
  // `contents` is Gemini's native [{role, parts}] array.
  // opts.pinModel: only use opts.model (still retried) — used mid tool-loop,
  // where switching models could invalidate Gemini's thought signatures.
  async function generate(opts) {
    const key = apiKey();
    if (!key) throw new AIError('Add your Gemini API key in E.F.I. settings first.', 'no-key');
    const first = opts.model || await resolveModel();
    const models = opts.pinModel ? [first] : await candidates(first);
    const tried = [];
    let lastErr = null;
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await sleep(1200 + Math.random() * 800);
        try {
          const r = await generateOnce(key, model, opts);
          // Auto mode: remember the model that actually works right now.
          if (model !== first && !EFI.settings.get().geminiModel) setRaw(AUTO_MODEL_LS, model);
          return r;
        } catch (e) {
          lastErr = e;
          if (e && e.name === 'AbortError') throw e;
          if (e.code === 'bad-key' || e.code === 'network' || e.code === 'empty') throw e;
          if (e.code === 'gone') { if (!EFI.settings.get().geminiModel) setRaw(AUTO_MODEL_LS, ''); break; }
          if (e.code !== 'busy') throw e;
          if (e.quota) break; // daily/minute quota for this model — go straight to the next model
        }
      }
      tried.push(model);
    }
    if (lastErr && lastErr.code === 'busy') {
      throw new AIError('Gemini is overloaded right now (tried ' + tried.join(', ') + '). Give it a minute and try again.', 'busy');
    }
    throw lastErr || new AIError('Gemini did not answer.', 'http');
  }

  async function generateOnce(key, model, opts) {
    const body = { contents: opts.contents, generationConfig: { maxOutputTokens: opts.maxTokens || 8192 } };
    if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
    if (opts.json) body.generationConfig.responseMimeType = 'application/json';
    if (opts.temperature != null) body.generationConfig.temperature = opts.temperature;
    if (opts.tools && opts.tools.length) {
      body.tools = [{ functionDeclarations: opts.tools }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    let res, json;
    try {
      res = await fetch(GEMINI_BASE + '/models/' + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      json = await res.json().catch(() => ({}));
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new AIError('Could not reach Gemini — check your connection.', 'network');
    }
    if (!res.ok) {
      const msg = (json.error && json.error.message) || ('HTTP ' + res.status);
      if (res.status === 404) throw new AIError('Model ' + model + ' is not available.', 'gone');
      if ((res.status === 400 || res.status === 403) && /api key|permission/i.test(msg)) throw new AIError('Gemini rejected the API key — check it in settings.', 'bad-key');
      if (transient(res.status, msg)) {
        const err = new AIError('Gemini is busy: ' + msg, 'busy');
        err.quota = res.status === 429 && /quota/i.test(msg);
        throw err;
      }
      throw new AIError('Gemini error: ' + msg, 'http');
    }
    const cand = (json.candidates || [])[0];
    if (!cand || !cand.content) {
      const reason = (json.promptFeedback && json.promptFeedback.blockReason) || (cand && cand.finishReason) || 'empty response';
      throw new AIError('Gemini returned no answer (' + reason + ').', 'empty');
    }
    const parts = cand.content.parts || [];
    const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    return { content: cand.content, text, calls, finishReason: cand.finishReason, model };
  }

  function stripFences(t) { return String(t || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim(); }

  // Accepts a string, an array of Gemini parts, or the older text/image
  // content-block shape some pages were written against
  // ({type:'text',text} / {type:'image',source:{media_type,data}}).
  function toParts(input) {
    if (typeof input === 'string') return [{ text: input }];
    return (input || []).map((b) => {
      if (!b) return null;
      if (b.text != null && !b.type) return b;
      if (b.inlineData) return b;
      if (b.type === 'text') return { text: b.text };
      if (b.type === 'image' && b.source) return { inlineData: { mimeType: b.source.media_type, data: b.source.data } };
      return null;
    }).filter(Boolean);
  }

  async function askText(input, opts) {
    opts = opts || {};
    const r = await generate(Object.assign({}, opts, { contents: [{ role: 'user', parts: toParts(input) }] }));
    return r.text.trim();
  }
  async function askJSON(input, opts) {
    opts = opts || {};
    const r = await generate(Object.assign({}, opts, { json: true, contents: [{ role: 'user', parts: toParts(input) }] }));
    try { return JSON.parse(stripFences(r.text)); }
    catch (e) { throw new AIError('Gemini returned malformed JSON — try again.', 'json'); }
  }

  // =============================================================
  // Line icons (24px grid, stroke-based) shared by the nav, calendar
  // and assistant: EFI.icon('calendar', 18)
  // =============================================================
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
    calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    dumbbell: '<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.8a3.3 3.3 0 0 1 0 6.4M18 14.8c2 .7 3.2 2.4 3.5 5.2"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18"/>',
    book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v14H6.5A1.5 1.5 0 0 0 5 18.5z"/><path d="M5 18.5A1.5 1.5 0 0 0 6.5 20H19v-3"/>',
    utensils: '<path d="M7 3v8M4.5 3v5a2.5 2.5 0 0 0 5 0V3M7 11v10"/><path d="M17 21V3c-2.2 1.2-3.5 3.6-3.5 7v3H17"/>',
    coffee: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10.5h1.5a2.5 2.5 0 0 1 0 5H17M8 3.5V6M12 3.5V6"/>',
    cart: '<circle cx="9" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/><path d="M2.5 3.5h3l2.4 11.5h11l2-8H6.6"/>',
    plane: '<path d="M10.5 13.5 3 11l1.5-1.5 7.5.5 4.5-5a2.1 2.1 0 0 1 3 3l-5 4.5.5 7.5L13.5 21 11 13.5"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
    gift: '<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5 12v8.5h14V12M12 8v12.5M12 8c-1-3-5-4-5-1.5S10.5 8 12 8zm0 0c1-3 5-4 5-1.5S13.5 8 12 8z"/>',
    card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>',
    package: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.3l8 4.5"/>',
    pen: '<path d="M4 20h4L19.5 8.5a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    repeat: '<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13M7 21.5 3.5 18 7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    send: '<path d="M21 3 10.5 13.5"/><path d="M21 3 14.5 21l-4-7.5L3 9.5z"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    chevronLeft: '<path d="m14.5 5-7 7 7 7"/>',
    chevronRight: '<path d="m9.5 5 7 7-7 7"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    sparkle: '<path d="M12 3c.6 4.3 2.7 6.4 7 7-4.3.6-6.4 2.7-7 7-.6-4.3-2.7-6.4-7-7 4.3-.6 6.4-2.7 7-7z"/>',
    wallet: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h12A1.5 1.5 0 0 1 19 5.5V7"/><path d="M3 6.5v11A2.5 2.5 0 0 0 5.5 20h14a1.5 1.5 0 0 0 1.5-1.5v-10A1.5 1.5 0 0 0 19.5 7H5.5A2.5 2.5 0 0 1 3 6.5z"/><circle cx="16.5" cy="13.5" r="1.2"/>',
    pill: '<path d="M10.5 20.5a5 5 0 0 1-7-7l7-7a5 5 0 0 1 7 7z"/><path d="m7 10 7 7"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
    bolt: '<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13"/>',
    pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    note: '<path d="M6 3h8.5L19 7.5V21H6z"/><path d="M14 3v5h5M9 12.5h7M9 16.5h5"/>',
    chat: '<path d="M4 5.5h16v10.5H9.5L5 20v-4H4z"/>',
    volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    chef: '<path d="M7 14.5a4 4 0 0 1-1.5-7.7A5 5 0 0 1 12 3.5a5 5 0 0 1 6.5 3.3 4 4 0 0 1-1.5 7.7V20H7z"/><path d="M7 16.5h10"/>',
    refresh: '<path d="M20 5v5h-5"/><path d="M19.5 10A8 8 0 1 0 20 14"/>',
  };
  EFI.icon = function (name, size, stroke) {
    size = size || 18;
    return '<svg class="efi-ico" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (stroke || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || ICONS.star) + '</svg>';
  };
  EFI.escape = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); };

  EFI.ai = {
    AIError,
    hasKey: () => !!apiKey(),
    getKey: apiKey,
    setKey(k) { setRaw(KEY_LS, String(k || '').trim()); setRaw(AUTO_MODEL_LS, ''); },
    listModels, resolveModel, generate, askText, askJSON, toParts,
    // Human-readable message for any error thrown above.
    explain(e) { return (e && e.message) ? e.message : 'Something went wrong — try again.'; },
  };
})();
