// ============================================================
// POST /api/hevy-sync
// Pulls your workouts (and body-weight entries) from the Hevy API and
// stores a compact copy in Supabase (public.app_state, key 'hevy') —
// the same row pattern as the Apple Health import. The Fitness page,
// Health page and E.F.I. read that row; the Hevy API key never leaves
// the server.
//
// Who may call it:
//   - the signed-in owner (the Fitness page sends its Supabase access
//     token when it opens or you tap refresh), or
//   - anything holding HEVY_SYNC_SECRET as `Authorization: Bearer …`
//     (optional — for a webhook or an external scheduler).
// The response only says how many workouts are stored, never the data.
//
// First run pulls up to ~a year of workouts; after that it asks Hevy
// only for what changed since the last sync (/v1/workouts/events).
// Body `{ "full": true }` forces a full re-pull.
//
// Env vars on Vercel:
//   HEVY_API_KEY               — from https://hevy.com/settings?developer (Hevy Pro)
//   HEVY_SYNC_SECRET           — optional, see above
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY — already set
// ============================================================

const HEVY = 'https://api.hevyapp.com';
const ROW_KEY = 'hevy';
const KEEP_DAYS = 400;        // workouts older than this are dropped
const MAX_WORKOUTS = 500;
const MAX_FULL_PAGES = 40;    // 10 workouts per page (Hevy's max)
const MAX_TEMPLATE_FETCH = 80; // new exercise templates looked up per run

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const apiKey = process.env.HEVY_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'not configured', code: 'no_key' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY || serviceKey;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'server not configured (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' });

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !(await allowed(token, supabaseUrl, anonKey))) return res.status(401).json({ error: 'unauthorized' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const sb = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };
  const hevy = (path) => fetch(HEVY + path, { headers: { 'api-key': apiKey, accept: 'application/json' } }).then(async (r) => {
    if (!r.ok) { const e = new Error('Hevy ' + r.status + ' on ' + path.split('?')[0]); e.status = r.status; throw e; }
    return r.json();
  });

  let prev = {};
  try {
    const r = await fetch(supabaseUrl + '/rest/v1/app_state?key=eq.' + ROW_KEY + '&select=data', { headers: sb });
    if (r.ok) { const rows = await r.json(); prev = (rows && rows[0] && rows[0].data) || {}; }
  } catch (e) { /* first sync */ }

  const started = new Date().toISOString();
  const byId = new Map((Array.isArray(prev.workouts) ? prev.workouts : []).map((w) => [w.id, w]));
  let mode = 'incremental';

  try {
    if (body.full || !prev.syncedAt || !byId.size) {
      mode = 'full';
      byId.clear();
      const first = await hevy('/v1/workouts?page=1&pageSize=10');
      (first.workouts || []).forEach((w) => byId.set(w.id, compact(w)));
      const pages = Math.min(first.page_count || 1, MAX_FULL_PAGES);
      const cutoff = Date.now() - KEEP_DAYS * 864e5;
      // Newest first — fetch a few pages at a time and stop once past the cutoff.
      for (let p = 2; p <= pages; p += 5) {
        const batch = [];
        for (let q = p; q < p + 5 && q <= pages; q++) batch.push(hevy('/v1/workouts?page=' + q + '&pageSize=10'));
        const results = await Promise.all(batch);
        let old = false;
        results.forEach((r) => (r.workouts || []).forEach((w) => {
          byId.set(w.id, compact(w));
          if (Date.parse(w.start_time) < cutoff) old = true;
        }));
        if (old) break;
      }
    } else {
      // Ask for events a little before the last sync so nothing slips between runs.
      const since = new Date(Date.parse(prev.syncedAt) - 10 * 60000).toISOString();
      for (let p = 1, pages = 1; p <= pages && p <= 30; p++) {
        const r = await hevy('/v1/workouts/events?page=' + p + '&pageSize=10&since=' + encodeURIComponent(since));
        pages = r.page_count || 1;
        (r.events || []).forEach((ev) => {
          if (ev.type === 'deleted' && ev.id) byId.delete(ev.id);
          else if (ev.workout && ev.workout.id) byId.set(ev.workout.id, compact(ev.workout));
        });
      }
    }
  } catch (e) {
    const msg = e.status === 401 || e.status === 403 ? 'Hevy rejected the API key (it needs Hevy Pro — check HEVY_API_KEY)' : (e.message || String(e));
    await save(Object.assign({}, prev, { error: msg, errorAt: started }));
    return res.status(502).json({ error: msg });
  }

  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const workouts = Array.from(byId.values())
    .filter((w) => w && w.start && Date.parse(w.start) >= cutoff)
    .sort((a, b) => (a.start < b.start ? 1 : -1))
    .slice(0, MAX_WORKOUTS);

  // Muscle groups for the exercises you actually do (looked up once each).
  const templates = Object.assign({}, prev.templates || {});
  const missing = [...new Set(workouts.flatMap((w) => w.exercises.map((x) => x.tid)).filter((id) => id && !templates[id]))].slice(0, MAX_TEMPLATE_FETCH);
  for (let i = 0; i < missing.length; i += 10) {
    await Promise.all(missing.slice(i, i + 10).map(async (id) => {
      try {
        const t = await hevy('/v1/exercise_templates/' + encodeURIComponent(id));
        const tpl = t && (t.exercise_template || t);
        if (tpl && tpl.id) templates[id] = { muscle: tpl.primary_muscle_group || 'other', secondary: tpl.secondary_muscle_groups || [], type: tpl.type || null };
      } catch (e) { /* try again next run */ }
    }));
  }

  // Body weight logged in Hevy (Profile → Measurements) — first page is plenty.
  let body_ = Array.isArray(prev.body) ? prev.body : [];
  try {
    const r = await hevy('/v1/body_measurements?page=1&pageSize=10');
    const map = new Map(body_.map((b) => [b.date, b]));
    (r.body_measurements || []).forEach((m) => {
      if (m && m.date && (m.weight_kg != null || m.fat_percent != null)) map.set(m.date, { date: m.date, kg: m.weight_kg != null ? m.weight_kg : null, fatPct: m.fat_percent != null ? m.fat_percent : null });
    });
    body_ = Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-120);
  } catch (e) { /* optional endpoint */ }

  const data = { workouts, templates, body: body_, syncedAt: started, mode, error: null };
  const ok = await save(data);
  if (!ok.ok) return res.status(500).json({ error: 'supabase write failed: ' + ok.text });
  return res.status(200).json({ ok: true, mode, workouts: workouts.length, newest: workouts[0] ? workouts[0].start : null });

  async function save(d) {
    const r = await fetch(supabaseUrl + '/rest/v1/app_state?on_conflict=key', {
      method: 'POST',
      headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, sb),
      body: JSON.stringify({ key: ROW_KEY, data: d, updated_at: new Date().toISOString() }),
    });
    return { ok: r.ok, text: r.ok ? '' : await r.text() };
  }
}

