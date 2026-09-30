// =============================================================
// E.F.I. app shell — drop on any page with:
//     <script src="topbar.js" defer></script>
// Injects the E.F.I. theme (efi-theme.css + font) on every page, the
// floating bottom navigation (Calendar · Health · E.F.I. · Fitness ·
// Finance — energy lives inside Health; Routines sits under Calendar and
// Meal Prep under Fitness), a tiny toast helper, modal scroll-locking, and
// the service worker (sw.js) that makes pages open instantly and offline.
// =============================================================
(function () {
  'use strict';

  const NAV = [
    { href: 'calendar.html', key: 'calendar', label: 'Calendar', icon: 'calendar' },
    { href: 'health.html', key: 'health', label: 'Health', icon: 'heart' },
    { href: 'index.html', key: 'efi', label: 'E.F.I.', orb: true },
    { href: 'gym.html', key: 'fitness', label: 'Fitness', icon: 'dumbbell' },
    { href: 'finance.html', key: 'finance', label: 'Finance', icon: 'wallet' },
  ];

  const lockCss = `
html, body { -webkit-text-size-adjust: 100%; }
@media (max-width: 768px) {
  /* manipulation: no double-tap-zoom delay, but pinch-zoom still works */
  html { touch-action: manipulation; }
  ::-webkit-scrollbar { width: 0; height: 0; display: none; }
  html, body { scrollbar-width: none; -ms-overflow-style: none; }
}
.modal-bg, .modal, .po-modal-bg, .po-modal, .wt-overlay, .wt-viewer, .efi-sheet { overscroll-behavior: contain; }
body.topbar-modal-open { overflow: hidden; touch-action: none; }
@media (max-width: 480px) {
  .modal-bg, .po-modal-bg { padding: 0 !important; align-items: stretch !important; justify-content: stretch !important; }
  .modal, .po-modal {
    width: 100% !important; max-width: 100% !important;
    max-height: 100vh !important; height: 100vh !important; border-radius: 0 !important;
    padding-top: max(20px, env(safe-area-inset-top)) !important;
    padding-bottom: max(28px, env(safe-area-inset-bottom)) !important;
    overflow-y: auto !important; overscroll-behavior: contain;
  }
}`;

  // Sub-pages light up their parent tab.
  const PARENT = { 'main.html': 'calendar', 'mealprep.html': 'fitness', 'energy.html': 'health' };

  function page() {
    const p = (window.location.pathname || '').toLowerCase();
    const file = p.split('/').pop() || 'index.html';
    return file;
  }
  function isEmbedded() { try { return window.self !== window.top; } catch (e) { return true; } }
  function shouldShowNav() { return !isEmbedded(); }
  function activeKey() {
    const f = page();
    const hit = NAV.find((n) => n.href === f);
    return hit ? hit.key : PARENT[f] || (f === '' || f === 'index.html' ? 'efi' : '');
  }

  function icon(name) { return window.EFI && window.EFI.icon ? window.EFI.icon(name, 22, 1.9) : ''; }

  function injectTheme() {
    if (!document.getElementById('efi-theme')) {
      const pre = document.createElement('link');
      pre.rel = 'preconnect'; pre.href = 'https://fonts.gstatic.com'; pre.crossOrigin = '';
      document.head.appendChild(pre);
      const font = document.createElement('link');
      font.rel = 'stylesheet';
      font.href = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap';
      document.head.appendChild(font);
      const theme = document.createElement('link');
      theme.id = 'efi-theme'; theme.rel = 'stylesheet'; theme.href = 'efi-theme.css';
      document.head.appendChild(theme);
    }
    const style = document.createElement('style');
    style.id = 'topbar-style';
    style.textContent = lockCss;
    document.head.appendChild(style);
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = '#05090A';
  }

  function injectNav() {
    if (document.getElementById('efiNav') || !shouldShowNav()) return;
    const active = activeKey();
    const nav = document.createElement('nav');
    nav.className = 'efi-nav';
    nav.id = 'efiNav';
    nav.setAttribute('aria-label', 'Main');
    nav.innerHTML = '<div class="efi-nav-inner">' + NAV.map((n) => {
      const cls = (n.orb ? 'efi-nav-orb' : '') + (n.key === active ? ' active' : '');
      const inner = n.orb ? '<span class="orb"></span><span>' + n.label + '</span>' : icon(n.icon) + '<span>' + n.label + '</span>';
      return '<a href="' + n.href + '" class="' + cls.trim() + '"' + (n.key === active ? ' aria-current="page"' : '') + '>' + inner + '</a>';
    }).join('') + '</div>';
    document.body.appendChild(nav);
    document.body.classList.add('has-efi-nav');
  }

  // Tiny toast: EFI.toast('Saved')
  function toast(msg, ms) {
    let el = document.getElementById('efiToast');
    if (!el) { el = document.createElement('div'); el.id = 'efiToast'; el.className = 'efi-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms || 2400);
  }

  // Service worker: cached pages/scripts, offline start. Skipped on
  // localhost (so edits show up at once) unless efi_local:sw_dev is set.
  function registerSW() {
    if (!('serviceWorker' in navigator) || isEmbedded()) return;
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    let dev = false; try { dev = !!localStorage.getItem('efi_local:sw_dev'); } catch (e) {}
    if (local ? !dev : location.protocol !== 'https:') return;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'efi-updated') toast('E.F.I. updated — the new version loads on your next tap', 3600);
    });
  }

  // Lock page scroll while any known modal/overlay is open.
  function startModalLock() {
    const SEL = '.modal-bg, .po-modal-bg, .wt-overlay, .wt-viewer, .wt-cam, .efi-sheet-bg';
    function anyOpen() {
      const els = document.querySelectorAll(SEL);
      for (const el of els) if (el.classList.contains('show') || el.classList.contains('is-open')) return true;
      return false;
    }
    const sync = () => document.body.classList.toggle('topbar-modal-open', anyOpen());
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    sync();
  }

  function boot() {
    window.EFI = window.EFI || {};
    window.EFI.toast = toast;
    injectTheme();
    injectNav();
    registerSW();
    startModalLock();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
