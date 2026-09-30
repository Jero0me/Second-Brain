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
// A copy is kept per device under `efi_local:health_cache` (never
// synced), so the Health page still shows your numbers offline.
//
//   AppleHealth.get(force) → { latest, history, updatedAt } | null
//   AppleHealth.subscribe(cb) → called when the row changes (realtime)
//
// Load after sync.js (both deferred): it provides CloudSync.reader.
// =============================================================
(function () {
  'use strict';

  function feed(res) {
    const latest = res && res.latest;
    if (latest && window.EFI && window.EFI.data && window.EFI.data.caffeine) {
      window.EFI.data.caffeine.setAppleSamples(Array.isArray(latest.caffeine) ? latest.caffeine : []);
    }
  }

  const reader = window.CloudSync.reader('apple_health', {
    cacheKey: 'efi_local:health_cache',
    normalize: (row) => ({ latest: row.data.latest || null, history: row.data.history || [], updatedAt: row.updated_at || null }),
    fromCache: (v) => (v && 'latest' in v ? v : null),
    onValue: feed,
  });

  window.AppleHealth = { get: reader.get, subscribe: reader.subscribe };
})();
