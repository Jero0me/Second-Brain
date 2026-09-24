// =============================================================
// E.F.I. data layer — one API over every module's localStorage data
// (planner goals, calendar events, notes, finance, habits, caffeine)
// plus the calendar aggregator that merges all of it — and Google
// Calendar — into a single normalized timeline.
//
// Both the E.F.I. assistant (efi-agent.js) and the Calendar page use
// this, so a change made by voice/chat is identical to one made by hand.
// Storage keys and shapes match what the existing pages already use,
// so main.html / finance.html keep working on the same data.
//
// Load after efi-core.js (+ efi-google.js for Google events).
// =============================================================
(function () {
  'use strict';
  const EFI = window.EFI = window.EFI || {};
  const S = EFI.store, D = EFI.date;

  // ---------- palette + icons ----------
  const COLORS = {
    mint: '#34D8A0', teal: '#22C3C9', sky: '#5AB8F5', violet: '#9B8AFB',
    amber: '#F5C065', coral: '#FF8A7A', pink: '#F472B6', lime: '#A3E36B',
  };
  const ICON_RULES = [
    [/gym|workout|lift|train|run|cardio|push|pull|legs|swim|yoga|stretch|sport/i, 'dumbbell'],
    [/meet|call|sync|standup|interview|1:1|zoom|teams/i, 'users'],
    [/work|shift|office|job/i, 'briefcase'],
    [/uni|class|lecture|study|exam|course|school|seminar|assignment|homework/i, 'book'],
    [/lunch|dinner|breakfast|eat|meal|food|cook|brunch/i, 'utensils'],
    [/coffee|caff|espresso/i, 'coffee'],
    [/shop|groceries|buy|store|order/i, 'cart'],
    [/flight|trip|travel|airport|train to|vacation|holiday/i, 'plane'],
    [/doctor|dentist|health|therapy|physio|appointment/i, 'heart'],
    [/sleep|bed|nap|rest/i, 'moon'],
    [/wake|rise|morning/i, 'sun'],
    [/birthday|party|celebrat/i, 'gift'],
    [/pay|bill|rent|subscription|renew|invoice/i, 'card'],
    [/clean|laundry|trash|chores|dishes/i, 'home'],
    [/read|book/i, 'book'],
    [/idea|note|write|journal/i, 'pen'],
  ];
  function iconFor(title, fallback) {
    for (const [re, icon] of ICON_RULES) if (re.test(title || '')) return icon;
    return fallback || 'star';
  }

  // ---------- planner goals (goals:YYYY-MM-DD) ----------
  function upgradeGoal(g) {
    let changed = false;
    if (!g.id) { g.id = D.uid('g'); changed = true; }
    if (!g.type) { g.type = 'task'; changed = true; }
    if (g.importance == null) { g.importance = 2; changed = true; }
    if (g.durationMin == null) { g.durationMin = 30; changed = true; }
    if (g.scheduled === undefined) { g.scheduled = null; changed = true; }
    if (g.locked == null) { g.locked = false; changed = true; }
    return changed;
  }
  function goalsKey(dateKey) { return 'goals:' + dateKey; }
  const tasks = {
    list(dateKey) {
      const list = S.get(goalsKey(dateKey), []);
      const arr = Array.isArray(list) ? list : [];
      let changed = false;
      arr.forEach((g) => { if (g && upgradeGoal(g)) changed = true; });
      if (changed) S.set(goalsKey(dateKey), arr);
      return arr;
    },
    save(dateKey, list) {
      S.set(goalsKey(dateKey), list);
      try { window.dispatchEvent(new CustomEvent('goals-changed')); } catch (e) {}
    },
    add(dateKey, t) {
      const list = this.list(dateKey);
      const item = {
        id: D.uid('g'), text: String(t.text || '').trim().slice(0, 200), done: false, type: 'task',
        importance: [1, 2, 3].indexOf(t.importance) !== -1 ? t.importance : 2,
        durationMin: Math.max(5, Math.min(600, Math.round(t.durationMin || 30))),
        scheduled: null, locked: false,
      };
      if (t.start) {
        const s = D.timeToMin(t.start);
        item.scheduled = { start: D.minToTime(s), end: D.minToTime(Math.min(24 * 60, s + item.durationMin)) };
        item.locked = true;
      }
      list.push(item);
      this.save(dateKey, list);
      return item;
    },
    update(dateKey, id, patch) {
      const list = this.list(dateKey);
      const item = list.find((g) => g.id === id);
      if (!item) return null;
      if (patch.text != null) item.text = String(patch.text).slice(0, 200);
      if (patch.importance != null) item.importance = patch.importance;
      if (patch.durationMin != null) item.durationMin = Math.max(5, Math.round(patch.durationMin));
      if (patch.done != null) { item.done = !!patch.done; if (item.done) item.doneAt = Date.now(); else delete item.doneAt; }
      if (patch.start === null) { item.scheduled = null; item.locked = false; }
      else if (patch.start) {
        const s = D.timeToMin(patch.start);
        item.scheduled = { start: D.minToTime(s), end: D.minToTime(Math.min(24 * 60, s + (item.durationMin || 30))) };
        item.locked = true;
      }
      this.save(dateKey, list);
      return item;
    },
    remove(dateKey, id) {
      const list = this.list(dateKey);
      const idx = list.findIndex((g) => g.id === id);
      if (idx === -1) return null;
      const [removed] = list.splice(idx, 1);
      this.save(dateKey, list);
      return removed;
    },
    move(fromKey, id, toKey) {
      const item = this.remove(fromKey, id);
      if (!item) return null;
      const list = this.list(toKey);
      const moved = Object.assign({}, item, { id: D.uid('g'), done: false, scheduled: null, locked: false });
      delete moved.doneAt;
      list.push(moved);
      this.save(toKey, list);
      return moved;
    },
    datesWithGoals() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('goals:') === 0) out.push(k.slice(6));
      }
      return out.sort();
    },
  };

  // ---------- local calendar events (efi:events) ----------
  // Used when Google isn't connected (or for things you don't want in Google).
  const EVENTS_KEY = 'efi:events';
  const events = {
    list() { const v = S.get(EVENTS_KEY, []); return Array.isArray(v) ? v : []; },
    add(e) {
      const list = this.list();
      const item = {
        id: D.uid('ev'), title: String(e.title || 'Event').slice(0, 200), date: e.date,
        start: e.allDay ? null : (e.start || null), end: e.allDay ? null : (e.end || null),
        allDay: !!e.allDay || !e.start, color: e.color || COLORS.mint, icon: e.icon || iconFor(e.title),
        location: e.location || '', notes: e.notes || '', createdAt: Date.now(),
      };
      list.push(item);
      S.set(EVENTS_KEY, list);
      return item;
    },
    update(id, patch) {
      const list = this.list();
      const item = list.find((x) => x.id === id);
      if (!item) return null;
      ['title', 'date', 'start', 'end', 'location', 'notes', 'color', 'icon'].forEach((k) => { if (patch[k] !== undefined) item[k] = patch[k]; });
      if (patch.allDay !== undefined) item.allDay = !!patch.allDay;
      if (item.allDay) { item.start = null; item.end = null; }
      else if (item.start && !item.end) item.end = D.minToTime(D.timeToMin(item.start) + 60);
      S.set(EVENTS_KEY, list);
      return item;
    },
    remove(id) {
      const list = this.list();
      const idx = list.findIndex((x) => x.id === id);
      if (idx === -1) return null;
      const [removed] = list.splice(idx, 1);
      S.set(EVENTS_KEY, list);
      return removed;
    },
  };

  // ---------- notes / ideas (efi:notes) ----------
  const NOTES_KEY = 'efi:notes';
  const notes = {
    list() { const v = S.get(NOTES_KEY, []); return Array.isArray(v) ? v : []; },
    add(n) {
      const list = this.list();
      const item = { id: D.uid('n'), title: String(n.title || '').slice(0, 120), text: String(n.text || '').slice(0, 4000), tags: Array.isArray(n.tags) ? n.tags.slice(0, 8).map(String) : [], pinned: false, createdAt: Date.now() };
      list.unshift(item);
      S.set(NOTES_KEY, list);
      return item;
    },
    update(id, patch) {
      const list = this.list();
      const item = list.find((x) => x.id === id);
      if (!item) return null;
      ['title', 'text', 'tags', 'pinned'].forEach((k) => { if (patch[k] !== undefined) item[k] = patch[k]; });
      item.updatedAt = Date.now();
      S.set(NOTES_KEY, list);
      return item;
    },
    remove(id) {
      const list = this.list();
      const idx = list.findIndex((x) => x.id === id);
      if (idx === -1) return null;
      const [removed] = list.splice(idx, 1);
      S.set(NOTES_KEY, list);
      return removed;
    },
    search(q) {
      q = String(q || '').toLowerCase().trim();
      const list = this.list();
      if (!q) return list;
      return list.filter((n) => (n.title + ' ' + n.text + ' ' + (n.tags || []).join(' ')).toLowerCase().indexOf(q) !== -1);
    },
  };

  // ---------- habits (habits:defs) ----------
  const habits = {
    list() { const v = S.get('habits:defs', []); return Array.isArray(v) ? v : []; },
    add(h) {
      const list = this.list();
      const item = {
        id: D.uid('g'), text: String(h.text || '').slice(0, 120), importance: h.importance || 2,
        durationMin: Math.max(5, Math.round(h.durationMin || 15)),
        days: Array.isArray(h.days) ? h.days.filter((d) => d >= 0 && d <= 6) : [],
        preferredWindow: h.preferredWindow || 'any', active: true, createdAt: Date.now(),
      };
      list.push(item);
      S.set('habits:defs', list);
      return item;
    },
  };

  // ---------- finance (nw:*, subs, wishlist, incoming_orders) ----------
  const NW_CATS = ['bank', 'stocks', 'crypto', 'other'];
  function logActivity(cat, name, delta, kind) {
    const arr = S.get('nw:activity', []) || [];
    arr.push({ ts: Date.now(), cat, name: String(name || ''), delta: Number(delta) || 0, kind: kind || 'edit' });
    if (arr.length > 50) arr.splice(0, arr.length - 50);
    S.set('nw:activity', arr);
  }
  function monthlyEquivalent(s) {
    const a = Number(s.amount) || 0;
    if (s.period === 'yearly') return a / 12;
    if (s.period === 'weekly') return a * 52 / 12;
    return a;
  }
  function stepRenewal(d, period, anchorDay) {
    if (period === 'weekly') return D.addDays(d, 7);
    if (period === 'yearly') return D.addMonthsClamped(d, 12, anchorDay);
    return D.addMonthsClamped(d, 1, anchorDay);
  }
  // Next renewal on/after `from` (default today), month-end safe.
  function nextRenewal(iso, period, from) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
    let d = D.parseKey(iso.slice(0, 10));
    const anchor = d.getDate();
    const floor = from || D.parseKey(D.dateKey());
    let guard = 0;
    while (d < floor && guard++ < 1000) d = stepRenewal(d, period, anchor);
    return d;
  }
  function findByName(list, name, field) {
    const n = String(name || '').toLowerCase().trim();
    if (!n) return -1;
    let idx = list.findIndex((x) => String(x[field || 'name'] || '').toLowerCase() === n);
    if (idx === -1) idx = list.findIndex((x) => String(x[field || 'name'] || '').toLowerCase().indexOf(n) !== -1);
    if (idx === -1) idx = list.findIndex((x) => n.indexOf(String(x[field || 'name'] || '').toLowerCase()) !== -1 && String(x[field || 'name'] || '').length > 2);
    return idx;
  }
  const finance = {
    NW_CATS, monthlyEquivalent, nextRenewal,
    accounts() {
      const out = [];
      NW_CATS.forEach((cat) => (S.get('nw:' + cat, []) || []).forEach((it) => out.push({ category: cat, name: String(it.name || ''), amount: Number(it.amount) || 0 })));
      return out;
    },
    netWorth() { return this.accounts().reduce((s, a) => s + a.amount, 0); },
    findAccount(name, category) {
      const cats = category && NW_CATS.indexOf(category) !== -1 ? [category] : NW_CATS;
      for (const cat of cats) {
        const items = S.get('nw:' + cat, []) || [];
        const idx = findByName(items, name);
        if (idx !== -1) return { category: cat, items, idx };
      }
      return null;
    },
    setBalance(name, opts) {
      const hit = this.findAccount(name, opts.category);
      if (!hit) return null;
      const it = hit.items[hit.idx];
      const cur = Number(it.amount) || 0;
      const next = opts.amount != null ? Number(opts.amount) : cur + Number(opts.delta || 0);
      if (!isFinite(next)) return null;
      it.amount = Math.round(next * 100) / 100;
      S.set('nw:' + hit.category, hit.items);
      if (Math.abs(it.amount - cur) > 0.005) logActivity(hit.category, it.name, it.amount - cur, 'edit');
      return { category: hit.category, name: it.name, before: cur, after: it.amount };
    },
    addAccount(category, name, amount) {
      const cat = NW_CATS.indexOf(category) !== -1 ? category : 'bank';
      const items = S.get('nw:' + cat, []) || [];
      items.push({ name: String(name).slice(0, 80), amount: Number(amount) || 0 });
      S.set('nw:' + cat, items);
      logActivity(cat, name, Number(amount) || 0, 'add');
      return { category: cat, name, amount: Number(amount) || 0 };
    },
    subs() { const v = S.get('subs', []); return Array.isArray(v) ? v : []; },
    addSub(s) {
      const list = this.subs();
      let fromCat = null, fromAccount = null;
      if (s.fromAccount) { const hit = this.findAccount(s.fromAccount); if (hit) { fromCat = hit.category; fromAccount = hit.items[hit.idx].name; } }
      const item = {
        name: String(s.name).slice(0, 80), amount: Number(s.amount) || 0,
        period: ['monthly', 'yearly', 'weekly'].indexOf(s.period) !== -1 ? s.period : 'monthly',
        renewal: s.renewal || null, fromCat, fromAccount,
        autoDeduct: !!(s.autoDeduct && fromCat), lastDeductedAt: null,
      };
      list.push(item);
      S.set('subs', list);
      return item;
    },
    findSub(name) { return findByName(this.subs(), name); },
    updateSub(name, patch) {
      const list = this.subs();
      const idx = findByName(list, name);
      if (idx === -1) return null;
      const it = list[idx];
      if (patch.name) it.name = String(patch.name).slice(0, 80);
      if (patch.amount != null) it.amount = Number(patch.amount) || 0;
      if (patch.period) it.period = patch.period;
      if (patch.renewal !== undefined) it.renewal = patch.renewal;
      S.set('subs', list);
      return it;
    },
    removeSub(name) {
      const list = this.subs();
      const idx = findByName(list, name);
      if (idx === -1) return null;
      const [removed] = list.splice(idx, 1);
      S.set('subs', list);
      return removed;
    },
    wishlist() { const v = S.get('wishlist', []); return Array.isArray(v) ? v : []; },
    addWish(name, amount) {
      const list = this.wishlist();
      const item = { name: String(name).slice(0, 80), amount: Number(amount) || 0, ts: Date.now() };
      list.push(item);
      S.set('wishlist', list);
      return item;
    },
    orders() { const v = S.get('incoming_orders', []); return Array.isArray(v) ? v : []; },
    addOrder(o) {
      const list = this.orders();
      let fromCat = 'bank', fromAccount = null;
      if (o.fromAccount) { const hit = this.findAccount(o.fromAccount); if (hit) { fromCat = hit.category; fromAccount = hit.items[hit.idx].name; } }
      const item = { id: 'o_' + Date.now() + '_' + Math.floor(Math.random() * 9999), name: String(o.name).slice(0, 80), amount: Number(o.amount) || 0, fromCat, fromAccount, date: o.date || null, ts: Date.now(), deductedAt: null, pctAtDeduction: null, deductedFrom: null };
      list.push(item);
      S.set('incoming_orders', list);
      return item;
    },
  };

  // ---------- caffeine ----------
  // Automatic source: Apple Health "Dietary Caffeine" samples synced by
  // /api/health-import (any app that writes caffeine to Health). Manual
  // fallback: "log a coffee" via E.F.I. (efi:caffeine).
  const CAF_KEY = 'efi:caffeine';
  let appleCaffeine = [];
  const caffeine = {
    setAppleSamples(list) { appleCaffeine = Array.isArray(list) ? list.filter((x) => x && x.mg > 0 && x.ts) : []; },
    manual() { const v = S.get(CAF_KEY, []); return Array.isArray(v) ? v : []; },
    add(mg, ts, label) {
      const cutoff = Date.now() - 7 * 86400000;
      const list = this.manual().filter((x) => x.ts > cutoff);
      const item = { id: D.uid('c'), mg: Math.round(Number(mg) || 0), ts: ts || Date.now(), label: label || '' };
      list.push(item);
      S.set(CAF_KEY, list);
      return item;
    },
    logs() {
      const manual = this.manual().map((x) => ({ mg: x.mg, ts: x.ts, source: 'efi' }));
      const apple = appleCaffeine.map((x) => ({ mg: x.mg, ts: x.ts, source: 'health' }));
      // If the same drink was logged both ways (±15 min, similar mg) keep one.
      const out = apple.slice();
      manual.forEach((m) => { if (!apple.some((a) => Math.abs(a.ts - m.ts) < 15 * 60000 && Math.abs(a.mg - m.mg) < 20)) out.push(m); });
      return out.sort((a, b) => a.ts - b.ts);
    },
    todayTotal() {
      const start = D.parseKey(D.dateKey()).getTime();
      return this.logs().filter((x) => x.ts >= start).reduce((s, x) => s + x.mg, 0);
    },
    activeNow() {
      const now = Date.now();
      return Math.round(this.logs().reduce((s, x) => s + (x.ts <= now ? x.mg * Math.pow(0.5, (now - x.ts) / 3600000 / 5) : 0), 0));
    },
  };

  // ---------- plan blocks (templates) ----------
  function planFor(dateKey) {
    const p = S.get('plan:' + dateKey, null);
    return p && typeof p === 'object' ? p : null;
  }
  function templatesDueOn(dateKey) {
    const tpls = S.get('templates:defs', []) || [];
    const dow = D.parseKey(dateKey).getDay();
    return tpls.filter((t) => {
      const r = t.recurrence;
      if (!r || !Array.isArray(r.days) || !r.days.length) return false;
      if (r.startDate && dateKey < r.startDate) return false;
      if (r.endDate && dateKey > r.endDate) return false;
      return r.days.indexOf(dow) !== -1;
    });
  }

  // ---------- calendar aggregator ----------
  // Normalized item:
  // { id, source, title, dateKey, start:'HH:MM'|null, end, allDay, color, icon,
  //   done?, ref:{…ids needed to edit it}, editable }
  function splitTimed(ev, base) {
    const s = new Date(ev.start), e = new Date(ev.end);
    if (isNaN(s) || isNaN(e)) return [];
    const out = [];
    let day = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    let guard = 0;
    while (day < e && guard++ < 60) {
      const next = D.addDays(day, 1);
      const segStart = s > day ? s : day;
      const segEnd = e < next ? e : next;
      const sm = segStart.getHours() * 60 + segStart.getMinutes();
      const em = segEnd >= next ? 24 * 60 : segEnd.getHours() * 60 + segEnd.getMinutes();
      out.push(Object.assign({}, base, { dateKey: D.dateKey(day), start: D.minToTime(sm), end: D.minToTime(Math.max(sm + 5, em)), allDay: false }));
      day = next;
    }
    return out;
  }
  function splitAllDay(startKey, endKeyExclusive, base) {
    const out = [];
    let d = D.parseKey(startKey);
    const end = D.parseKey(endKeyExclusive);
    let guard = 0;
    do { out.push(Object.assign({}, base, { dateKey: D.dateKey(d), start: null, end: null, allDay: true })); d = D.addDays(d, 1); }
    while (d < end && guard++ < 400);
    return out;
  }

  async function range(startKey, endKey, opts) {
    opts = opts || {};
    const items = [];
    const inbox = {};
    const inRange = (k) => k >= startKey && k <= endKey;

    // Google Calendar
    let google = { connected: false, error: null };
    if (opts.google !== false && EFI.google) {
      try {
        const st = await EFI.google.status();
        google.connected = !!st.connected;
        google.configured = !!st.configured;
        if (st.connected) {
          const evs = opts.cachedOnly ? EFI.google.cachedEvents()
            : await EFI.google.listEvents(D.parseKey(startKey), D.addDays(D.parseKey(endKey), 1));
          evs.forEach((ev) => {
            const base = { id: 'g:' + ev.calendarId + ':' + ev.id, source: 'google', title: ev.title, color: ev.color, icon: iconFor(ev.title, 'calendar'), editable: ev.writable, ref: { calendarId: ev.calendarId, eventId: ev.id, link: ev.link }, location: ev.location, notes: ev.notes, calendarName: ev.calendarName };
            const parts = ev.allDay ? splitAllDay(ev.start, ev.end, base) : splitTimed(ev, base);
            parts.forEach((p) => { if (inRange(p.dateKey)) items.push(p); });
          });
        }
      } catch (e) { google.error = e.message || String(e); }
    }

    // Local events
    events.list().forEach((ev) => {
      if (!inRange(ev.date)) return;
      items.push({ id: 'l:' + ev.id, source: 'local', title: ev.title, dateKey: ev.date, start: ev.allDay ? null : ev.start, end: ev.allDay ? null : (ev.end || (ev.start ? D.minToTime(D.timeToMin(ev.start) + 60) : null)), allDay: !!ev.allDay || !ev.start, color: ev.color || COLORS.mint, icon: ev.icon || iconFor(ev.title), editable: true, ref: { id: ev.id }, location: ev.location, notes: ev.notes });
    });

    // Walk each day for planner data, templates, renewals, orders
    let d = D.parseKey(startKey);
    const last = D.parseKey(endKey);
    let guard = 0;
    while (d <= last && guard++ < 400) {
      const k = D.dateKey(d);
      const goals = S.get('goals:' + k, null);
      if (Array.isArray(goals)) {
        goals.forEach((g) => {
          if (!g || !g.text) return;
          if (g.scheduled && g.scheduled.start) {
            items.push({ id: 't:' + k + ':' + g.id, source: 'task', title: g.text, dateKey: k, start: g.scheduled.start, end: g.scheduled.end, allDay: false, color: g.sourceHabitId ? COLORS.teal : (g.importance === 3 ? COLORS.coral : COLORS.mint), icon: g.sourceHabitId ? 'repeat' : iconFor(g.text, 'check'), done: !!g.done, editable: true, ref: { dateKey: k, id: g.id } });
          } else {
            (inbox[k] = inbox[k] || []).push({ id: g.id, text: g.text, done: !!g.done, importance: g.importance || 2, durationMin: g.durationMin || 30, habit: !!g.sourceHabitId });
          }
        });
      }
      const plan = planFor(k);
      const appliedIds = plan && Array.isArray(plan.appliedTemplateIds) ? plan.appliedTemplateIds : [];
      (plan && plan.fixedBlocks || []).forEach((b) => items.push({ id: 'b:' + k + ':' + b.id, source: 'block', title: b.label, dateKey: k, start: b.start, end: b.end, allDay: false, color: COLORS.violet, icon: iconFor(b.label, 'briefcase'), editable: false, ref: { dateKey: k } }));
      // Recurring templates not yet materialized (future days) — shown read-only.
      templatesDueOn(k).forEach((t) => {
        if (appliedIds.indexOf(t.id) !== -1) return;
        (t.blocks || []).filter((b) => b.kind === 'fixed').forEach((b) => items.push({ id: 'v:' + k + ':' + t.id + ':' + b.id, source: 'block', title: b.label, dateKey: k, start: b.start, end: b.end, allDay: false, color: COLORS.violet, icon: iconFor(b.label, 'briefcase'), editable: false, ref: { dateKey: k, template: t.name } }));
      });
      if (plan && plan.napSuggestion) {
        const n = plan.napSuggestion;
        items.push({ id: 'nap:' + k, source: 'block', title: 'Nap', dateKey: k, start: n.start, end: n.end, allDay: false, color: '#9E84FF', icon: 'moon', editable: false, ref: { dateKey: k } });
      }
      d = D.addDays(d, 1);
    }

    // Subscription renewals
    finance.subs().forEach((s, i) => {
      if (!s.renewal) return;
      let r = nextRenewal(s.renewal, s.period, D.parseKey(startKey));
      const anchor = D.parseKey(String(s.renewal).slice(0, 10)).getDate();
      let g2 = 0;
      while (r && D.dateKey(r) <= endKey && g2++ < 60) {
        items.push({ id: 's:' + i + ':' + D.dateKey(r), source: 'renewal', title: s.name + ' · €' + (Number(s.amount) || 0).toFixed(2), dateKey: D.dateKey(r), start: null, end: null, allDay: true, color: COLORS.amber, icon: 'card', editable: false, ref: { name: s.name } });
        r = stepRenewal(r, s.period, anchor);
      }
    });

    // Incoming orders
    finance.orders().forEach((o) => {
      if (!o.date || !inRange(o.date)) return;
      items.push({ id: 'o:' + o.id, source: 'order', title: o.name + ' arrives', dateKey: o.date, start: null, end: null, allDay: true, color: COLORS.sky, icon: 'package', editable: false, ref: { id: o.id } });
    });

    items.sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0) || (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) || String(a.start).localeCompare(String(b.start)));
    return { items, inbox, google };
  }

  // Create an event in Google Calendar when connected (unless told to keep
  // it local), otherwise in E.F.I.'s own calendar.
  async function createEvent(e) {
    if (e.target !== 'local' && EFI.google) {
      const st = await EFI.google.status();
      if (st.connected) {
        const g = await EFI.google.createEvent(e);
        return { where: 'google', id: 'g:' + (e.calendarId || 'primary') + ':' + g.id, event: g };
      }
    }
    const l = events.add(e);
    return { where: 'local', id: 'l:' + l.id, event: l };
  }
  async function updateEvent(itemId, patch) {
    if (itemId.indexOf('g:') === 0) {
      const rest = itemId.slice(2);
      const i = rest.lastIndexOf(':');
      await EFI.google.updateEvent(rest.slice(0, i), rest.slice(i + 1), patch);
      return true;
    }
    if (itemId.indexOf('l:') === 0) return !!events.update(itemId.slice(2), patch);
    return false;
  }
  async function deleteEvent(itemId) {
    if (itemId.indexOf('g:') === 0) {
      const rest = itemId.slice(2);
      const i = rest.lastIndexOf(':');
      await EFI.google.deleteEvent(rest.slice(0, i), rest.slice(i + 1));
      return true;
    }
    if (itemId.indexOf('l:') === 0) return !!events.remove(itemId.slice(2));
    return false;
  }

  EFI.data = {
    COLORS, iconFor, tasks, events, notes, habits, finance, caffeine,
    calendar: { range, createEvent, updateEvent, deleteEvent },
  };
})();
