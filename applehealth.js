// =============================================================
// Shared reader for Apple Health data synced via the "Health Auto
// Export" iOS app → /api/health-import → Supabase (public.app_state,
// key 'apple_health'). No OAuth — the data just shows up once the
// automation on the phone has run at least once.
//
// Also feeds caffeine samples (Apple Health "Dietary Caffeine") into
// EFI.data.caffeine so the energy model and E.F.I. pick them up
// automatically — no manual caffeine logging needed.
//
// Requires (loaded before this file):
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="/api/config"></script>
// =============================================================
(function () {
  'use strict';

  const SUPABASE_URL = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || 'https://srajryooffirbroltjmg.supabase.co';
  const SUPABASE_KEY = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || 'sb_publishable_5142ZwTLF_DkSVRzciNuRA_bHwRAu4c';
  const ROW_KEY = 'apple_health';
  const CACHE_MS = 60 * 1000;

  let supa = null;
  let cached = null, cachedAt = 0, inflight = null;

  function client() {
    if (supa) return supa;
    if (typeof window === 'undefined' || !window.supabase) return null;
    if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_URL.indexOf('PASTE-') === 0) return null;
    try { supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); } catch (e) { return null; }
    return supa;
  }

  function feed(res) {
    const latest = res && res.latest;
    if (latest && window.EFI && window.EFI.data && window.EFI.data.caffeine) {
      window.EFI.data.caffeine.setAppleSamples(Array.isArray(latest.caffeine) ? latest.caffeine : []);
    }
    return res;
  }

  // Several widgets on one page ask at once — share one request and
  // cache it briefly instead of hitting Supabase for each.
  async function get(force) {
    if (!force && cached && Date.now() - cachedAt < CACHE_MS) return cached;
    if (inflight) return inflight;
    const c = client();
    if (!c) return null;
    inflight = (async () => {
      try {
        const { data, error } = await c.from('app_state').select('data, updated_at').eq('key', ROW_KEY).maybeSingle();
        if (error || !data || !data.data) return null;
        cached = feed({ latest: data.data.latest || null, history: data.data.history || [], updatedAt: data.updated_at || null });
        cachedAt = Date.now();
        return cached;
      } catch (e) { return null; } finally { inflight = null; }
    })();
    return inflight;
  }

  function subscribe(cb) {
    const c = client();
    if (!c) return function () {};
    const ch = c.channel('app_state_' + ROW_KEY + '_' + Math.random().toString(36).slice(2, 7))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + ROW_KEY }, (payload) => {
        if (!payload.new || !payload.new.data) return;
        cached = feed({ latest: payload.new.data.latest || null, history: payload.new.data.history || [], updatedAt: payload.new.updated_at || null });
        cachedAt = Date.now();
        cb(cached);
      })
      .subscribe();
    return function () { try { c.removeChannel(ch); } catch (e) {} };
  }

  window.AppleHealth = { get, subscribe };
})();
