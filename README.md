# E.F.I. — Enhanced Functional Intelligence

Jerome's second brain: a set of small, self-contained HTML apps with one AI assistant on top.
E.F.I. runs on **Google Gemini**, syncs with **Google Calendar / Google Tasks**, and can change
anything in the dashboard by chat or voice — calendar, plans, notes, finances, subscriptions.

Setup (Vercel, Supabase, Gemini key, Google OAuth, Apple Health, Hevy): **[SETUP.md](SETUP.md)**.

| File | What it is |
|---|---|
| [index.html](index.html) | **E.F.I.** — the assistant (JARVIS-style home: chat, voice, daily briefing, notes, settings) |
| [calendar.html](calendar.html) | Calendar — day timeline, week, month; merges Google Calendar, planner time-blocks, shift templates, bill renewals, orders |
| [main.html](main.html) | Routines — habits, shift templates, time-blocking grid, AI Auto-schedule (daily setup itself runs everywhere via `EFI.data.daily`) |
| [health.html](health.html) | Health — energy gauge + today's call, body map (Apple Watch vitals with 7-day trends around a front/back figure, tap to log headaches/soreness/pain; E.F.I. explains the likely cause), energy curve & windows, day-vs-energy, sleep, caffeine (`energy.html` redirects here) |
| [gym.html](gym.html) | Fitness — read-only view: MacroFactor calories & macros vs targets (via Apple Health), Hevy workouts (week, last workout + PRs, sets per muscle, e1RM progress per lift, history), body weight, progress photos |
| [finance.html](finance.html) | Finance (EUR) — **Money**: net worth, accounts, this month vs budget, all transactions (Apple Pay logged automatically by an iOS Shortcut + expenses you add; Gemini sorts categories) · **Insights**: spending pace vs last month, categories vs budgets, habits, top places, savings rate, E.F.I. review · **Bills**: subscriptions with auto-pay · **Wishlist**: savings goals + orders on the way |
| [mealprep.html](mealprep.html) | Recipes, fridge, AI chef, weekly meal plan |

Shared code:

| File | Role |
|---|---|
| [efi-auth.js](efi-auth.js) | Sign-in gate + the one shared, signed-in Supabase client |
| [efi-core.js](efi-core.js) | Storage/date helpers, profile, settings, icons, the **Gemini** client |
| [efi-google.js](efi-google.js) | Google Calendar + Tasks client (tokens from `/api/google`) |
| [efi-data.js](efi-data.js) | One data API over every module + the unified calendar |
| [efi-agent.js](efi-agent.js) | E.F.I.'s Gemini function-calling tools and conversation loop |
| [efi-theme.css](efi-theme.css) | The E.F.I. look, applied to every page |
| [topbar.js](topbar.js) | App shell — theme injection, bottom navigation, toasts |
| [sync.js](sync.js) | Supabase cross-device sync (multi-row) |
| [energy.js](energy.js) | Circadian + sleep-pressure + caffeine energy model |
| [applehealth.js](applehealth.js) | Reader for the Apple Health snapshot |
| [hevy.js](hevy.js) | Reader for the Hevy workout snapshot + lift maths (e1RM, volume, PRs, muscle sets) |
| [wallet.js](wallet.js) | Reader for the Apple Pay payment feed + Gemini categories + monthly sums |
| [api/](api) | Vercel functions: config, Apple Health import, Hevy sync, Apple Pay import, Google OAuth |
