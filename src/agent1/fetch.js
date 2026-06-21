import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { ROOT, hasBrightDataUnlocker } from '../config.js';
import { bdUnlock } from './brightdata.js';
import { hasBrowser, browserFetch } from './browser.js';

let _whitelist = null;
function whitelist() {
  if (_whitelist) return _whitelist;
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sources_whitelist.json'), 'utf8'));
  _whitelist = (raw.allowedHostPatterns || []).map((p) => new RegExp(p, 'i'));
  return _whitelist;
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** F1.1: hanya host yang cocok whitelist yang boleh diproses. */
export function isWhitelisted(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return whitelist().some((re) => re.test(host));
}

/**
 * Tarik & bersihkan konten dari sebuah URL resmi.
 * @returns {Promise<{ok:boolean, text?:string, title?:string, error?:string}>}
 */
export async function fetchAndParse(url) {
  if (!isWhitelisted(url)) {
    return { ok: false, error: `URL di luar whitelist sumber resmi: ${url}` };
  }

  // 1) Coba ambil biasa (cepat & gratis).
  let lastErr = 'gagal fetch';
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'WartaWargaBot/0.1 (+sumber-resmi)' },
    });
    const { text, title } = cleanHtml(res.data);
    if (text && text.length >= 80) return { ok: true, text, title };
    lastErr = 'Konten kosong/terlalu pendek (mungkin halaman butuh JavaScript).';
  } catch (err) {
    lastErr = err.message;
  }

  // 2) Fallback render JS hanya untuk domain NON-pemerintah.
  // Bright Data memblokir domain .go.id (Government) → percuma & buang credit. Jadi .go.id
  // cukup lewat axios di atas. Fallback browser/unlocker disediakan utk sumber lain (kalau ada).
  const host = safeHost(url);
  const isGov = host.endsWith('.go.id');
  if (!isGov && hasBrightDataUnlocker()) {
    try {
      const html = hasBrowser() ? await browserFetch(url) : await bdUnlock(url);
      if (html) {
        const { text, title } = cleanHtml(html);
        if (text && text.length >= 80) return { ok: true, text, title, via: hasBrowser() ? 'browser' : 'unlocker' };
      }
    } catch (err) {
      lastErr = `render: ${err.response?.status || err.message}`;
    }
  }

  return { ok: false, error: lastErr };
}

/** Cheerio: buang menu/iklan/footer, ambil teks inti. */
export function cleanHtml(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, header, footer, aside, form, iframe, .menu, .nav, .sidebar, .ads, .advertisement').remove();
  const title = $('title').first().text().trim() || $('h1').first().text().trim();
  const main = $('main').text() || $('article').text() || $('body').text();
  const text = main
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, title };
}

/** Untuk demo: baca pengumuman sintetis dari file lokal. */
export function readLocalDoc(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return { ok: true, text, title: path.basename(filePath) };
}
