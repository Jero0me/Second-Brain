// =============================================================
// Shared energy-prediction model (two-process: circadian + sleep
// pressure + caffeine decay). Originally lived inline in
// caffeine.html; extracted so main.html's Day Ring and the future
// AI day-planner can reason about the same energy curve instead of
// each carrying its own copy.
//
// Pure math — no DOM, no localStorage writes. Callers build a
// `ctx` (via computeContext(), or by hand) and pass it into the
// stateless functions below.
//
// ctx shape: { wakeHour, bedHour, recovery, hrv, rhr, sleepAsleepMin, caffeineLogs }
//   caffeineLogs: array of {mg, ts} — same shape as caffeine.html's 'caf:logs'.
//
// Load this WITHOUT `defer` (like supabase-js/api/config) — it has
// no DOM dependency, and callers that run in non-deferred inline
// scripts (caffeine.html's boot sequence) need window.EnergyModel
// to already exist.
// =============================================================
(function () {
  'use strict';

  const HALF_LIFE_H = 5;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function gauss(x, mu, sd) { return Math.exp(-Math.pow(x - mu, 2) / (2 * sd * sd)); }

  function midnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function hToTs(h) { return midnight() + h * 3600000; }
  function nowHour() { const d = new Date(); return d.getHours() + d.getMinutes() / 60; }

  function fmtClock(h) {
    h = ((h % 24) + 24) % 24;
    let hr = Math.floor(h), m = Math.round((h - hr) * 60);
    if (m === 60) { m = 0; hr = (hr + 1) % 24; }
    const ap = hr >= 12 ? 'PM' : 'AM';
    let h12 = hr % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }

  // ---- pharmacokinetics ----
  function activeAt(dose, ts, t) {
    const hrs = (t - ts) / 3600000;
    return hrs < 0 ? 0 : dose * Math.pow(0.5, hrs / HALF_LIFE_H);
  }
  function totalActiveAt(logs, t) {
    let s = 0;
    for (const l of (logs || [])) s += activeAt(l.mg, l.ts, t);
    return s;
  }

  // ---- two-process energy model ----
  function circadian(t) { return 50 + 18 * Math.cos(2 * Math.PI * (t - 16.5) / 24); }
  function lunchDip(t) { return 10 * gauss(t, 14, 1.4); }
  function sleepPressure(awakeH) { return clamp(awakeH, 0, 24) * 1.7; }
  function morningBump(t, wakeHour) { const d = t - wakeHour; return (d < 0 || d > 4) ? 0 : 10 * gauss(d, 1.2, 0.9); }
  function caffeineBoostAt(t, logs) { const a = totalActiveAt(logs, hToTs(t)); return 34 * (1 - Math.exp(-a / 110)); }
  function asleepAt(t, ctx) { return (t < ctx.wakeHour) || (t >= ctx.bedHour); }

  function energyAt(t, ctx, withCaf) {
    const C = circadian(t);
    if (asleepAt(t, ctx)) return clamp(C - 34, 3, 20);
    let e = C - lunchDip(t) - sleepPressure(t - ctx.wakeHour) + morningBump(t, ctx.wakeHour);
    if (withCaf !== false) e += caffeineBoostAt(t, ctx.caffeineLogs);
    return clamp(e, 0, 100);
  }

  function stateWord(v) {
    if (v >= 80) return 'Peak';
    if (v >= 62) return 'High';
    if (v >= 44) return 'Steady';
    if (v >= 28) return 'Dip';
    return 'Low';
  }
  function energyColor(v) {
    if (v >= 62) return '#6BE3A4';
    if (v >= 40) return '#F2C063';
    return '#FF8A8A';
  }

  function sample(ctx, stepMin) {
    const step = (stepMin || 10) / 60;
    const pts = [];
    for (let t = 0; t <= 24; t += step) pts.push({ t, v: energyAt(t, ctx, true) });
    return pts;
  }

  // Heuristic trough detector — same steepest-sustained-drop logic
  // caffeine.html already used for its "crash" callout, reused here
  // to decide whether a nap is actually worth suggesting.
  function predictNap(ctx) {
    const now = nowHour();
    let crashT = null, worst = 0;
    for (let t = now + 0.25; t <= Math.min(ctx.bedHour, now + 8); t += 1 / 6) {
      const drop = energyAt(t - 0.25, ctx, true) - energyAt(t + 0.25, ctx, true);
      if (drop > worst) { worst = drop; crashT = t; }
    }
    const crashSignificant = worst >= 2.2; // ~ >13 pts/hr
    if (!crashSignificant || crashT == null) return null;
    const troughV = energyAt(crashT + 0.5, ctx, true);
    // Only worth surfacing if recovery was mediocre/poor, or the trough itself is genuinely low.
    if ((ctx.recovery == null || ctx.recovery >= 70) && troughV >= 35) return null;
    const napStart = clamp(crashT - 0.15, now, ctx.bedHour);
    const napEnd = clamp(napStart + 1 / 3, now, ctx.bedHour); // ~20 min
    const reasonParts = [];
    if (ctx.recovery != null) reasonParts.push('sleep was ' + ctx.recovery + '% of goal');
    reasonParts.push('energy dips hard around ' + fmtClock(crashT));
    return { start: napStart, end: napEnd, reason: reasonParts.join(' — ') + '.' };
  }

  function dateKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  async function computeContext() {
    const ctx = {
      wakeHour: 7, bedHour: 23,
      recovery: null, hrv: null, rhr: null, sleepAsleepMin: null,
      caffeineLogs: [],
      syncDate: null, // 'YYYY-MM-DD' the most recent sleep sync's wake-up falls on, or null if no real sync yet
    };
    try {
      const raw = localStorage.getItem('caf:logs');
      if (raw) ctx.caffeineLogs = JSON.parse(raw) || [];
    } catch (e) {}
    if (typeof window !== 'undefined' && window.AppleHealth) {
      try {
        const res = await window.AppleHealth.get();
        const latest = res && res.latest;
        if (latest) {
          ctx.hrv = latest.hrv != null ? latest.hrv : null;
          ctx.rhr = latest.rhr != null ? latest.rhr : null;
          const s = latest.sleep;
          if (s && s.asleepMin != null) {
            ctx.sleepAsleepMin = s.asleepMin;
            ctx.recovery = Math.min(100, Math.round(s.asleepMin / 480 * 100));
          }
          if (s) {
            if (s.sleepStart) { const d = new Date(s.sleepStart); ctx.bedHour = clamp(d.getHours() + d.getMinutes() / 60, 20, 23.9); }
            if (s.sleepEnd)   { const d = new Date(s.sleepEnd);   ctx.wakeHour = clamp(d.getHours() + d.getMinutes() / 60, 4, 11); ctx.syncDate = dateKey(d); }
          }
        }
      } catch (e) {}
    }
    return ctx;
  }

  window.EnergyModel = {
    computeContext,
    energyAt, sample, stateWord, energyColor, predictNap,
    activeAt, totalActiveAt,
    fmtClock, clamp, nowHour,
  };
})();
