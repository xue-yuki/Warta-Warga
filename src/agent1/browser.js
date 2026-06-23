import { chromium } from 'playwright-core';
import { config } from '../config.js';

// Bright Data Scraping Browser: Chromium REMOTE yang kita kendalikan via Playwright (CDP over wss).
// Browser-nya jalan di server Bright Data (anti-bot/CAPTCHA/proxy ditangani otomatis), jadi tak
// perlu unduh Chromium lokal. Dipakai untuk: (1) buka Google & ambil hasil, (2) render halaman JS.

export const hasBrowser = () => Boolean(config.brightdata.browserWss);

/** Konek ke browser remote, jalankan fn(page), selalu tutup koneksi. */
async function withPage(fn, { timeout = 60000 } = {}) {
  const browser = await chromium.connectOverCDP(config.brightdata.browserWss, { timeout });
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(timeout);
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Buka Google, ketik query, kumpulkan URL hasil organik. */
export async function browserSearch(query, { limit = 10 } = {}) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${limit + 5}&gl=id&hl=id`;
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Ambil semua link hasil; saring nanti di pemanggil (whitelist .go.id).
    const links = await page.evaluate(() => {
      const out = [];
      // Hasil organik Google: <a> yang punya <h3> di dalamnya.
      document.querySelectorAll('a').forEach((a) => {
        if (a.querySelector('h3') && a.href) out.push(a.href);
      });
      return out;
    });
    return links;
  });
}

/** Buka sebuah URL, tunggu render JS, kembalikan HTML jadinya. */
export async function browserFetch(url) {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    return page.content();
  });
}

// --- Browser LOKAL (Chrome/Edge terinstal) untuk render halaman SPA .go.id. ---
// Bright Data memblokir domain Government (.go.id), tapi IP rumah pengguna bisa mengaksesnya.
// Jadi untuk halaman .go.id yang butuh JavaScript, kita render pakai browser lokal pengguna.
let _localChannel; // cache channel yang berhasil ('chrome' | 'msedge'); '' = tidak ada.

/** Render URL via Chrome/Edge lokal headless. Best-effort: null jika tak ada browser/ gagal. */
export async function localFetch(url, { timeout = 45000 } = {}) {
  const channels = _localChannel ? [_localChannel] : ['chrome', 'msedge'];
  for (const channel of channels) {
    let browser;
    try {
      browser = await chromium.launch({ channel, headless: true });
    } catch {
      continue; // channel ini tidak terpasang → coba berikutnya
    }
    _localChannel = channel;
    try {
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(timeout);
      await page.goto(url, { waitUntil: 'networkidle' });
      return await page.content();
    } catch {
      return null; // gagal render (mis. 404/timeout) → biar pemanggil yang putuskan
    } finally {
      await browser.close().catch(() => {});
    }
  }
  _localChannel = ''; // tak ada browser lokal sama sekali
  return null;
}

/** Apakah ada browser lokal (Chrome/Edge) yang bisa dipakai render? */
export const hasLocalBrowser = () => _localChannel !== '';
