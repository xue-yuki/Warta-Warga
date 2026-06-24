import axios from 'axios';
import { config } from '../config.js';
import { hasBrowser, browserSearch } from './browser.js';

// Client Bright Data (free tier): satu endpoint `POST /request`, beda `zone`.
//  - SERP API  : cari di Google, balikin JSON hasil organik (untuk discovery sumber daerah).
//  - Web Unlocker : render halaman (termasuk JS + anti-bot) → HTML mentah (untuk halaman dinamis).
// Token & zone diisi via env (lihat .env). Patuh F1.1 tetap di pemanggil (disaring whitelist .go.id).

const ENDPOINT = 'https://api.brightdata.com/request';

export const hasBrightData = () => Boolean(config.brightdata.token);

async function bdRequest(zone, url, { timeout = 60000 } = {}) {
  const res = await axios.post(
    ENDPOINT,
    { zone, url, format: 'raw' },
    {
      headers: { Authorization: `Bearer ${config.brightdata.token}`, 'Content-Type': 'application/json' },
      timeout,
      // Web Unlocker bisa balikin HTML besar; jangan dibatasi parser axios.
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    },
  );
  return res.data;
}

/** SERP: cari query di Google → daftar URL hasil organik. */
export async function bdSerp(query, { num = 20 } = {}) {
  // Browser mode (Scraping Browser): buka Google langsung lewat Playwright.
  if (hasBrowser()) return browserSearch(query, { limit: num });
  // REST mode (SERP API zone).
  if (!config.brightdata.serpZone) return [];
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&brd_json=1&num=${num}&gl=id&hl=id`;
  const data = await bdRequest(config.brightdata.serpZone, url, { timeout: 30000 });
  const parsed = typeof data === 'string' ? safeJson(data) : data;
  const organic = parsed?.organic || parsed?.organic_results || [];
  return organic.map((o) => o.link || o.url || o.href).filter(Boolean);
}

/** Web Unlocker: ambil HTML sebuah halaman (render JS) → string HTML, atau null bila gagal. */
export async function bdUnlock(url, { timeout = 60000 } = {}) {
  if (!config.brightdata.unlockerZone) return null;
  const data = await bdRequest(config.brightdata.unlockerZone, url, { timeout });
  if (typeof data === 'string') return data;
  return data?.body || (data ? JSON.stringify(data) : null);
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
