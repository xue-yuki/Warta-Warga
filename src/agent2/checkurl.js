// Tool cek keamanan URL untuk brain (anti-penipuan): buka samaran shortener, analisis domain
// (resmi .go.id vs palsu/mirip), deteksi file unduhan (.apk), & scan form phishing (minta login/OTP/NIK).
// Mengembalikan SINYAL terstruktur — LLM yang menyimpulkan & menjelaskan ke warga.
//
// PRINSIP AMAN: URL di sini TAK tepercaya. Scan statis TAK mengeksekusi JS; ada guard SSRF (tolak host
// lokal/IP privat), timeout, & batas ukuran body. Fallback render JS dilakukan REMOTE via Bright Data
// (halaman jalan di server mereka, BUKAN mesin kita) — hanya saat scan statis kosong / situs anti-bot.

import axios from 'axios';
import * as cheerio from 'cheerio';
import { isWhitelisted, cleanHtml } from '../agent1/fetch.js';
import { hasBrowser, browserFetch } from '../agent1/browser.js';
import { bdUnlock } from '../agent1/brightdata.js';
import { hasBrightDataUnlocker } from '../config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const MAX_BYTES = 2_000_000; // 2 MB
const TIMEOUT = 12000;
const MAX_HOPS = 6;

const SENS_FIELD = /\b(otp|pin|nik|no_?kk|sandi|password|passwd|pwd|cvv|cvc|rekening|m-?pin|kode_?verif|login|user(name)?)\b/i;
const BRAND = /(kemensos|bansos|pkh|bpnt|sembako|bsu|prakerja|dtks|dana|gopay|ovo|shopee|bri|bca|bni|mandiri|gov)/i;
const DL_EXT = /\.(apk|apks|exe|msi|zip|rar|scr|bat)$/i;
const DL_CT = /application\/(octet-stream|vnd\.android\.package-archive|x-msdownload|zip|x-executable)|binary/i;
const SNIPPET_MAX = 1500;

export const URL_RE = /\b(?:https?:\/\/[^\s<>"'`]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"'`]*)?)/i;

/** Ekstrak URL pertama dari teks pesan warga. */
export function extractUrlFromText(text) {
  const match = String(text || '').match(URL_RE);
  if (!match) return null;
  return String(match[0]).trim().replace(/[)\].,;!?]+$/g, '');
}

function metaDescription($) {
  const og = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content');
  return String(og || '').trim().slice(0, 400) || null;
}

function articleSnippet(html) {
  try {
    const { text, title } = cleanHtml(html);
    const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);
    return { content_snippet: snippet || null, page_title: title?.slice(0, 160) || null };
  } catch {
    return { content_snippet: null, page_title: null };
  }
}

