# E.F.I. — Setup Guide

**E.F.I. (Enhanced Functional Intelligence)** is a static dashboard (plain HTML/JS) that deploys on
**Vercel**, syncs across your devices with **Supabase**, thinks with **Google Gemini**, and reads/writes
your **Google Calendar + Google Tasks**. Apple Health (sleep, HRV, MyFitnessPal nutrition, caffeine) is an
optional add-on.

---

## 1. Fork & deploy

1. **Fork** this repo to your GitHub.
2. Go to **vercel.com → Add New → Project → Import** your fork.
3. Framework Preset: **Other**. Root Directory: **`./`**. Build/output: leave blank (static).
4. **Deploy.** You'll get a URL like `https://your-app.vercel.app`.

> ⚠️ There is **no login** on the site, and the Supabase table is readable/writable with the public
> key (see §2). Anyone who finds your URL can see your data — keep the URL private, and see
> "Security" at the bottom for the proper fix.

---

## 2. Supabase (cross-device sync) — required for sync

Create a free project at **supabase.com**, then run these SQL blocks in
**SQL Editor → New query → Run**.

### SQL #1 — `app_state` (all dashboard sync)
```sql
create table if not exists public.app_state (
  key        text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- The browser uses the ANON key, so allow it to read/write:
alter table public.app_state enable row level security;
create policy "anon full access app_state"
  on public.app_state for all
  to anon using (true) with check (true);

-- Instant cross-device updates:
alter publication supabase_realtime add table public.app_state;
```

Rows used: `goals` (planner), `finance`, `health` (supplements), `mealprep`, `efi` (profile, notes,
E.F.I. calendar events, manually logged caffeine, settings), `po-coach` (fitness), `apple_health`
(written by the server). API keys and Google logins are **never** stored here.

### SQL #2 — progress-photo sync (Storage bucket)
```sql
insert into storage.buckets (id, name, public)
values ('progress-photos', 'progress-photos', true)
on conflict (id) do nothing;

create policy "anon manage progress-photos"
  on storage.objects for all
  to anon
  using (bucket_id = 'progress-photos')
  with check (bucket_id = 'progress-photos');
```

### SQL #3 — meal-prep recipe photos (Storage bucket)
```sql
insert into storage.buckets (id, name, public)
values ('meal-photos', 'meal-photos', true)
on conflict (id) do nothing;

create policy "anon manage meal-photos"
  on storage.objects for all
  to anon
  using (bucket_id = 'meal-photos')
  with check (bucket_id = 'meal-photos');
```

### Connect YOUR Supabase
Supabase → **Project Settings → API**. Copy the **Project URL** and the **anon / publishable** key and add
them in Vercel → **Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon / publishable key |

> Only the **anon** key (public) is used. **Never** put the `service_role` key in code or env vars.

---

## 3. Google Gemini (E.F.I.'s brain)

1. Open **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)**, sign in with your Google
   account, and **Create API key**.
2. Open the site → tap the **⚙ settings** icon on the E.F.I. home screen → paste the key → **Save**.
   The key is checked immediately and stays on that device only (paste it once on each device).
3. Model: leave on **Automatic** — E.F.I. picks the newest Gemini *Flash* model your key can use, so
   it keeps working when Google retires old model names. You can pin a specific model in the same menu.

> **About your Gemini subscription:** a Google AI Pro/Ultra (Gemini app) subscription and the
> **Gemini API** are billed separately — the subscription doesn't include API usage. The API has a
> free tier that easily covers personal use; if you hit its rate limit, enable billing on the key's
> Google Cloud project in AI Studio.

The same key powers every AI feature: the E.F.I. assistant, the planner's **Auto-schedule** and
**✨ Polish**, Meal Prep (recipe-screenshot reading, "what can I make?", weekly plan) and the fitness coach.

---

## 4. Google Calendar & Google Tasks

E.F.I. reads and edits your calendar and tasks through your own Google OAuth app. The login is kept in
an encrypted, HttpOnly cookie on each device (never in Supabase), so a device stays connected without
popups.

