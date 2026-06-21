import axios from 'axios';
import * as cheerio from 'cheerio';
import { config, hasSearch } from '../config.js';
import { isWhitelisted } from './fetch.js';
import { bdSerp } from './brightdata.js';

// Web search untuk menemukan sumber resmi daerah yang belum ada di KB (on-demand discovery).
// Pluggable & GRATIS by default:
//   - duckduckgo : scrape endpoint HTML DDG. TANPA API key, tanpa daftar. (DEFAULT)
//   - searxng    : metasearch open-source. Set SEARXNG_URL ke instance (self-host/publik).
//   - serper     : Google via serper.dev (butuh SERPER_API_KEY, ada kuota gratis).
//   - brave      : Brave Search API (butuh BRAVE_API_KEY).
// Apa pun providernya, hasil DISARING hanya ke host whitelist (.go.id) → tetap patuh F1.1.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** DuckDuckGo HTML (gratis, tanpa key). */
async function searchDuckDuckGo(query) {
  const res = await axios.post(
    'https://html.duckduckgo.com/html/',
    new URLSearchParams({ q: query, kl: 'id-id' }).toString(),
    { headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 },
  );
  const $ = cheerio.load(res.data);
  const links = [];
  $('a.result__a').each((_, el) => {
    const href = decodeDdgHref($(el).attr('href'));
    if (href) links.push(href);
  });
  return links;
}

/** DDG membungkus link asli di parameter ?uddg=... — kembalikan URL aslinya. */
function decodeDdgHref(href) {
  if (!href) return null;
  let u = href.startsWith('//') ? `https:${href}` : href;
  try {
    const parsed = new URL(u);
    return parsed.searchParams.get('uddg') || u; // URLSearchParams sudah men-decode
  } catch {
    return null;
  }
}

/** SearXNG (open-source). Butuh instance yang mengizinkan format=json. */
async function searchSearxng(query) {
  const base = config.search.searxngUrl.replace(/\/+$/, '');
  const res = await axios.get(`${base}/search`, {
    params: { q: query, format: 'json', language: 'id' },
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    timeout: 15000,
  });
  return (res.data?.results || []).map((r) => r.url).filter(Boolean);
}

/** Serper.dev — Google results sebagai JSON. */
async function searchSerper(query, limit) {
  const res = await axios.post(
    'https://google.serper.dev/search',
    { q: query, gl: 'id', hl: 'id', num: Math.max(limit * 2, 10) },
    { headers: { 'X-API-KEY': config.search.serperKey, 'Content-Type': 'application/json' }, timeout: 15000 },
  );
  return (res.data?.organic || []).map((o) => o.link).filter(Boolean);
}

/** Brave Search API. */
async function searchBrave(query, limit) {
  const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    params: { q: query, country: 'id', count: Math.max(limit * 2, 10) },
    headers: { 'X-Subscription-Token': config.search.braveKey, Accept: 'application/json' },
    timeout: 15000,
  });
  return (res.data?.web?.results || []).map((r) => r.url).filter(Boolean);
}

/** Google Programmable Search (Custom Search JSON API) — gratis 100 query/hari, tanpa kartu. */
async function searchGoogle(query, limit) {
  const res = await axios.get('https://www.googleapis.com/customsearch/v1', {
    params: { key: config.search.googleKey, cx: config.search.googleCx, q: query, num: Math.min(Math.max(limit * 2, 5), 10), gl: 'id', hl: 'id' },
    timeout: 15000,
  });
  return (res.data?.items || []).map((i) => i.link).filter(Boolean);
}

const PROVIDERS = {
  duckduckgo: (q) => searchDuckDuckGo(q),
  searxng: (q) => searchSearxng(q),
  serper: (q, l) => searchSerper(q, l),
  brave: (q, l) => searchBrave(q, l),
  google: (q, l) => searchGoogle(q, l),
  brightdata: (q) => bdSerp(q),
};

/**
 * Cari URL sumber resmi (.go.id) untuk sebuah query.
 * @returns {Promise<string[]>} daftar URL unik yang lolos whitelist (maks `limit`)
 */
export async function searchOfficialSources(query, { limit = 4 } = {}) {
  if (!hasSearch()) return [];
  const fn = PROVIDERS[config.search.provider] || PROVIDERS.duckduckgo;
  let urls = [];
  try {
    urls = await fn(query, limit);
  } catch (e) {
    console.warn(`[search:${config.search.provider}] gagal:`, e.response?.status || e.message);
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (!isWhitelisted(u)) continue; // hanya sumber resmi .go.id
    const norm = u.split('#')[0];
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= limit) break;
  }
  return out;
}
