# Dashboard — Setup Guide (fork → deploy in ~5 min)

This is a static dashboard (plain HTML/JS) that deploys on **Vercel** and syncs across your
devices with **Supabase**. Apple Health sync is an optional add-on.

---

## 1. Fork & deploy

1. **Fork** this repo to your GitHub.
2. Go to **vercel.com → Add New → Project → Import** your fork.
3. Framework Preset: **Other**. Root Directory: **`./`**. Build/output: leave blank (static).
4. **Deploy.** You'll get a URL like `https://your-app.vercel.app`.

The dashboard opens to a **password screen** — the default password is in
[`lock.js`](lock.js) (`var PASSWORD = "qwer"`). Change it to whatever you want.

---

## 2. Supabase (cross-device sync) — required for sync

Create a free project at **supabase.com**, then run **both** SQL blocks in
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

### SQL #2 — progress-photo sync (Storage bucket)
Progress photos upload to a Supabase **Storage** bucket called `progress-photos` (only the
image URLs sync through `app_state`). Skip this if you don't need photos to sync across devices.
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

### Connect YOUR Supabase — pick ONE way
Supabase → **Project Settings → API**. Copy the **Project URL** and the **anon / publishable** key.

**Way A — Vercel env vars (easiest, no code edits):**
In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon / publishable key |

Redeploy. The app reads these automatically via `/api/config`.

**Way B — edit the files:**
Replace the old URL/key in these files:
- [`sync.js`](sync.js)
- [`topbar.js`](topbar.js)
- [`gym.html`](gym.html)

> ⚠️ Only the **anon** key (public) is used here. **Never** put the `service_role` key in code
> or in these env vars.

---

## 3. Apple Health (optional)

There's no public Apple Health API a website can call directly — instead, the free-ish
**Health Auto Export – JSON+CSV** iOS app pushes your data to this dashboard on a schedule.
No login/OAuth involved; it's a one-way webhook.

1. Pick a shared secret (any random string) and add it in Vercel → **Settings → Environment
   Variables**, then redeploy:

| Variable | Value |
|---|---|
| `HEALTH_IMPORT_SECRET` | any random string you choose — this is the shared secret |

2. On your iPhone, install **Health Auto Export – JSON+CSV** from the App Store.
3. Create a new **REST API** automation:
   - URL: `https://your-app.vercel.app/api/health-import`
   - Method: `POST`
   - Header: `Authorization: Bearer <the HEALTH_IMPORT_SECRET value>`
   - Metrics to include: Heart Rate Variability, Resting Heart Rate, Respiratory Rate,
     Blood Oxygen Saturation, Active Energy, Step Count, Apple Exercise Time, Sleep Analysis,
     Dietary Energy, Protein, Carbohydrates, Total Fat (the last four power the Calories card
     on the Fitness page — see §3a below if you also use MyFitnessPal).
4. Turn the automation on (e.g. run every morning). After it fires once, open the site →
   Health page — the Apple Health card fills in automatically. No connect button, no login.

> The dashboard reads the latest synced snapshot from Supabase (`app_state`, key
> `apple_health`) — the same table used for everything else, so no extra SQL is needed
> beyond the block in step 2 above.

### 3a. Calorie counting via MyFitnessPal (optional)

MyFitnessPal's API is closed to individual developers, so there's no direct "Connect your
MyFitnessPal account" flow — instead this rides the same Apple Health bridge as everything
else above.

1. In MyFitnessPal: **More → Settings → Sharing & Privacy → HealthKit Sharing** → turn it on.
   This makes MFP write your logged meals' calories and macros into Apple Health automatically.
2. Make sure your Health Auto Export automation (step 3 above) includes **Dietary Energy**,
   **Protein**, **Carbohydrates**, and **Total Fat**.
3. Open the site → Fitness page — the **Calories** card (right under Weight) fills in
   automatically after your next sync.

> **Caffeine does not sync this way** — MyFitnessPal explicitly excludes caffeine from its
> Apple Health export. Keep logging coffee/tea in this dashboard's own Caffeine page (it
> already has a full beverage database); there's no reliable path to pull that specifically
> from MyFitnessPal without using an unofficial/ToS-violating API.
>
> Field names for the nutrition metrics in `/api/health-import.js` are best-effort guesses at
> Health Auto Export's naming (`dietary_energy`, `protein`, `carbohydrates`, `total_fat`, etc.).
> If the Calories card stays empty after a sync that should have data, check the `debug` array
> in the Supabase `app_state` row (key `apple_health`) — it lists every metric name Health Auto
> Export actually sent, so field names can be corrected quickly if they don't match.

---

## 4. Nova (AI mentor / gym coach) — optional

No setup or key in the repo. Each user **pastes their own Anthropic API key** on the
**Nova** tile; it's stored only in their browser and sent straight to Anthropic. Get a key at
console.anthropic.com.

---

## TL;DR
1. Fork → import to Vercel → deploy.
2. New Supabase → run the **SQL** above → paste your **URL + anon key** into `sync.js`,
   `topbar.js`, `gym.html`.
3. (Optional) Apple Health: `HEALTH_IMPORT_SECRET` env var in Vercel + a Health Auto Export
   REST API automation on your iPhone pointed at `/api/health-import`.
4. Change the password in `lock.js`. Done.
