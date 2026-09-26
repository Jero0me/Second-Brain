// ============================================================
// POST /api/health-import
// Authorization: Bearer <HEALTH_IMPORT_SECRET>
// Body: the raw JSON payload from the "Health Auto Export" iOS
// app's REST API automation (https://www.healthyapps.dev).
//
// Parses the metrics/sleep it sends, normalizes them, and stores
// the latest snapshot in Supabase (public.app_state, key
// 'apple_health') — the same table/pattern the rest of the
// dashboard already uses for cross-device sync.
//
// Also keeps:
//   latest.caffeine — individual "Dietary Caffeine" samples from the
//     last 48 h as [{mg, ts}] (any app that writes caffeine to Apple
//     Health) so the energy model tracks caffeine with no manual logging.
//   history — one summary per day for the last 30 days, so E.F.I. can
//     answer "how did I sleep this week?".
//
// Env vars required on Vercel:
//   HEALTH_IMPORT_SECRET  — shared secret, also set as a custom
//                           header value in the Health Auto Export
//                           REST API automation config.
//   SUPABASE_URL                — already used by /api/config.
//   SUPABASE_SERVICE_ROLE_KEY   — server-only; needed once app_state is
//                                 locked to the owner (SETUP.md §2).
// ============================================================

// "2026-09-24 08:15:00 +0200" → epoch ms (tolerates ISO too)
function parseTs(str) {
  if (typeof str !== 'string' || !str) return null;
  const s = str.trim().replace(' ', 'T').replace(/\s*([+-]\d{2})(\d{2})$/, '$1:$2');
  let t = Date.parse(s);
  if (isNaN(t)) t = Date.parse(str);
  return isNaN(t) ? null : t;
}
// The phone's own local calendar day for a sample (first 10 chars of its date).
function localDay(v) { return v && typeof v.date === 'string' ? v.date.slice(0, 10) : null; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const secret = process.env.HEALTH_IMPORT_SECRET;
  if (!secret) return res.status(500).json({ error: 'server not configured (missing HEALTH_IMPORT_SECRET)' });

  const auth = req.headers.authorization || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (given !== secret) return res.status(401).json({ error: 'unauthorized' });

  const supabaseUrl = process.env.SUPABASE_URL;
  // The database only lets the signed-in owner read/write app_state, and this
  // webhook has no user — so it writes with the service-role key. That key
  // lives only in Vercel's server env; it is never sent to the browser.
  // (Falls back to the anon key for setups that haven't locked the table yet.)
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'server not configured (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' });
  const sbHeaders = { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey, 'Content-Type': 'application/json' };

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const metrics = (body && body.data && body.data.metrics) || [];
  if (!Array.isArray(metrics)) return res.status(400).json({ error: 'no metrics in payload' });

  function byName(...names) {
    for (const name of names) {
      const m = metrics.find((x) => x && typeof x.name === 'string' && x.name.toLowerCase() === name);
      if (m) return m;
    }
    return null;
  }
  function samples(...names) { const m = byName(...names); return m && Array.isArray(m.data) ? m.data : []; }

  // The newest calendar day present in the payload. Automations often send
  // several days at once — summing every sample used to report e.g. a whole
  // week of steps/calories as "today".
  let newestDay = null;
  metrics.forEach((m) => (Array.isArray(m && m.data) ? m.data : []).forEach((v) => {
    const d = localDay(v);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && (!newestDay || d > newestDay) && (m.name || '').toLowerCase() !== 'sleep_analysis') newestDay = d;
  }));

  function lastQty(...names) {
    const data = samples(...names);
    if (!data.length) return null;
    const v = data[data.length - 1];
    const n = v && (v.qty != null ? v.qty : v.avg);
    return typeof n === 'number' ? n : null;
  }
  function sumDay(day, ...names) {
    const data = samples(...names);
    let total = 0, any = false;
    for (const v of data) {
      if (typeof v.qty !== 'number') continue;
      const d = localDay(v);
      if (day && d && d !== day) continue;
      total += v.qty; any = true;
    }
    return any ? total : null;
  }

  let spo2 = lastQty('blood_oxygen_saturation');
  if (spo2 != null && spo2 <= 1) spo2 = spo2 * 100; // some exports send a 0-1 fraction

  // ---- water + body composition (only if something writes them to Health) ----
  const waterMetric = byName('dietary_water', 'water');
  const waterUnits = String((waterMetric && waterMetric.units) || 'mL').toLowerCase();
  const waterMult = /^l$/.test(waterUnits) ? 1000 : /oz/.test(waterUnits) ? 29.5735 : 1;
  const waterDay = sumDay(newestDay, 'dietary_water', 'water');
  const massMetric = byName('body_mass', 'weight_body_mass');
  const massRaw = lastQty('body_mass', 'weight_body_mass');
  const bodyMassKg = massRaw == null ? null : /lb/i.test(String((massMetric && massMetric.units) || '')) ? massRaw * 0.453592 : massRaw;
  let bodyFatPct = lastQty('body_fat_percentage');
  if (bodyFatPct != null && bodyFatPct <= 1) bodyFatPct = bodyFatPct * 100;

  let sleep = null;
  const sleepMetric = byName('sleep_analysis');
  const sleepData = sleepMetric && Array.isArray(sleepMetric.data) ? sleepMetric.data : [];
  if (sleepData.length) {
    const s = sleepData[sleepData.length - 1];
    // Some exports report sleep_analysis in hours instead of minutes — normalize using the metric's own units.
    const unitsLc = ((sleepMetric && sleepMetric.units) || '').toLowerCase();
    const mult = (unitsLc.indexOf('hr') === 0 || unitsLc.indexOf('hour') === 0) ? 60 : 1;
    const num = (v) => (typeof v === 'number' ? v * mult : null);
    const coreMin = num(s.core), deepMin = num(s.deep), remMin = num(s.rem), inBedMin = num(s.inBed);
    // Prefer the explicit total; fall back to summing the stages (some exports omit/zero the total).
    let asleepMin = num(s.asleep != null ? s.asleep : s.totalSleep);
    if (!asleepMin) {
      const stageSum = (coreMin || 0) + (deepMin || 0) + (remMin || 0);
      if (stageSum > 0) asleepMin = stageSum;
    }
    sleep = {
      asleepMin: asleepMin != null ? asleepMin : null,
      coreMin, deepMin, remMin, inBedMin,
      awakeMin: (inBedMin != null && asleepMin != null) ? Math.max(0, inBedMin - asleepMin) : null,
      // Not every Health Auto Export version fills sleepStart/sleepEnd; fall back
      // to the in-bed window so the energy model gets real wake/bed times.
      sleepStart: s.sleepStart || s.inBedStart || s.startDate || null,
      sleepEnd: s.sleepEnd || s.inBedEnd || s.endDate || null,
    };
  }

  // ---- caffeine samples (mg, timestamped) ----
  const cafMetric = byName('dietary_caffeine', 'caffeine');
  const cafMult = cafMetric && /^g$/i.test(String(cafMetric.units || '').trim()) ? 1000 : 1;
  const incomingCaf = (cafMetric && Array.isArray(cafMetric.data) ? cafMetric.data : [])
    .map((v) => ({ mg: typeof v.qty === 'number' ? Math.round(v.qty * cafMult) : 0, ts: parseTs(v.date) }))
    .filter((x) => x.mg > 0 && x.ts);

  // Read the existing row so caffeine samples and daily history accumulate
  // across syncs instead of being replaced by whatever this payload holds.
  let previous = {};
  try {
    const r = await fetch(supabaseUrl + '/rest/v1/app_state?key=eq.apple_health&select=data', { headers: sbHeaders });
    if (r.ok) { const rows = await r.json(); previous = (rows && rows[0] && rows[0].data) || {}; }
  } catch (e) { /* first sync or transient — fine */ }

  const newestTs = Math.max(Date.now(), ...incomingCaf.map((x) => x.ts));
  const cafMap = new Map();
  [...((previous.latest && previous.latest.caffeine) || []), ...incomingCaf].forEach((x) => {
    if (x && x.ts && newestTs - x.ts <= 48 * 3600 * 1000) cafMap.set(x.ts + ':' + x.mg, x);
  });
  const caffeine = Array.from(cafMap.values()).sort((a, b) => a.ts - b.ts);

  const latest = {
    day: newestDay,
    hrv: lastQty('heart_rate_variability'),
    rhr: lastQty('resting_heart_rate'),
    resp: lastQty('respiratory_rate'),
    spo2,
    activeKcal: sumDay(newestDay, 'active_energy'),
    steps: sumDay(newestDay, 'step_count'),
    exerciseMin: sumDay(newestDay, 'apple_exercise_time'),
    sleep,
    waterMl: waterDay != null ? Math.round(waterDay * waterMult) : null,
    bodyMassKg: bodyMassKg != null ? Math.round(bodyMassKg * 10) / 10 : null,
    bodyFatPct: bodyFatPct != null ? Math.round(bodyFatPct * 10) / 10 : null,
    // Written to Apple Health by MyFitnessPal (HealthKit sharing) when you
    // log food there — field names are best-effort HealthKit identifiers;
    // check the `debug` fingerprint below on first sync to confirm/adjust.
    nutrition: {
      calories: sumDay(newestDay, 'dietary_energy'),
      proteinG: sumDay(newestDay, 'protein'),
      carbsG: sumDay(newestDay, 'carbohydrates'),
      fatG: sumDay(newestDay, 'total_fat'),
      fiberG: sumDay(newestDay, 'fiber'),
      sugarG: sumDay(newestDay, 'dietary_sugar', 'sugar'),
      sodiumMg: sumDay(newestDay, 'sodium'),
    },
    caffeine,
  };

  // ---- 30-day history (one row per day, newest data wins) ----
  const hist = new Map((Array.isArray(previous.history) ? previous.history : []).map((h) => [h.date, h]));
  if (newestDay) {
    const cafToday = sumDay(newestDay, 'dietary_caffeine', 'caffeine');
    const prevDay = hist.get(newestDay) || {};
    hist.set(newestDay, Object.assign({}, prevDay, {
      date: newestDay,
      sleepMin: sleep && sleep.asleepMin != null ? Math.round(sleep.asleepMin) : (prevDay.sleepMin != null ? prevDay.sleepMin : null),
      hrv: latest.hrv != null ? Math.round(latest.hrv) : null,
      rhr: latest.rhr != null ? Math.round(latest.rhr) : null,
      steps: latest.steps != null ? Math.round(latest.steps) : null,
      activeKcal: latest.activeKcal != null ? Math.round(latest.activeKcal) : null,
      calories: latest.nutrition.calories != null ? Math.round(latest.nutrition.calories) : null,
      caffeineMg: cafToday != null ? Math.round(cafToday * cafMult) : null,
      // vitals the Health body view trends over the last week
      spo2: spo2 != null ? Math.round(spo2 * 10) / 10 : null,
      resp: latest.resp != null ? Math.round(latest.resp * 10) / 10 : null,
      exerciseMin: latest.exerciseMin != null ? Math.round(latest.exerciseMin) : null,
      waterMl: latest.waterMl,
      bodyMassKg: latest.bodyMassKg != null ? latest.bodyMassKg : (prevDay.bodyMassKg != null ? prevDay.bodyMassKg : null),
    }));
  }
  const history = Array.from(hist.values()).filter((h) => h && h.date).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-30);

  const debug = metrics.map((m) => ({
    name: m && m.name,
    units: m && m.units,
    count: (m && Array.isArray(m.data)) ? m.data.length : 0,
  }));

  try {
    const r = await fetch(supabaseUrl + '/rest/v1/app_state?on_conflict=key', {
      method: 'POST',
      headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, sbHeaders),
      body: JSON.stringify({
        key: 'apple_health',
        data: { latest, history, debug },
        updated_at: new Date().toISOString(),
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      const hint = /row-level security|42501/i.test(text) && !process.env.SUPABASE_SERVICE_ROLE_KEY
        ? ' — the table is locked to the owner; set SUPABASE_SERVICE_ROLE_KEY in Vercel (SETUP.md §2).' : '';
      return res.status(500).json({ error: 'supabase write failed: ' + text + hint });
    }
    return res.status(200).json({ ok: true, day: newestDay, caffeineSamples: caffeine.length, latest });
  } catch (e) {
    return res.status(500).json({ error: 'unexpected error: ' + (e && e.message ? e.message : String(e)) });
  }
}