// Shared secret, or a Supabase session belonging to the dashboard owner.
async function allowed(token, supabaseUrl, anonKey) {
  const secret = process.env.HEVY_SYNC_SECRET;
  if (secret && token === secret) return true;
  if (token.split('.').length !== 3) return false; // not a JWT
  const h = { apikey: anonKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    const u = await fetch(supabaseUrl + '/auth/v1/user', { headers: h });
    if (!u.ok) return false;
    const r = await fetch(supabaseUrl + '/rest/v1/rpc/is_app_owner', { method: 'POST', headers: h, body: '{}' });
    if (r.ok) return (await r.json()) === true;
    return r.status === 404; // ownership SQL not run yet — any signed-in user of this project
  } catch (e) { return false; }
}

// Hevy workout → the small shape stored in app_state.
function compact(w) {
  return {
    id: w.id,
    title: w.title || 'Workout',
    start: w.start_time,
    end: w.end_time || null,
    exercises: (w.exercises || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0)).map((x) => ({
      title: x.title,
      tid: x.exercise_template_id || null,
      superset: x.superset_id != null ? x.superset_id : undefined,
      sets: (x.sets || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0)).map((s) => {
        const o = { type: s.type || 'normal' };
        if (s.weight_kg != null) o.kg = s.weight_kg;
        if (s.reps != null) o.reps = s.reps;
        if (s.rpe != null) o.rpe = s.rpe;
        if (s.distance_meters != null) o.m = s.distance_meters;
        if (s.duration_seconds != null) o.sec = s.duration_seconds;
        return o;
      }),
    })),
  };
}
