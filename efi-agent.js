// =============================================================
// E.F.I. agent — Gemini function calling over EFI.data.
//
// EFI.agent.send(text, ui) runs one conversational turn:
//   user text → Gemini (with a live snapshot of calendar, tasks,
//   finances, health) → tool calls → results back → final reply.
//
// Tools flagged `confirm` (deletes, balance changes…) never run until
// ui.confirm(description) resolves true — the model can propose them,
// only the user can approve them.
//
// Load after efi-core.js, efi-google.js, efi-data.js.
// =============================================================
(function () {
  'use strict';
  const EFI = window.EFI = window.EFI || {};
  const D = EFI.date, S = EFI.store;
  const data = () => EFI.data;

  const HISTORY_LS = 'efi_local:history';
  const MAX_HISTORY = 30;

  // ---------- helpers ----------
  const T = { S: 'STRING', N: 'NUMBER', I: 'INTEGER', B: 'BOOLEAN', A: 'ARRAY', O: 'OBJECT' };
  function obj(props, required) { return { type: T.O, properties: props, required: required || [] }; }
  const str = (description, extra) => Object.assign({ type: T.S, description }, extra && extra.enum ? { format: 'enum' } : {}, extra || {});
  const num = (description) => ({ type: T.N, description });
  const int = (description) => ({ type: T.I, description });
  const bool = (description) => ({ type: T.B, description });

  function normDate(v) {
    if (!v) return D.activeDateKey();
    const s = String(v).trim().toLowerCase();
    if (s === 'today') return D.activeDateKey();
    if (s === 'tomorrow') return D.tomorrowDateKey();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : D.activeDateKey();
  }
  function normTime(v) {
    if (v == null || v === '') return null;
    const m = String(v).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m) return null;
    let h = Number(m[1]); const mm = Number(m[2] || 0);
    if (m[3]) { const pm = m[3].toLowerCase() === 'pm'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    if (h > 24 || mm > 59) return null;
    return D.pad2(h) + ':' + D.pad2(mm);
  }
  const eur = (n) => '€' + (Number(n) || 0).toFixed(2);
  // Friendly date for action labels: "today", "tomorrow", "Fri 25 Sep".
  function nice(v) {
    const k = normDate(v);
    if (k === D.dateKey()) return 'today';
    if (k === D.dateKey(D.addDays(new Date(), 1))) return 'tomorrow';
    return D.parseKey(k).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function subName(name) { const f = data().finance; const i = f.findSub(name); return i === -1 ? name : f.subs()[i].name; }

  function findTask(dateKey, idOrText) {
    const list = data().tasks.list(dateKey);
    let t = list.find((g) => g.id === idOrText);
    if (!t && idOrText) {
      const q = String(idOrText).toLowerCase();
      t = list.find((g) => g.text.toLowerCase() === q) || list.find((g) => g.text.toLowerCase().indexOf(q) !== -1);
    }
    return t || null;
  }

  // ---------- tools ----------
  const TOOLS = {
    create_event: {
      decl: {
        description: 'Create a calendar event (appointment, meeting, class, trip, fixed commitment). Goes to Google Calendar when connected, else the E.F.I. calendar.',
        parameters: obj({
          title: str('Event title'),
          date: str('YYYY-MM-DD'),
          start_time: str('HH:MM 24h. Omit for an all-day event.'),
          end_time: str('HH:MM 24h. Defaults to start + 60 min.'),
          end_date: str('YYYY-MM-DD for multi-day events, else omit'),
          location: str('Optional location'),
          notes: str('Optional description'),
          keep_local: bool('True to keep it out of Google Calendar'),
        }, ['title', 'date']),
      },
      async run(a) {
        const start = normTime(a.start_time);
        let end = normTime(a.end_time);
        if (start && (!end || D.timeToMin(end) <= D.timeToMin(start))) end = D.minToTime(Math.min(24 * 60 - 1, D.timeToMin(start) + 60));
        const r = await data().calendar.createEvent({ title: a.title, date: normDate(a.date), endDate: a.end_date ? normDate(a.end_date) : null, start, end, allDay: !start, location: a.location, notes: a.notes, target: a.keep_local ? 'local' : 'auto' });
        return { ok: true, event_id: r.id, saved_to: r.where === 'google' ? 'Google Calendar' : 'E.F.I. calendar' };
      },
      label: (a) => 'Event · ' + a.title + ' — ' + nice(a.date) + (normTime(a.start_time) ? ' ' + normTime(a.start_time) : ''),
    },
    update_event: {
      decl: {
        description: 'Move/rename/edit an existing calendar event by its id (ids appear in the calendar snapshot as g:… or l:…).',
        parameters: obj({ event_id: str('Event id'), title: str('New title'), date: str('YYYY-MM-DD'), start_time: str('HH:MM'), end_time: str('HH:MM'), location: str(''), notes: str('') }, ['event_id']),
      },
      async run(a) {
        const patch = {};
        if (a.title) patch.title = a.title;
        if (a.location != null) patch.location = a.location;
        if (a.notes != null) patch.notes = a.notes;
        if (a.date || a.start_time) {
          const snap = await snapshotEvent(a.event_id);
          patch.date = a.date ? normDate(a.date) : (snap && snap.dateKey) || D.activeDateKey();
          patch.start = normTime(a.start_time) || (snap && snap.start) || null;
          const dur = snap && snap.start && snap.end ? D.timeToMin(snap.end) - D.timeToMin(snap.start) : 60;
          patch.end = normTime(a.end_time) || (patch.start ? D.minToTime(Math.min(24 * 60 - 1, D.timeToMin(patch.start) + dur)) : null);
          patch.allDay = !patch.start;
        } else if (a.end_time) {
          const snap = await snapshotEvent(a.event_id);
          if (snap) { patch.date = snap.dateKey; patch.start = snap.start; patch.end = normTime(a.end_time); patch.allDay = !snap.start; }
        }
        const ok = await data().calendar.updateEvent(a.event_id, patch);
        return ok ? { ok: true } : { ok: false, error: 'Event not found or not editable.' };
      },
      label: (a) => 'Update event ' + (a.title || a.event_id),
    },
    delete_event: {
      confirm: true,
      decl: { description: 'Delete a calendar event by id.', parameters: obj({ event_id: str('Event id'), title: str('Event title, for the confirmation prompt') }, ['event_id']) },
      async run(a) { const ok = await data().calendar.deleteEvent(a.event_id); return ok ? { ok: true } : { ok: false, error: 'Event not found.' }; },
      label: (a) => 'Delete event “' + (a.title || a.event_id) + '”',
    },
    list_events: {
      decl: { description: 'List calendar items (events, time-blocked tasks, work/uni blocks, bill renewals) between two dates, for questions beyond the snapshot window.', parameters: obj({ from_date: str('YYYY-MM-DD'), to_date: str('YYYY-MM-DD') }, ['from_date', 'to_date']) },
      async run(a) {
        const from = normDate(a.from_date), to = normDate(a.to_date);
        const r = await data().calendar.range(from, to > from ? to : from);
        return { items: r.items.slice(0, 150).map(compactItem) };
      },
      silent: true,
    },
    add_task: {
      decl: {
        description: 'Add a to-do to the daily planner. Give start_time to time-block it on that day\'s grid.',
        parameters: obj({ text: str('Concise action, under 60 chars'), date: str('YYYY-MM-DD, "today" or "tomorrow"'), importance: int('1 low, 2 medium, 3 high'), duration_min: int('Estimated minutes (default 30)'), start_time: str('HH:MM to time-block it') }, ['text']),
      },
      async run(a) {
        const k = normDate(a.date);
        const t = data().tasks.add(k, { text: a.text, importance: a.importance, durationMin: a.duration_min, start: normTime(a.start_time) });
        return { ok: true, task_id: t.id, date: k, scheduled: t.scheduled };
      },
      label: (a) => 'Task · ' + a.text + ' — ' + nice(a.date) + (normTime(a.start_time) ? ' ' + normTime(a.start_time) : ''),
    },
    update_task: {
      decl: {
        description: 'Edit a planner task: mark done/undone, rename, time-block (start_time) or unschedule (start_time ""), change importance/duration, or move to another day.',
        parameters: obj({ task_id: str('Task id (or its exact text)'), date: str('Date the task is on, YYYY-MM-DD'), text: str(''), done: bool(''), start_time: str('HH:MM, or "" to unschedule'), importance: int('1-3'), duration_min: int(''), move_to_date: str('YYYY-MM-DD') }, ['task_id']),
      },
      async run(a) {
        const k = normDate(a.date);
        const t = findTask(k, a.task_id);
        if (!t) return { ok: false, error: 'Task not found on ' + k };
        if (a.move_to_date) { const m = data().tasks.move(k, t.id, normDate(a.move_to_date)); return { ok: !!m, task_id: m && m.id, date: normDate(a.move_to_date) }; }
        const patch = {};
        if (a.text) patch.text = a.text;
        if (a.done != null) patch.done = a.done;
        if (a.importance) patch.importance = a.importance;
        if (a.duration_min) patch.durationMin = a.duration_min;
        if (a.start_time === '') patch.start = null; else if (a.start_time) patch.start = normTime(a.start_time);
        const r = data().tasks.update(k, t.id, patch);
        return { ok: !!r, task: r && { id: r.id, text: r.text, done: r.done, scheduled: r.scheduled } };
      },
      label: (a) => (a.done ? 'Done · ' : 'Update task · ') + (a.text || a.task_id),
    },
    delete_task: {
      confirm: true,
      decl: { description: 'Delete a planner task.', parameters: obj({ task_id: str('Task id or text'), date: str('YYYY-MM-DD') }, ['task_id']) },
      async run(a) { const k = normDate(a.date); const t = findTask(k, a.task_id); if (!t) return { ok: false, error: 'Task not found' }; data().tasks.remove(k, t.id); return { ok: true }; },
      label: (a) => 'Delete task “' + (findTask(normDate(a.date), a.task_id) || { text: a.task_id }).text + '”',
    },
    add_habit: {
      decl: {
        description: 'Create a recurring habit that appears in the planner on the chosen weekdays.',
        parameters: obj({ text: str('Habit'), days: { type: T.A, items: { type: T.I }, description: 'Weekdays 0=Sun…6=Sat; empty = every day' }, duration_min: int(''), importance: int('1-3'), preferred_window: str('morning|midday|afternoon|evening|any', { enum: ['morning', 'midday', 'afternoon', 'evening', 'any'] }) }, ['text']),
      },
      async run(a) { const h = data().habits.add({ text: a.text, days: a.days, durationMin: a.duration_min, importance: a.importance, preferredWindow: a.preferred_window }); return { ok: true, habit_id: h.id }; },
      label: (a) => 'Habit · ' + a.text,
    },
    add_note: {
      decl: { description: 'Save an idea / note to E.F.I. notes.', parameters: obj({ text: str('The note body'), title: str('Short title'), tags: { type: T.A, items: { type: T.S }, description: '1-3 lowercase tags' } }, ['text']) },
      async run(a) { const n = data().notes.add(a); return { ok: true, note_id: n.id }; },
      label: (a) => 'Note · ' + (a.title || String(a.text).slice(0, 40)),
    },
    search_notes: {
      decl: { description: 'Search saved notes/ideas.', parameters: obj({ query: str('Search text; empty for recent') }) },
      async run(a) { return { notes: data().notes.search(a.query).slice(0, 25).map((n) => ({ id: n.id, title: n.title, text: n.text.slice(0, 500), tags: n.tags, created: D.dateKey(new Date(n.createdAt)) })) }; },
      silent: true,
    },
    delete_note: {
      confirm: true,
      decl: { description: 'Delete a note by id.', parameters: obj({ note_id: str(''), title: str('Note title for the confirmation prompt') }, ['note_id']) },
      async run(a) { return { ok: !!data().notes.remove(a.note_id) }; },
      label: (a) => 'Delete note “' + (a.title || a.note_id) + '”',
    },
    add_subscription: {
      decl: {
        description: 'Track a new subscription in Finance.',
        parameters: obj({ name: str(''), amount: num('Price in EUR per billing period'), period: str('', { enum: ['monthly', 'yearly', 'weekly'] }), renewal_date: str('Next renewal YYYY-MM-DD'), from_account: str('Net-worth account it is paid from') }, ['name', 'amount']),
      },
      async run(a) { const s = data().finance.addSub({ name: a.name, amount: a.amount, period: a.period, renewal: a.renewal_date ? normDate(a.renewal_date) : null, fromAccount: a.from_account }); return { ok: true, subscription: s }; },
      label: (a) => 'Subscription · ' + a.name + ' ' + eur(a.amount) + '/' + (a.period || 'monthly').replace('ly', ''),
    },
    update_subscription: {
      confirm: true,
      decl: { description: 'Change a subscription (price, period, renewal date, name).', parameters: obj({ name: str('Current name'), new_name: str(''), amount: num('EUR'), period: str('', { enum: ['monthly', 'yearly', 'weekly'] }), renewal_date: str('YYYY-MM-DD') }, ['name']) },
      async run(a) { const s = data().finance.updateSub(a.name, { name: a.new_name, amount: a.amount, period: a.period, renewal: a.renewal_date ? normDate(a.renewal_date) : undefined }); return s ? { ok: true, subscription: s } : { ok: false, error: 'No subscription matching "' + a.name + '"' }; },
      label: (a) => 'Update subscription ' + subName(a.name) + (a.amount != null ? ' → ' + eur(a.amount) : '') + (a.renewal_date ? ' · renews ' + nice(a.renewal_date) : ''),
    },
    remove_subscription: {
      confirm: true,
      decl: { description: 'Remove (cancel tracking of) a subscription.', parameters: obj({ name: str('') }, ['name']) },
      async run(a) { const s = data().finance.removeSub(a.name); return s ? { ok: true, removed: s.name } : { ok: false, error: 'No subscription matching "' + a.name + '"' }; },
      label: (a) => {
        const f = data().finance, i = f.findSub(a.name);
        if (i === -1) return 'Remove subscription “' + a.name + '”';
        const s = f.subs()[i];
        return 'Remove subscription “' + s.name + '” (' + eur(s.amount) + ' / ' + String(s.period || 'monthly').replace(/ly$/, '') + ')';
      },
    },
    set_account_balance: {
      confirm: true,
      decl: { description: 'Change a net-worth account balance: either set a new amount or apply a delta (e.g. -45.20 for a purchase, +1500 salary).', parameters: obj({ account: str('Account name'), amount: num('New balance in EUR'), delta: num('Change in EUR'), category: str('', { enum: ['bank', 'stocks', 'crypto', 'other'] }) }, ['account']) },
      async run(a) {
        if (a.amount == null && a.delta == null) return { ok: false, error: 'Give amount or delta' };
        const r = data().finance.setBalance(a.account, { amount: a.amount, delta: a.delta, category: a.category });
        return r ? Object.assign({ ok: true }, r) : { ok: false, error: 'No account matching "' + a.account + '"' };
      },
      label: (a) => {
        const hit = data().finance.findAccount(a.account, a.category);
        const name = hit ? hit.items[hit.idx].name : a.account;
        if (a.amount != null) return 'Set ' + name + ' balance to ' + eur(a.amount);
        return (Number(a.delta) >= 0 ? 'Add ' : 'Subtract ') + eur(Math.abs(a.delta)) + (Number(a.delta) >= 0 ? ' to ' : ' from ') + name;
      },
    },
    add_account: {
      confirm: true,
      decl: { description: 'Add a new net-worth account.', parameters: obj({ category: str('', { enum: ['bank', 'stocks', 'crypto', 'other'] }), name: str(''), amount: num('Current balance EUR') }, ['category', 'name', 'amount']) },
      async run(a) { return Object.assign({ ok: true }, data().finance.addAccount(a.category, a.name, a.amount)); },
      label: (a) => 'Add ' + a.category + ' account ' + a.name + ' (' + eur(a.amount) + ')',
    },
    add_wishlist_item: {
      decl: { description: 'Add something to the finance wishlist.', parameters: obj({ name: str(''), amount: num('EUR') }, ['name', 'amount']) },
      async run(a) { return { ok: true, item: data().finance.addWish(a.name, a.amount) }; },
      label: (a) => 'Wishlist · ' + a.name + ' ' + eur(a.amount),
    },
    add_incoming_order: {
      decl: { description: 'Track an order/purchase that is on its way.', parameters: obj({ name: str(''), amount: num('EUR'), arrival_date: str('YYYY-MM-DD'), from_account: str('') }, ['name', 'amount']) },
      async run(a) { return { ok: true, order: data().finance.addOrder({ name: a.name, amount: a.amount, date: a.arrival_date ? normDate(a.arrival_date) : null, fromAccount: a.from_account }) }; },
      label: (a) => 'Order · ' + a.name + ' ' + eur(a.amount) + (a.arrival_date ? ' — arrives ' + nice(a.arrival_date) : ''),
    },
    log_caffeine: {
      decl: { description: 'Log caffeine the user just had (only when they tell you — Apple Health syncs the rest automatically).', parameters: obj({ mg: num('Milligrams'), time: str('HH:MM today, default now'), label: str('e.g. "double espresso"') }, ['mg']) },
      async run(a) {
        let ts = Date.now();
        const t = normTime(a.time);
        if (t) { const d = new Date(); d.setHours(Math.floor(D.timeToMin(t) / 60), D.timeToMin(t) % 60, 0, 0); ts = d.getTime(); }
        data().caffeine.add(a.mg, ts, a.label);
        return { ok: true, today_total_mg: data().caffeine.todayTotal(), active_now_mg: data().caffeine.activeNow() };
      },
      label: (a) => 'Caffeine · ' + Math.round(a.mg) + ' mg' + (a.label ? ' (' + a.label + ')' : ''),
    },
    add_google_task: {
      decl: { description: 'Add a task to Google Tasks (only if the user explicitly wants it in Google Tasks).', parameters: obj({ title: str(''), notes: str(''), due_date: str('YYYY-MM-DD') }, ['title']) },
      async run(a) {
        if (!EFI.google || !(await EFI.google.isConnected())) return { ok: false, error: 'Google is not connected.' };
        const t = await EFI.google.createTask({ title: a.title, notes: a.notes, due: a.due_date ? normDate(a.due_date) : null });
        return { ok: true, id: t.id };
      },
      label: (a) => 'Google Task · ' + a.title,
    },
    list_google_tasks: {
      decl: { description: 'Read open Google Tasks.' },
      async run() {
        if (!EFI.google || !(await EFI.google.isConnected())) return { ok: false, error: 'Google is not connected.' };
        return { tasks: (await EFI.google.listTasks()).slice(0, 60) };
      },
      silent: true,
    },
    open_page: {
      decl: { description: 'Open one of the dashboard modules after replying. "routines" = habits, shift templates and the time-block planner.', parameters: obj({ page: str('', { enum: ['calendar', 'energy', 'finance', 'health', 'fitness', 'mealprep', 'routines'] }) }, ['page']) },
      async run(a) {
        const map = { calendar: 'calendar.html', energy: 'health.html', finance: 'finance.html', health: 'health.html', fitness: 'gym.html', mealprep: 'mealprep.html', routines: 'main.html', planner: 'main.html' };
        return map[a.page] ? { ok: true, navigate: map[a.page] } : { ok: false };
      },
      silent: true,
    },
  };

  async function snapshotEvent(id) {
    try {
      const from = D.dateKey(D.addDays(new Date(), -30)), to = D.dateKey(D.addDays(new Date(), 180));
      const r = await data().calendar.range(from, to, { cachedOnly: false });
      return r.items.find((x) => x.id === id) || null;
    } catch (e) { return null; }
  }

  function compactItem(x) {
    const o = { id: x.id, date: x.dateKey, title: x.title, kind: x.source };
    if (x.allDay) o.allDay = true; else { o.start = x.start; o.end = x.end; }
    if (x.done) o.done = true;
    if (x.location) o.location = x.location;
    return o;
  }

  // ---------- live context snapshot ----------
  async function buildContext() {
    const now = new Date();
    const today = D.activeDateKey(), tomorrow = D.tomorrowDateKey();
    const ctx = {
      now: now.toString().slice(0, 24), timezone: D.tz, today, tomorrow,
      weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
      user: EFI.settings.get().userName,
      profile: (() => { const p = EFI.profile.get(); return { heightCm: p.heightCm, weightKg: p.weightKg, age: p.age, sex: p.sex }; })(),
    };

    try {
      const r = await data().calendar.range(D.dateKey(D.addDays(now, -1)), D.dateKey(D.addDays(now, 14)));
      ctx.google = r.google.connected ? 'connected' : (r.google.configured ? 'not connected' : 'not set up');
      ctx.calendar_next_14_days = r.items.slice(0, 140).map(compactItem);
      ctx.unscheduled_tasks = {};
      [today, tomorrow].forEach((k) => { if (r.inbox[k]) ctx.unscheduled_tasks[k] = r.inbox[k]; });
    } catch (e) { ctx.calendar_error = String(e.message || e); }

    ctx.habits = data().habits.list().filter((h) => h.active).map((h) => ({ text: h.text, days: h.days, window: h.preferredWindow }));

    const f = data().finance;
    ctx.finance = {
      currency: 'EUR',
      net_worth: Math.round(f.netWorth() * 100) / 100,
      accounts: f.accounts(),
      subscriptions: f.subs().map((s) => { const n = f.nextRenewal(s.renewal, s.period); return { name: s.name, amount: s.amount, period: s.period, per_month: Math.round(f.monthlyEquivalent(s) * 100) / 100, next_renewal: n ? D.dateKey(n) : null, paid_from: s.fromAccount || null }; }),
      subscriptions_per_month: Math.round(f.subs().reduce((a, s) => a + f.monthlyEquivalent(s), 0) * 100) / 100,
      wishlist: f.wishlist().map((w) => ({ name: w.name, amount: w.amount })),
      orders_pending: f.orders().filter((o) => !o.deductedAt).map((o) => ({ name: o.name, amount: o.amount, arrives: o.date })),
      recent_activity: (S.get('nw:activity', []) || []).slice(-8),
    };

    ctx.notes_recent = data().notes.list().slice(0, 15).map((n) => ({ id: n.id, title: n.title, text: n.text.slice(0, 160) }));

    const health = {};
    try {
      const ah = window.AppleHealth ? await window.AppleHealth.get() : null;
      const L = ah && ah.latest;
      if (L) {
        health.synced = ah.updatedAt;
        if (L.sleep) health.sleep = { asleep_min: L.sleep.asleepMin, deep_min: L.sleep.deepMin, rem_min: L.sleep.remMin, bed: L.sleep.sleepStart, wake: L.sleep.sleepEnd };
        ['hrv', 'rhr', 'steps', 'activeKcal', 'exerciseMin'].forEach((k) => { if (L[k] != null) health[k] = Math.round(L[k]); });
        if (L.nutrition && L.nutrition.calories != null) health.nutrition_today = L.nutrition;
        if (Array.isArray(L.caffeine)) data().caffeine.setAppleSamples(L.caffeine);
      }
    } catch (e) {}
    health.caffeine_today_mg = data().caffeine.todayTotal();
    health.caffeine_active_now_mg = data().caffeine.activeNow();
    try {
      if (window.EnergyModel) {
        const ectx = await window.EnergyModel.computeContext();
        const h = window.EnergyModel.nowHour();
        health.energy_now = Math.round(window.EnergyModel.energyAt(h, ectx, true));
        health.energy_next_hours = [1, 2, 3, 4, 6, 8].map((d) => ({ time: D.minToTime(((h + d) % 24) * 60), energy: Math.round(window.EnergyModel.energyAt(h + d, ectx, true)) }));
        health.typical_wake = window.EnergyModel.fmtClock(ectx.wakeHour);
        health.typical_bed = window.EnergyModel.fmtClock(ectx.bedHour);
      }
    } catch (e) {}
    ctx.health = health;

    const week = S.get('mealprep:weekplan:current', null);
    if (week && Array.isArray(week.days)) {
      const dayName = now.toLocaleDateString('en-US', { weekday: 'short' });
      const d = week.days.find((x) => x.day === dayName);
      if (d) ctx.meals_today = d.meals.map((m) => m.title);
    }
    const weights = S.get('po_coach_weights', []) || [];
    if (Array.isArray(weights) && weights.length) ctx.bodyweight_recent = weights.slice(-5);

    return ctx;
  }

  const SYSTEM = [
    'You are E.F.I. — Enhanced Functional Intelligence — the personal operating system inside {name}\'s Second Brain dashboard. Think JARVIS: calm, precise, quietly witty, fiercely useful.',
    'You can see a live snapshot of their calendar (Google Calendar + planner time blocks + work/uni blocks + bill renewals), tasks, habits, notes, finances (EUR), health (Apple Health sleep/HRV/steps/nutrition, caffeine) and an energy forecast. You can change things with tools.',
    'Rules:',
    '- When asked to change, plan, schedule, log or remember something: DO it with tools, then confirm briefly. Don\'t just give advice.',
    '- Resolve relative dates ("Friday", "next week", "tonight") from the snapshot\'s now/today. Tool times are 24h HH:MM.',
    '- Before placing anything on the calendar, check the snapshot for conflicts and pick a free slot. Put demanding work in high-energy windows, admin/errands in dips, and never schedule into sleep.',
    '- Events = appointments / fixed commitments (Google Calendar). Tasks = to-dos in the planner, optionally time-blocked with start_time. Planning a day usually means time-blocking tasks.',
    '- Deletes and money changes need the user\'s approval — just call the tool; the app shows them a confirm button. If they decline, acknowledge and move on.',
    '- Default durations: events 60 min, tasks 30 min. If something essential is missing and can\'t be sensibly inferred, ask ONE short question.',
    '- Caffeine guide: espresso 63mg, double 126, filter coffee 95/cup, latte/cappuccino 63–126, black tea 47, green tea 28, cola 34/330ml, Red Bull 80/250ml, Monster 160, pre-workout ~200.',
    '- Never invent data that isn\'t in the snapshot or a tool result.',
    'Style: lead with the answer. 1–4 short sentences or a few "- " bullets. **Bold** key names, times and amounts. No filler, no restating the question. Money in €.',
  ].join('\n');

  // ---------- conversation ----------
  function loadHistory() { const h = S.get(HISTORY_LS, []); return Array.isArray(h) ? h : []; }
  function saveHistory(h) {
    // Trim from the front, but only cut at a plain user-text turn so a
    // functionCall is never separated from its functionResponse.
    let start = Math.max(0, h.length - MAX_HISTORY);
    while (start < h.length && !(h[start].role === 'user' && h[start].parts && h[start].parts[0] && typeof h[start].parts[0].text === 'string')) start++;
    S.set(HISTORY_LS, h.slice(start));
  }

  async function send(text, ui) {
    ui = ui || {};
    const history = loadHistory();
    const baseLen = history.length;
    history.push({ role: 'user', parts: [{ text: String(text) }] });
    const system = SYSTEM.replace('{name}', EFI.settings.get().userName || 'the user') + '\n\nLIVE SNAPSHOT (JSON):\n' + JSON.stringify(await buildContext());
    const declarations = Object.keys(TOOLS).map((name) => Object.assign({ name }, TOOLS[name].decl));
    const actions = [];
    let navigate = null;

    try {
      let pinned = null;
      for (let step = 0; step < 8; step++) {
        // The first call may fall back to another model if Gemini is busy;
        // after that the turn stays on the model that answered, because its
        // thought signatures in the history are only valid for that model.
        const r = await EFI.ai.generate({ system, contents: history, tools: declarations, temperature: 0.4, signal: ui.signal, model: pinned, pinModel: !!pinned });
        pinned = r.model;
        history.push(r.content); // verbatim — preserves Gemini thought signatures
        if (!r.calls.length) {
          saveHistory(history);
          return { text: r.text.trim() || 'Done.', actions, navigate };
        }
        if (r.text && ui.onInterim) ui.onInterim(r.text);
        const responses = [];
        for (const call of r.calls) {
          const tool = TOOLS[call.name];
          const args = call.args || {};
          let result;
          if (!tool) result = { ok: false, error: 'Unknown tool ' + call.name };
          else {
            // Label first — after e.g. a removal the item can't be looked up anymore.
            let label = call.name;
            try { if (tool.label) label = tool.label(args); } catch (e) {}
            let approved = true;
            if (tool.confirm) approved = ui.confirm ? await ui.confirm(label, call.name, args) : false;
            if (!approved) result = { ok: false, cancelled: true, message: 'The user declined this action.' };
            else {
              try { result = await tool.run(args); } catch (e) { result = { ok: false, error: e.message || String(e) }; }
              if (result && result.navigate) navigate = result.navigate;
              if (!tool.silent) {
                const entry = { name: call.name, label, ok: result && result.ok !== false, error: result && result.error };
                actions.push(entry);
                if (ui.onAction) ui.onAction(entry);
              }
            }
          }
          const part = { functionResponse: { name: call.name, response: result || { ok: true } } };
          if (call.id) part.functionResponse.id = call.id;
          responses.push(part);
        }
        history.push({ role: 'user', parts: responses });
      }
      saveHistory(history);
      return { text: 'I\'ve taken several steps on that — check the results above.', actions, navigate };
    } catch (e) {
      // Drop the whole failed turn so a half-finished tool round can't
      // poison the next request (actions already run stay done).
      history.length = baseLen;
      saveHistory(history);
      throw e;
    }
  }

  EFI.agent = {
    send, buildContext,
    clearHistory() { S.del(HISTORY_LS); },
    tools: TOOLS,
  };
})();