/** Normalisasi URL bebas → absolut http(s). null bila skema lain / tak valid. */
function normalize(raw) {
  let s = String(raw || '').trim().replace(/^[<("']+|[>)"'.,]+$/g, '');
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s; // tanpa skema → asumsikan https
  if (!/^https?:\/\//i.test(s)) return null; // skema selain http/https ditolak
  try {
    return new URL(s).toString();
  } catch {
    return null;
  }
}

/** Guard SSRF: tolak host lokal / IP privat / metadata. */
function isPrivateHost(host) {
  if (!host) return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true; // IPv6 loopback/ULA/link-local
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local + metadata 169.254.169.254
  }
  return false;
}

function hopGet(url) {
  return axios.get(url, {
    maxRedirects: 0,
    timeout: TIMEOUT,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
    responseType: 'arraybuffer',
    validateStatus: () => true, // 3xx/4xx tidak dianggap error → kita tangani manual
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
  });
}

const extOf = (u) => {
  try {
    return new URL(u).pathname.match(/\.[a-z0-9]+$/i)?.[0] || '';
  } catch {
    return '';
  }
};

/** Sinyal domain (tak butuh body) → tetap berguna walau situs tak terjangkau. */
async function domainInfo(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const is_official_gov = await isWhitelisted(url);
    return {
      host,
      tld: host.split('.').slice(-1)[0],
      https: u.protocol === 'https:',
      is_official_gov,
      domain_mirip_resmi: BRAND.test(host) && !is_official_gov,
    };
  } catch {
    return { host: null, tld: null, https: false, is_official_gov: false, domain_mirip_resmi: false };
  }
}

/**
 * Periksa sebuah URL. @returns {Promise<object>} sinyal terstruktur (lihat plan/skema).
 */
export async function inspectUrl(rawUrl) {
  const input_url = normalize(rawUrl);
  if (!input_url) return { ok: false, error: 'Bukan URL http/https yang valid.', input_url: String(rawUrl).slice(0, 200) };

  let host0;
  try {
    host0 = new URL(input_url).hostname;
  } catch {
    return { ok: false, error: 'URL tak bisa di-parse.', input_url };
  }
  if (isPrivateHost(host0)) return { ok: false, error: 'Host lokal/privat diblokir (keamanan).', input_url };

  // --- Resolusi redirect (buka samaran shortener) ---
  const redirect_chain = [];
  let current = input_url;
  let finalRes = null;
  for (let i = 0; i < MAX_HOPS; i++) {
    let res;
    try {
      res = await hopGet(current);
    } catch (err) {
      // Body kelewat besar → kemungkinan file unduhan besar (mis. .apk).
      if (err?.code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED' || /maxContentLength|maxBodyLength/i.test(err?.message || '')) {
        return await finalize({ input_url, final_url: current, redirect_chain, headers: {}, body: null, forcedDownload: true });
      }
      return augment({ ok: false, unreachable: true, error: err?.code || err?.message || 'gagal terhubung', input_url, final_url: current, redirect_chain, ...(await domainInfo(current)) });
    }
    const status = res.status;
    const loc = res.headers?.location;
    if (status >= 300 && status < 400 && loc) {
      let next;
      try {
        next = new URL(loc, current).toString();
      } catch {
        finalRes = res;
        break;
      }
      if (!/^https?:\/\//i.test(next) || isPrivateHost(new URL(next).hostname)) {
        return { ok: false, error: 'Redirect ke tujuan tak aman/lokal — dihentikan.', input_url, final_url: next, redirect_chain };
      }
      redirect_chain.push({ status, to: next });
      current = next;
      continue;
    }
    finalRes = res;
    break;
  }
  if (!finalRes) return augment({ ok: false, unreachable: true, error: 'Terlalu banyak pengalihan.', input_url, final_url: current, redirect_chain, ...(await domainInfo(current)) });

  return augment(await finalize({ input_url, final_url: current, redirect_chain, headers: finalRes.headers || {}, body: finalRes.data }));
}

/** Susun sinyal akhir dari response final. */
async function finalize({ input_url, final_url, redirect_chain, headers, body, forcedDownload = false }) {
  const dom = await domainInfo(final_url);
  const ct = String(headers['content-type'] || '').toLowerCase();
  const cd = String(headers['content-disposition'] || '').toLowerCase();
  const is_download = forcedDownload || DL_CT.test(ct) || cd.includes('attachment') || DL_EXT.test(extOf(final_url));

  const base = {
    ok: true,
    input_url,
    final_url,
    redirect_chain,
    fetch_status: 'ok',
    ...dom,
    is_download,
    download_type: is_download ? (extOf(final_url).replace('.', '') || ct || 'tidak diketahui') : null,
    page_title: null,
    content_snippet: null,
    meta_description: null,
    minta_data_sensitif: false,
    field_mencurigakan: [],
  };
  if (is_download || !body || !/text\/html|application\/xhtml/.test(ct || '')) return base;
  Object.assign(base, scanHtml(Buffer.from(body).toString('utf8')));
  return base;
}

/** Ekstrak sinyal dari HTML (cheerio, TANPA eksekusi JS): judul, snippet artikel, field sensitif. */
function scanHtml(html) {
  const out = { page_title: null, content_snippet: null, meta_description: null, minta_data_sensitif: false, field_mencurigakan: [] };
  try {
    const $ = cheerio.load(html);
    const article = articleSnippet(html);
    out.page_title = ($('title').first().text() || $('h1').first().text() || article.page_title || '').trim().slice(0, 160) || null;
    out.meta_description = metaDescription($);
    out.content_snippet = article.content_snippet || out.meta_description || out.page_title;
    const fields = new Set();
    $('input, select, textarea').each((_, el) => {
      const type = String($(el).attr('type') || '').toLowerCase();
      const name = `${$(el).attr('name') || ''} ${$(el).attr('id') || ''} ${$(el).attr('placeholder') || ''}`.toLowerCase();
      if (type === 'password') fields.add('password');
      const m = name.match(SENS_FIELD);
      if (m) fields.add(m[0]);
    });
    out.field_mencurigakan = [...fields].slice(0, 8);
    out.minta_data_sensitif = fields.size > 0;
  } catch {
    /* parse gagal → biarkan kosong */
  }
  return out;
}

const RENDER_TIMEOUT = 18000; // batas keras: situs normal kelar ~2-5s; situs anti-bot ekstrem mentok di sini

function hasUsefulContent(html) {
  const s = scanHtml(html);
  return Boolean(s.page_title || s.content_snippet) || s.minta_data_sensitif;
}

/**
 * Render JS REMOTE via Bright Data → HTML, atau null. Pakai Scraping Browser (render JS andal) dengan
 * 'networkidle' tapi DIBATASI ${RENDER_TIMEOUT}ms — cepat untuk situs normal, terbatas untuk situs
 * anti-bot ekstrem (yang gagal di-render = sinyal mencurigakan tersendiri; LLM menilai dari domain/URL).
 * Web Unlocker (REST) dipakai hanya bila Scraping Browser tak tersedia.
 */
async function renderViaBrightData(url) {
  if (hasBrowser()) {
    try {
      return (await browserFetch(url, { waitUntil: 'networkidle', timeout: RENDER_TIMEOUT })) || null;
    } catch {
      return null; // timeout/diblokir → biar LLM menilai dari domain + fakta situs sulit diperiksa
    }
  }
  try {
    const html = await bdUnlock(url, { timeout: RENDER_TIMEOUT });
    return html && hasUsefulContent(html) ? html : null;
  } catch {
    return null;
  }
}

/** Perlu fallback render JS? (kebuka tapi kontennya kosong / tak terjangkau via axios = anti-bot). */
function shouldRender(r) {
  if (r.is_official_gov) return false; // Bright Data memblokir domain .go.id
  if (r.is_download) return false;
  if (!(hasBrowser() || hasBrightDataUnlocker())) return false;
  return r.unreachable === true || (r.ok === true && !r.page_title && !r.content_snippet);
}

function withFetchStatus(result) {
  if (result.render_diblokir) return { ...result, fetch_status: 'render_diblokir' };
  if (result.unreachable || result.ok === false) return { ...result, fetch_status: 'unreachable' };
  return { ...result, fetch_status: result.fetch_status || 'ok' };
}

/** Bila scan statis tipis, coba render remote (Bright Data) lalu pindai ulang. */
async function augment(result) {
  if (!shouldRender(result) || !result.final_url) return withFetchStatus(result);
  const html = await renderViaBrightData(result.final_url);
  if (!html) return withFetchStatus({ ...result, render_diblokir: true });
  const merged = await finalize({
    input_url: result.input_url,
    final_url: result.final_url,
    redirect_chain: result.redirect_chain || [],
    headers: { 'content-type': 'text/html' },
    body: html,
  });
  merged.via = 'brightdata-render';
  return withFetchStatus(merged);
}