1. Go to **[console.cloud.google.com](https://console.cloud.google.com)** → create a project (e.g. "EFI").
2. **APIs & Services → Library** → enable **Google Calendar API** and **Google Tasks API**.
3. **APIs & Services → OAuth consent screen** → User type **External** → fill in the app name (E.F.I.)
   and your email → add the scopes `.../auth/calendar.events`,
   `.../auth/calendar.calendarlist.readonly`, `.../auth/tasks` → add yourself as a test user.
4. **Publishing status → Publish app** ("In production"). You don't need Google's verification for
   personal use — you'll see an "unverified app" warning once when connecting; click
   *Advanced → Go to E.F.I.*. ⚠️ If you leave the app in **Testing**, Google expires the connection
   every **7 days**.
5. **Credentials → Create credentials → OAuth client ID** → *Web application*:
   - Authorized redirect URI: `https://your-app.vercel.app/api/google-callback`
6. Add to Vercel → **Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | the OAuth client secret |
| `EFI_COOKIE_SECRET` | *(optional)* any long random string used to encrypt the login cookie |

7. On each device: E.F.I. settings → **Connect Google**. Pick which calendars to show.

Once connected, events you create by chat or in the Calendar go to Google Calendar; without Google
they're kept in E.F.I.'s own (synced) calendar. Planner time-blocks, work/uni shift templates,
subscription renewals and incoming orders all appear in the Calendar too, and Auto-schedule never
books over a Google event.

---

## 5. Apple Health — sleep, vitals, MyFitnessPal, caffeine (optional)

There's no public Apple Health API a website can call directly — the **Health Auto Export – JSON+CSV**
iOS app pushes your data to the dashboard on a schedule. No login involved; it's a one-way webhook.

1. Pick a shared secret (any random string) and add it in Vercel, then redeploy:

| Variable | Value |
|---|---|
| `HEALTH_IMPORT_SECRET` | any random string you choose |

2. On your iPhone, install **Health Auto Export – JSON+CSV**.
3. Create a new **REST API** automation:
   - URL: `https://your-app.vercel.app/api/health-import`
   - Method: `POST`
   - Header: `Authorization: Bearer <the HEALTH_IMPORT_SECRET value>`
   - Metrics: Heart Rate Variability, Resting Heart Rate, Respiratory Rate, Blood Oxygen Saturation,
     Active Energy, Step Count, Apple Exercise Time, Sleep Analysis, **Dietary Caffeine**,
     Dietary Energy, Protein, Carbohydrates, Total Fat.
   - Turn **off** "Aggregate data" (at least for caffeine) so every drink keeps its own timestamp —
     the energy curve uses the time you had it.
4. Turn the automation on (e.g. every 1–2 hours, or every morning at minimum).

### MyFitnessPal
MFP → **More → Settings → Sharing & Privacy → HealthKit** → allow it to write nutrition. Calories and
macros then flow MFP → Apple Health → dashboard (Fitness page Calories card, E.F.I.).

### Caffeine (automatic)
The old manual Caffeine page is gone. Caffeine now comes in automatically from Apple Health's
**Dietary Caffeine** — whatever app writes it. Note that **MyFitnessPal does not export caffeine to
Apple Health**, so pick one of these:
- log drinks in an app that writes caffeine to Health (e.g. a caffeine tracker, or Apple Health itself), or
- make an iOS **Shortcut** "Log espresso" → *Log Health Sample: Caffeine 63 mg* and put it on your
  home screen / Action button, or
- just tell E.F.I.: *"had a double espresso"* — it logs the right amount.

Every source feeds the same energy model used by the Day Ring and Auto-schedule.

---

## 6. Put E.F.I. on your iPhone

Open the site in **Safari** → Share → **Add to Home Screen**. It launches full-screen straight into the
E.F.I. assistant (tap the mic to talk, or type), with Calendar, Planner, Health and Fitness in the bottom bar.

---

## Security (read this)

- The dashboard has **no login**, and the Supabase policy above lets anyone holding the public anon key
  (which ships in the page source) read and write every row — including finances and health data.
  Keep the URL private. The proper fix is **Supabase Auth + per-user RLS** (e.g. "Sign in with Google"
  via Supabase, then `using (auth.uid() = owner)` policies) — worth doing before sharing the URL.
- Gemini keys and Google logins are deliberately kept **out** of Supabase for this reason.

## TL;DR
1. Fork → import to Vercel → deploy.
2. Supabase: run the SQL → set `SUPABASE_URL` + `SUPABASE_ANON_KEY`.
3. Gemini key from AI Studio → paste in E.F.I. settings.
4. Google OAuth client → `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` → Connect Google.
5. (Optional) Apple Health: `HEALTH_IMPORT_SECRET` + Health Auto Export automation.
6. Add to Home Screen.
