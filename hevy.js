// =============================================================
// Shared reader for Hevy workouts, synced by /api/hevy-sync into
// Supabase (public.app_state, key 'hevy'). Same pattern as
// applehealth.js: the page never sees the Hevy API key.
//
//   Hevy.get(force)     → { workouts, templates, body, syncedAt, error } | null
//   Hevy.sync({ full }) → asks the server to pull new workouts from Hevy
//   Hevy.subscribe(cb)  → called when the row changes (realtime)
//   Hevy.cached()       → last copy seen on this device (sync, may be null)
//   Hevy.recent(days)   → compact summary for E.F.I. / symptom explanations
//
// Plus the lift maths the Fitness page and E.F.I. share (e1RM, volume,
// PRs, sets per muscle group).
//
// A trimmed copy is cached per device under `efi_local:hevy_cache`
// (never synced), so sync readers like EFI.data.recentTraining() and
// offline pages still have your recent training.
//
// Load after sync.js (both deferred): it provides CloudSync.reader.
// =============================================================
(function () {
  'use strict';

  const CACHE_DAYS = 120;

  function normalize(row) {
    const d = (row && row.data) || {};
    return {
      workouts: Array.isArray(d.workouts) ? d.workouts : [],
      templates: d.templates || {},
      body: Array.isArray(d.body) ? d.body : [],
      syncedAt: d.syncedAt || null,
      error: d.error || null,
      updatedAt: row && row.updated_at ? row.updated_at : null,
    };
  }

  const reader = window.CloudSync.reader('hevy', {
    cacheKey: 'efi_local:hevy_cache',
    normalize,
    // Only the recent months are kept on the device.
    toCache: (res) => {
      const cut = new Date(Date.now() - CACHE_DAYS * 864e5).toISOString();
      return Object.assign({}, res, { workouts: (res.workouts || []).filter((w) => w.start >= cut) });
    },
    fromCache: (v) => (v && Array.isArray(v.workouts) ? v : null),
  });
  const get = reader.get, subscribe = reader.subscribe;

  // Ask the server to pull from Hevy. Resolves { ok, workouts } or { ok:false, code, error }.
  async function sync(opts) {
    opts = opts || {};
    if (!reader.online()) return { ok: false, code: 'offline', error: 'Cloud sync is off on this device.' };
    try {
      if (window.EFIAuth) await window.EFIAuth.whenReady();
      const token = window.EFIAuth ? window.EFIAuth.accessToken() : '';
      const r = await fetch('/api/hevy-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ full: !!opts.full }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, code: j.code || String(r.status), error: j.error || 'Sync failed (' + r.status + ')' };
      await get(true);
      return Object.assign({ ok: true }, j);
    } catch (e) { return { ok: false, code: 'network', error: 'Could not reach the server.' }; }
  }

  // ---------- lift maths ----------
  const isWork = (s) => s && s.type !== 'warmup';
  const workSets = (ex) => (ex.sets || []).filter(isWork);
  // Epley estimate; reps past 12 say little about a max, so cap them.
  function e1rm(kg, reps) {
    if (!(kg > 0) || !(reps > 0)) return 0;
    return reps === 1 ? kg : kg * (1 + Math.min(reps, 12) / 30);
  }
  // Heaviest set by e1RM; for bodyweight/timed work, the most reps/seconds.
  function bestSet(ex) {
    let best = null, bestE = 0, bestN = -1;
    workSets(ex).forEach((s) => {
      const e = e1rm(s.kg, s.reps), n = s.reps || s.sec || 0;
      if (e > bestE || (!bestE && !e && n > bestN)) { best = s; bestE = e; bestN = n; }
    });
    return best ? { set: best, e1rm: bestE } : null;
  }
  const exVolume = (ex) => workSets(ex).reduce((a, s) => a + (s.kg > 0 && s.reps > 0 ? s.kg * s.reps : 0), 0);
  const volume = (w) => (w.exercises || []).reduce((a, ex) => a + exVolume(ex), 0);
  const setCount = (w) => (w.exercises || []).reduce((a, ex) => a + workSets(ex).length, 0);
  function durationMin(w) {
    const a = Date.parse(w.start), b = Date.parse(w.end);
    return a && b && b > a ? Math.round((b - a) / 60000) : null;
  }
  const exKey = (ex) => ex.tid || ex.title;
  function muscleOf(ex, templates) {
    const t = templates && ex.tid && templates[ex.tid];
    return (t && t.muscle) || 'other';
  }
  const MUSCLE_LABEL = {
    abdominals: 'Abs', shoulders: 'Shoulders', biceps: 'Biceps', triceps: 'Triceps', forearms: 'Forearms', quadriceps: 'Quads',
    hamstrings: 'Hamstrings', calves: 'Calves', glutes: 'Glutes', abductors: 'Abductors', adductors: 'Adductors', lats: 'Lats',
    upper_back: 'Upper back', traps: 'Traps', lower_back: 'Lower back', chest: 'Chest', cardio: 'Cardio', neck: 'Neck', full_body: 'Full body', other: 'Other',
  };
  // Working sets per primary muscle group (secondary muscles count half).
  function muscleSets(workouts, templates) {
    const out = {};
    workouts.forEach((w) => (w.exercises || []).forEach((ex) => {
      const n = workSets(ex).length; if (!n) return;
      const t = templates && ex.tid && templates[ex.tid];
      const m = (t && t.muscle) || 'other';
      out[m] = (out[m] || 0) + n;
      ((t && t.secondary) || []).forEach((s) => { out[s] = (out[s] || 0) + n / 2; });
    }));
    return out;
  }
  // exercise key → PR info for one workout, judged against every earlier workout.
  function prsIn(workout, all) {
    const before = all.filter((w) => w.start < workout.start);
    const out = {};
    (workout.exercises || []).forEach((ex) => {
      const b = bestSet(ex); if (!b || !b.e1rm) return;
      let prev = 0, seen = false;
      before.forEach((w) => (w.exercises || []).forEach((x) => { if (exKey(x) === exKey(ex)) { seen = true; const bb = bestSet(x); if (bb && bb.e1rm > prev) prev = bb.e1rm; } }));
      if (seen && b.e1rm > prev + 0.01) out[exKey(ex)] = { e1rm: b.e1rm, prev };
    });
    return out;
  }
  function localDay(iso) { const d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  const fmtSet = (s) => s ? (s.kg != null ? (+s.kg.toFixed(1)) + ' kg × ' : '') + (s.reps != null ? s.reps : s.sec != null ? Math.round(s.sec) + 's' : '') : '';

  // Compact training summary for E.F.I. (sync — uses the cache).
  function recent(days, res) {
    res = res || reader.cached();
    if (!res || !res.workouts) return [];
    const cut = new Date(Date.now() - (days || 5) * 864e5).toISOString();
    return res.workouts.filter((w) => w.start >= cut).map((w) => {
      const muscles = muscleSets([w], res.templates);
      return {
        date: localDay(w.start),
        title: w.title,
        duration_min: durationMin(w),
        muscles: Object.keys(muscles).filter((m) => muscles[m] >= 1).sort((a, b) => muscles[b] - muscles[a]).map((m) => MUSCLE_LABEL[m] || m),
        sets: setCount(w),
        volume_kg: Math.round(volume(w)),
        exercises: (w.exercises || []).map((ex) => { const b = bestSet(ex); return { name: ex.title, sets: workSets(ex).length, top_set: b ? fmtSet(b.set) : undefined }; }),
      };
    });
  }

  window.Hevy = {
    get, sync, subscribe, cached: reader.cached, recent,
    e1rm, bestSet, workSets, exVolume, volume, setCount, durationMin, exKey, muscleOf, muscleSets, prsIn, localDay, fmtSet, MUSCLE_LABEL,
  };
})();
