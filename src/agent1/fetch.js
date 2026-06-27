import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { hasBrightDataUnlocker } from '../config.js';
import { bdUnlock } from './brightdata.js';
import { hasBrowser, browserFetch, localFetch } from './browser.js';
import { listWhitelistPatterns } from '../db/index.js';

// In-memory cache untuk whitelist; refresh dari DB tiap 60 detik.
let _whitelistCache = null;
let _whitelistExpires = 0;
const WHITELIST_TTL = 60_000;

async function getWhitelist() {
  const now = Date.now();
  if (_whitelistCache && now < _whitelistExpires) return _whitelistCache;
  const rows = await listWhitelistPatterns();
  _whitelistCache = rows.map((r) => new RegExp(r.pattern, 'i'));
  _whitelistExpires = now + WHITELIST_TTL;
  return _whitelistCache;
}

/** Panggil saat startup agar cache terisi sebelum request pertama. */
export async function initWhitelistCache() {
  await getWhitelist();
}

/** Paksa refresh cache (berguna setelah update whitelist via dashboard). */
export function invalidateWhitelistCache() {
  _whitelistExpires = 0;
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** F1.1: hanya host yang cocok whitelist yang boleh diproses. */
export async function isWhitelisted(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const patterns = await getWhitelist();
  return patterns.some((re) => re.test(host));
}

/**
 * Tarik & bersihkan konten dari sebuah URL resmi.
 * @returns {Promise<{ok:boolean, text?:string, title?:string, error?:string}>}
 */
export async function fetchAndParse(url) {
  if (!(await isWhitelisted(url))) {
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
    const content = extractValidContent(res.data);
    if (content) return { ok: true, ...content };
    lastErr = 'Konten kosong/terlalu pendek (mungkin halaman butuh JavaScript).';
  } catch (err) {
    lastErr = err.message;
  }

  const host = safeHost(url);
  const isGov = host.endsWith('.go.id');

  // 2) Domain .go.id yang butuh JS: Bright Data MEMBLOKIR domain Government, jadi render pakai
  // browser LOKAL (Chrome/Edge) — IP rumah pengguna bisa mengakses .go.id. Best-effort.
  if (isGov) {
    try {
      const html = await localFetch(url);
      const content = extractValidContent(html);
      if (content) return { ok: true, ...content, via: 'local-browser' };
    } catch (err) {
      lastErr = `render lokal: ${err.message}`;
    }
    return { ok: false, error: lastErr };
  }

  // 3) Domain NON-pemerintah: render via Bright Data (browser remote / Web Unlocker).
  if (hasBrightDataUnlocker()) {
    try {
      const html = hasBrowser() ? await browserFetch(url) : await bdUnlock(url);
      const content = extractValidContent(html);
      if (content) return { ok: true, ...content, via: hasBrowser() ? 'browser' : 'unlocker' };
    } catch (err) {
      lastErr = `render: ${err.response?.status || err.message}`;
    }
  }

  return { ok: false, error: lastErr };
}

// Path yang menandakan KANDIDAT halaman program (untuk hub-crawl). Sengaja luas; struktur+filter LLM
// nantinya menyaring yang ternyata bukan program.
const PROGRAM_HINT = /program|bantuan|pkh|sembako|bpnt|\bpip\b|\bkip\b|\bkis\b|pbi|\bblt\b|\bbst\b|atensi|pena|rutilahu|subsidi|jaminan|disabilitas|lansia|yatim/i;
const FILE_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|zip|rar|docx?|xlsx?|pptx?|mp4)$/i;

/**
 * Ambil tautan KANDIDAT halaman program dari sebuah halaman hub/listing (same-domain).
 * Dipakai hub-crawl: satu halaman daftar → banyak halaman program nyata. Best-effort.
 * @returns {Promise<string[]>}
 */
export async function extractLinks(url) {
  if (!(await isWhitelisted(url))) return [];
  let html = null;
  try {
    const res = await axios.get(url, { timeout: 20000, maxRedirects: 5, headers: { 'User-Agent': 'WartaWargaBot/0.1 (+sumber-resmi)' } });
    if (typeof res.data === 'string') html = res.data;
  } catch {
    /* coba render di bawah */
  }
  // .go.id sering butuh JS → render via browser lokal (Bright Data blokir gov).
  if ((!html || html.length < 500) && safeHost(url).endsWith('.go.id')) {
    try {
      html = (await localFetch(url)) || html;
    } catch {
      /* abaikan */
    }
  }
  if (!html) return [];

  const $ = cheerio.load(html);
  const base = new URL(url);
  const out = new Set();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;
    let abs;
    try {
      abs = new URL(href, base);
    } catch {
      return;
    }
    if (abs.hostname !== base.hostname) return; // same-domain saja
    if (FILE_EXT.test(abs.pathname)) return;
    if (!PROGRAM_HINT.test(abs.pathname)) return; // hanya path yang berbau program
    const clean = `${abs.origin}${abs.pathname}`.replace(/\/$/, '');
    if (clean !== `${base.origin}${base.pathname}`.replace(/\/$/, '')) out.add(clean); // jangan link ke diri sendiri
  });
  return [...out];
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

function extractValidContent(html) {
  if (!html) return null;
  const { text, title } = cleanHtml(html);
  return text && text.length >= 80 ? { text, title } : null;
}

/** Untuk demo: baca pengumuman sintetis dari file lokal. */
export function readLocalDoc(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return { ok: true, text, title: path.basename(filePath) };
}
