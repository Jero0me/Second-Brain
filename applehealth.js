// =============================================================
// Shared reader for Apple Health data synced via the "Health Auto
// Export" iOS app → /api/health-import → Supabase (public.app_state,
// key 'apple_health'). No OAuth — the data just shows up once the
// automation on the phone has run at least once.
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

  let supa = null;
  function client() {
    if (supa) return supa;
    if (typeof window === 'undefined' || !window.supabase) return null;
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return supa;
  }

  async function get() {
    const c = client();
    if (!c) return null;
    try {
      const { data, error } = await c.from('app_state').select('data, updated_at').eq('key', ROW_KEY).maybeSingle();
      if (error || !data || !data.data) return null;
      return { latest: data.data.latest || null, updatedAt: data.updated_at || null };
    } catch (e) { return null; }
  }

  function subscribe(cb) {
    const c = client();
    if (!c) return function () {};
    const ch = c.channel('app_state_' + ROW_KEY)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + ROW_KEY }, (payload) => {
        if (!payload.new || !payload.new.data) return;
        cb({ latest: payload.new.data.latest || null, updatedAt: payload.new.updated_at || null });
      })
      .subscribe();
    return function () { try { c.removeChannel(ch); } catch (e) {} };
  }

  window.AppleHealth = { get, subscribe };
})();
