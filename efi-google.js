// =============================================================
// E.F.I. ↔ Google (Calendar + Tasks), browser side.
// Short-lived access tokens come from /api/google?action=token,
// which refreshes them from an HttpOnly cookie — so a device that
// connected once stays connected with no popups. See api/google.js.
//
// Load after efi-core.js:  <script src="efi-google.js"></script>
// =============================================================
(function () {
  'use strict';
  const EFI = window.EFI = window.EFI || {};
  const store = EFI.store;

  const TOKEN_LS = 'efi_local:gtoken';        // {t, exp} — per device, never synced
  const CAL_LIST_LS = 'efi_local:gcals';      // cached calendar list {ts, items}
  const EVENTS_CACHE_LS = 'efi_local:gevents'; // last fetched events, for instant paint/offline
  const CAL = 'https://www.googleapis.com/calendar/v3';
  const TASKS = 'https://tasks.googleapis.com/tasks/v1';

  let statusCache = null;
  let tokenInflight = null;

  function isHttp() { return /^https?:$/.test(location.protocol); }

  async function status(force) {
    if (!isHttp()) return { configured: false, connected: false };
    if (statusCache && !force) return statusCache;
    try {
      const r = await fetch('/api/google?action=status', { credentials: 'same-origin', cache: 'no-store' });
      statusCache = r.ok ? await r.json() : { configured: false, connected: false };
    } catch (e) { statusCache = { configured: false, connected: false }; }
    return statusCache;
  }

  async function token() {
    const cached = store.get(TOKEN_LS, null);
    if (cached && cached.t && cached.exp > Date.now() + 60000) return cached.t;
    if (tokenInflight) return tokenInflight;
    tokenInflight = (async () => {
      try {
        const r = await fetch('/api/google?action=token', { credentials: 'same-origin', cache: 'no-store' });
        if (r.status === 401) { statusCache = { configured: true, connected: false }; store.del(TOKEN_LS); return null; }
        if (!r.ok) return null;
        const j = await r.json();
        store.set(TOKEN_LS, { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
        return j.access_token;
      } catch (e) { return null; } finally { tokenInflight = null; }
    })();
    return tokenInflight;
  }

  async function api(url, opts, retried) {
    const t = await token();
    if (!t) throw new Error('Google is not connected.');
    opts = opts || {};
    const headers = Object.assign({ Authorization: 'Bearer ' + t }, opts.body ? { 'Content-Type': 'application/json' } : {});
    const r = await fetch(url, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (r.status === 401 && !retried) { store.del(TOKEN_LS); return api(url, opts, true); }
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ('Google API error ' + r.status));
    return j;
  }

  function connect() {
    location.href = '/api/google?action=auth&return=' + encodeURIComponent(location.pathname + location.search.replace(/([?&])google=[^&]*/g, ''));
  }
  async function disconnect() {
    try { await fetch('/api/google?action=disconnect', { credentials: 'same-origin' }); } catch (e) {}
    store.del(TOKEN_LS); store.del(CAL_LIST_LS); store.del(EVENTS_CACHE_LS);
    statusCache = { configured: true, connected: false };
  }

  // ---------- Calendar ----------
  async function calendars(force) {
    const cached = store.get(CAL_LIST_LS, null);
    if (!force && cached && Date.now() - cached.ts < 6 * 3600 * 1000) return cached.items;
    let items;
    try {
      const j = await api(CAL + '/users/me/calendarList?minAccessRole=reader&maxResults=100');
      items = (j.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, color: c.backgroundColor, primary: !!c.primary, selected: c.selected !== false, writable: c.accessRole === 'owner' || c.accessRole === 'writer' }));
    } catch (e) {
      items = [{ id: 'primary', name: 'Calendar', color: '#34D8A0', primary: true, selected: true, writable: true }];
    }
    store.set(CAL_LIST_LS, { ts: Date.now(), items });
    return items;
  }

  function activeCalendars(list) {
    const chosen = EFI.settings.get().googleCalendars; // null = every calendar shown in Google
    return list.filter((c) => (chosen ? chosen.indexOf(c.id) !== -1 : c.selected));
  }

  // Google colorId → hex (Calendar's fixed event palette).
  const EVENT_COLORS = { 1: '#7986CB', 2: '#33B679', 3: '#8E24AA', 4: '#E67C73', 5: '#F6BF26', 6: '#F4511E', 7: '#039BE5', 8: '#616161', 9: '#3F51B5', 10: '#0B8043', 11: '#D50000' };

  function normalize(ev, cal) {
    const allDay = !!(ev.start && ev.start.date);
    return {
      id: ev.id,
      calendarId: cal.id,
      calendarName: cal.name,
      writable: cal.writable,
      title: ev.summary || '(no title)',
      location: ev.location || '',
      notes: ev.description || '',
      allDay,
      start: allDay ? ev.start.date : ev.start.dateTime,
      end: allDay ? ev.end.date : ev.end.dateTime,
      color: EVENT_COLORS[ev.colorId] || cal.color || '#34D8A0',
      link: ev.htmlLink || '',
    };
  }

  async function listEvents(timeMin, timeMax) {
    const cals = activeCalendars(await calendars());
    const results = await Promise.all(cals.map(async (cal) => {
      try {
        const qs = new URLSearchParams({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
        const j = await api(CAL + '/calendars/' + encodeURIComponent(cal.id) + '/events?' + qs);
        return (j.items || []).filter((e) => e.status !== 'cancelled').map((e) => normalize(e, cal));
      } catch (e) { return []; }
    }));
    const events = [].concat.apply([], results);
    store.set(EVENTS_CACHE_LS, { ts: Date.now(), min: timeMin.toISOString(), max: timeMax.toISOString(), events });
    return events;
  }

  function cachedEvents() { const c = store.get(EVENTS_CACHE_LS, null); return c ? c.events : []; }

  // {title, date:'YYYY-MM-DD', start:'HH:MM'|null, end, allDay, location, notes}
  function toGoogleTimes(e) {
    if (e.allDay || !e.start) {
      const endDate = EFI.date.dateKey(EFI.date.addDays(EFI.date.parseKey(e.endDate || e.date), 1));
      return { start: { date: e.date }, end: { date: endDate } };
    }
    const endT = e.end || EFI.date.minToTime(Math.min(24 * 60 - 1, EFI.date.timeToMin(e.start) + 60));
    return {
      start: { dateTime: e.date + 'T' + e.start + ':00', timeZone: EFI.date.tz },
      end: { dateTime: (e.endDate || e.date) + 'T' + (endT === '24:00' ? '23:59' : endT) + ':00', timeZone: EFI.date.tz },
    };
  }

  async function createEvent(e) {
    const body = Object.assign({ summary: e.title, location: e.location || undefined, description: e.notes || undefined }, toGoogleTimes(e));
    const j = await api(CAL + '/calendars/' + encodeURIComponent(e.calendarId || 'primary') + '/events', { method: 'POST', body });
    return normalize(j, { id: e.calendarId || 'primary', name: 'Calendar', color: '#34D8A0', writable: true });
  }
  async function updateEvent(calendarId, id, patch) {
    const body = {};
    if (patch.title != null) body.summary = patch.title;
    if (patch.location != null) body.location = patch.location;
    if (patch.notes != null) body.description = patch.notes;
    if (patch.date) Object.assign(body, toGoogleTimes(patch));
    return api(CAL + '/calendars/' + encodeURIComponent(calendarId || 'primary') + '/events/' + encodeURIComponent(id), { method: 'PATCH', body });
  }
  async function deleteEvent(calendarId, id) {
    return api(CAL + '/calendars/' + encodeURIComponent(calendarId || 'primary') + '/events/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  // ---------- Tasks ----------
  async function listTasks() {
    const lists = await api(TASKS + '/users/@me/lists?maxResults=20');
    const out = [];
    for (const l of (lists.items || [])) {
      const j = await api(TASKS + '/lists/' + encodeURIComponent(l.id) + '/tasks?showCompleted=false&maxResults=100');
      (j.items || []).forEach((t) => out.push({ id: t.id, listId: l.id, list: l.title, title: t.title, notes: t.notes || '', due: t.due ? t.due.slice(0, 10) : null }));
    }
    return out;
  }
  async function createTask(t) {
    const body = { title: t.title, notes: t.notes || undefined };
    if (t.due) body.due = t.due + 'T00:00:00.000Z';
    return api(TASKS + '/lists/' + encodeURIComponent(t.listId || '@default') + '/tasks', { method: 'POST', body });
  }
  async function completeTask(listId, id) {
    return api(TASKS + '/lists/' + encodeURIComponent(listId || '@default') + '/tasks/' + encodeURIComponent(id), { method: 'PATCH', body: { status: 'completed' } });
  }

  EFI.google = {
    status, connect, disconnect, token,
    calendars, listEvents, cachedEvents, createEvent, updateEvent, deleteEvent,
    listTasks, createTask, completeTask,
    async isConnected() { const s = await status(); return !!s.connected; },
  };
})();
