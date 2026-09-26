# E.F.I. — Enhanced Functional Intelligence

Jerome's second brain: a set of small, self-contained HTML apps with one AI assistant on top.
E.F.I. runs on **Google Gemini**, syncs with **Google Calendar / Google Tasks**, and can change
anything in the dashboard by chat or voice — calendar, plans, notes, finances, subscriptions.

Setup (Vercel, Supabase, Gemini key, Google OAuth, Apple Health): **[SETUP.md](SETUP.md)**.

| File | What it is |
|---|---|
| [index.html](index.html) | **E.F.I.** — the assistant (JARVIS-style home: chat, voice, daily briefing, notes, settings) |
| [calendar.html](calendar.html) | Calendar — day timeline, week, month; merges Google Calendar, planner time-blocks, shift templates, bill renewals, orders |
| [main.html](main.html) | Routines — habits, shift templates, time-blocking grid, AI Auto-schedule (daily setup itself runs everywhere via `EFI.data.daily`) |
| [health.html](health.html) | Health — energy gauge + today's call, body map (Apple Watch vitals with 7-day trends around a front/back figure, tap to log headaches/soreness/pain; E.F.I. explains the likely cause), energy curve & windows, day-vs-energy, sleep, caffeine (`energy.html` redirects here) |
| [gym.html](gym.html) | Progressive-overload gym tracker, bodyweight, calories (MyFitnessPal via Health) |
| [finance.html](finance.html) | Net worth, subscriptions, wishlist, incoming orders (EUR) |
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
| [api/](api) | Vercel functions: config, Apple Health import, Google OAuth |
