import { chromium } from 'playwright';
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
const LOCAL_SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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

export async function localSearch(query, { limit = 10, siteFocus = false, timeout = 30000 } = {}) {
  const q = siteFocus && !/\bsite:\S+/i.test(query) ? `${query} site:.go.id` : query;
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}&num=${Math.max(limit + 5, 10)}&gl=id&hl=id`;
  const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=id-ID&mkt=id-ID`;
  const channels = ['chrome', 'msedge', 'chromium'];

  async function extractGoogle(page) {
    const links = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('a').forEach((a) => {
        if (a.querySelector('h3') && a.href) out.push(a.href);
      });
      return Array.from(new Set(out));
    });
    return links;
  }

  async function extractBing(page) {
    const links = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('li.b_algo a').forEach((a) => {
        if (a.href) out.push(a.href);
      });
      return Array.from(new Set(out));
    });
    return links;
  }

  async function isGoogleBlocked(page) {
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    return /traffic that is unusual|traffic yang tidak wajar|Sistem kami telah mendeteksi|Our systems have detected unusual traffic|sorry\/index/i.test(bodyText);
  }

  async function runSearch(browser) {
    const context = await browser.newContext({
      userAgent: LOCAL_SEARCH_UA,
      extraHTTPHeaders: { 'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7' },
    });
    try {
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(timeout);
      await page.goto(googleUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      if (await isGoogleBlocked(page)) {
        await page.goto(bingUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
        return (await extractBing(page)).slice(0, limit);
      }
      const results = await extractGoogle(page);
      if (results.length) return results.slice(0, limit);
      await page.goto(bingUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      return (await extractBing(page)).slice(0, limit);
    } finally {
      await context.close().catch(() => {});
    }
  }

  for (const channel of channels) {
    let browser;
    try {
      browser = await chromium.launch({ channel, headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    } catch {
      continue;
    }

    try {
      const links = await runSearch(browser);
      if (links.length) return links;
    } catch {
      // ignore and try next browser channel
    } finally {
      await browser.close().catch(() => {});
    }
  }

  try {
    const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    try {
      const links = await runSearch(browser);
      if (links.length) return links;
    } catch {
      // ignore final fallback
    } finally {
      await browser.close().catch(() => {});
    }
  } catch {
    // ignore final fallback
  }

  return [];
}

/**
 * Buka sebuah URL, tunggu render JS, kembalikan HTML jadinya.
 * Default: networkidle/60s (dipakai scraper KB). cek_url memakai opsi lebih cepat:
 * domcontentloaded + jeda settle pendek + timeout ketat.
 */
export async function browserFetch(url, { waitUntil = 'networkidle', timeout = 60000, settleMs = 0 } = {}) {
  return withPage(
    async (page) => {
      await page.goto(url, { waitUntil });
      if (settleMs) await page.waitForTimeout(settleMs);
      return page.content();
    },
    { timeout },
  );
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
