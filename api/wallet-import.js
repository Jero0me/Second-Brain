// ============================================================
// POST /api/wallet-import
// Authorization: Bearer <WALLET_IMPORT_SECRET>
// Body (JSON), sent by an iOS Shortcuts "Transaction" automation each
// time you pay with Apple Pay (SETUP.md §7):
//   { "merchant": "Lidl", "amount": "€12,50", "card": "Revolut", "name": "…" }
//
// Appends the payment to Supabase (public.app_state, key 'wallet') —
// the same server-written row pattern as the Apple Health import. The
// Finance page reads that row; categories are added there by Gemini
// (the Gemini key lives on your devices, never on the server).
//
// `amount` may be a number or whatever text Wallet hands the shortcut
// ("12.50", "12,50 €", "CHF 1'234.50") — it is parsed here.
//
// Env vars required on Vercel:
//   WALLET_IMPORT_SECRET        — shared secret, also pasted into the shortcut.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — already set (SETUP.md §2).
// ============================================================

const ROW_KEY = 'wallet';
const KEEP_DAYS = 400;      // payments older than this are dropped
const MAX_TX = 2000;
const DEDUPE_MS = 90 * 1000; // a retried shortcut run must not log the payment twice

// "€1.234,56" / "$1,234.56" / "12,5" / 12.5 → 1234.56 / 1234.56 / 12.5 / 12.5
export function parseAmount(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  const neg = s.indexOf('-') !== -1;
  s = s.replace(/-/g, '');
  const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
  if (dot !== -1 && comma !== -1) {
    // Both present: whichever comes last is the decimal mark.
    s = dot > comma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (comma !== -1) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return isFinite(n) ? (neg ? -n : n) : null;
}

const SYMBOLS = { '€': 'EUR', '$': 'USD', '£': 'GBP', '¥': 'JPY' };
export function parseCurrency(v, explicit) {
  if (typeof explicit === 'string' && /^[A-Za-z]{3}$/.test(explicit.trim())) return explicit.trim().toUpperCase();
  if (typeof v !== 'string') return 'EUR';
  const code = v.match(/\b([A-Z]{3})\b/);
  if (code) return code[1];
  for (const sym in SYMBOLS) if (v.indexOf(sym) !== -1) return SYMBOLS[sym];
  return 'EUR';
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const secret = process.env.WALLET_IMPORT_SECRET;
  if (!secret) return res.status(500).json({ error: 'server not configured (missing WALLET_IMPORT_SECRET)' });

  const auth = req.headers.authorization || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (given !== secret) return res.status(401).json({ error: 'unauthorized' });

  const supabaseUrl = process.env.SUPABASE_URL;
  // No signed-in user on a webhook, so it writes with the service-role key
  // (server env only). Falls back to the anon key for unlocked setups.
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'server not configured (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' });
  const sbHeaders = { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey, 'Content-Type': 'application/json' };

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const parsed = parseAmount(body.amount);
  if (parsed == null || parsed === 0) return res.status(400).json({ error: 'no amount in payload', got: body.amount == null ? null : String(body.amount).slice(0, 40) });
  const amount = Math.round(Math.abs(parsed) * 100) / 100;
  // Wallet sometimes leaves Merchant empty and only fills the transaction name.
  const merchant = clean(body.merchant, 80) || clean(body.name, 80) || 'Unknown merchant';
  const now = Date.now();
  let ts = typeof body.date === 'string' ? Date.parse(body.date) : NaN;
  if (isNaN(ts) || Math.abs(ts - now) > 7 * 864e5) ts = now;

  const tx = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 7),
    ts,
    merchant,
    amount,
    currency: parseCurrency(body.amount, body.currency),
    card: clean(body.card, 40) || null,
  };

  // Read-modify-write, made safe for two payments arriving at once: the
  // write only lands if the row is still the version we read (updated_at);
  // otherwise re-read and try again, so neither payment is lost.
  const cutoff = now - KEEP_DAYS * 864e5;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      let row = null;
      const r = await fetch(supabaseUrl + '/rest/v1/app_state?key=eq.' + ROW_KEY + '&select=data,updated_at', { headers: sbHeaders });
      if (r.ok) { const rows = await r.json(); row = (rows && rows[0]) || null; }
      else if (attempt === 4) return res.status(500).json({ error: 'supabase read failed: ' + (await r.text()) });
      else continue;

      const list = row && row.data && Array.isArray(row.data.tx) ? row.data.tx : [];
      const dupe = list.find((x) => x && x.merchant === tx.merchant && x.amount === tx.amount && Math.abs(x.ts - tx.ts) < DEDUPE_MS);
      if (dupe) return res.status(200).json({ ok: true, duplicate: true, id: dupe.id });
      const next = list.filter((x) => x && x.ts >= cutoff).concat(tx).sort((a, b) => a.ts - b.ts).slice(-MAX_TX);
      const body = JSON.stringify(Object.assign(row ? {} : { key: ROW_KEY }, { data: Object.assign({}, row && row.data, { tx: next }), updated_at: new Date().toISOString() }));

      const w = row
        ? await fetch(supabaseUrl + '/rest/v1/app_state?key=eq.' + ROW_KEY + '&updated_at=eq.' + encodeURIComponent(row.updated_at), {
          method: 'PATCH', headers: Object.assign({ Prefer: 'return=representation' }, sbHeaders), body })
        : await fetch(supabaseUrl + '/rest/v1/app_state', {
          method: 'POST', headers: Object.assign({ Prefer: 'return=representation' }, sbHeaders), body });

      if (w.status === 409) continue; // the row was created in between — read it and retry
      if (!w.ok) {
        const text = await w.text();
        const hint = /row-level security|42501/i.test(text) && !process.env.SUPABASE_SERVICE_ROLE_KEY
          ? ' — the table is locked to the owner; set SUPABASE_SERVICE_ROLE_KEY in Vercel (SETUP.md §2).' : '';
        return res.status(500).json({ error: 'supabase write failed: ' + text + hint });
      }
      const written = await w.json().catch(() => []);
      if (Array.isArray(written) && written.length === 0) continue; // changed since we read it
      return res.status(200).json({ ok: true, id: tx.id, merchant: tx.merchant, amount: tx.amount, currency: tx.currency, stored: next.length });
    }
    return res.status(503).json({ error: 'busy — too many payments at once, try again' });
  } catch (e) {
    return res.status(500).json({ error: 'unexpected error: ' + (e && e.message ? e.message : String(e)) });
  }
}
