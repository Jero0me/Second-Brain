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
// Env vars required on Vercel:
//   HEALTH_IMPORT_SECRET  — shared secret, also set as a custom
//                           header value in the Health Auto Export
//                           REST API automation config.
//   SUPABASE_URL / SUPABASE_ANON_KEY — already used by /api/config.
// ============================================================
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
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'server not configured (missing SUPABASE_URL / SUPABASE_ANON_KEY)' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const metrics = (body && body.data && body.data.metrics) || [];
  if (!Array.isArray(metrics)) return res.status(400).json({ error: 'no metrics in payload' });

  function byName(name) {
    return metrics.find((m) => m && typeof m.name === 'string' && m.name.toLowerCase() === name);
  }
  function lastQty(name) {
    const m = byName(name);
    const data = m && Array.isArray(m.data) ? m.data : [];
    if (!data.length) return null;
    const v = data[data.length - 1];
    const n = v && (v.qty != null ? v.qty : v.avg);
    return typeof n === 'number' ? n : null;
  }
  function sumQty(name) {
    const m = byName(name);
    const data = m && Array.isArray(m.data) ? m.data : [];
    if (!data.length) return null;
    let total = 0, any = false;
    for (const v of data) { if (typeof v.qty === 'number') { total += v.qty; any = true; } }
    return any ? total : null;
  }

  let spo2 = lastQty('blood_oxygen_saturation');
  if (spo2 != null && spo2 <= 1) spo2 = spo2 * 100; // some exports send a 0-1 fraction

  let sleep = null;
  const sleepMetric = byName('sleep_analysis');
  const sleepData = sleepMetric && Array.isArray(sleepMetric.data) ? sleepMetric.data : [];
  if (sleepData.length) {
    const s = sleepData[sleepData.length - 1];
    // Some exports report sleep_analysis in hours instead of minutes — normalize using the metric's own units.
    const unitsLc = ((sleepMetric && sleepMetric.units) || '').toLowerCase();
    const mult = (unitsLc.indexOf('hr') === 0 || unitsLc.indexOf('hour') === 0) ? 60 : 1;
    const num = (v) => (typeof v === 'number' ? v * mult : null);

    const coreMin = num(s.core);
    const deepMin = num(s.deep);
    const remMin = num(s.rem);
    const inBedMin = num(s.inBed);
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
      sleepStart: s.sleepStart || null,
      sleepEnd: s.sleepEnd || null,
    };
  }

  const latest = {
    hrv: lastQty('heart_rate_variability'),
    rhr: lastQty('resting_heart_rate'),
    resp: lastQty('respiratory_rate'),
    spo2,
    activeKcal: sumQty('active_energy'),
    steps: sumQty('step_count'),
    exerciseMin: sumQty('apple_exercise_time'),
    sleep,
  };

  const debug = metrics.map((m) => ({
    name: m && m.name,
    units: m && m.units,
    count: (m && Array.isArray(m.data)) ? m.data.length : 0,
  }));

  try {
    const r = await fetch(supabaseUrl + '/rest/v1/app_state?on_conflict=key', {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: 'Bearer ' + supabaseKey,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        key: 'apple_health',
        data: { latest, debug },
        updated_at: new Date().toISOString(),
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(500).json({ error: 'supabase write failed: ' + text });
    }
    return res.status(200).json({ ok: true, latest });
  } catch (e) {
    return res.status(500).json({ error: 'unexpected error: ' + (e && e.message ? e.message : String(e)) });
  }
}
