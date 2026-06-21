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
