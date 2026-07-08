import { isWhitelisted } from './fetch.js';
import { searchTurboseek } from './turboseek.js';
import { hasSearch } from '../config.js';

/**
 * Cari URL sumber resmi (.go.id) untuk sebuah query.
 * @returns {Promise<string[]>} daftar URL unik yang lolos whitelist (maks `limit`)
 */
export async function searchOfficialSources(query, { limit = 4 } = {}) {
  if (!hasSearch()) return [];

  let urls = [];
  try {
    const result = await searchTurboseek(query);
    urls = Array.isArray(result.sources)
      ? result.sources.map((s) => String(s.url || '').trim()).filter(Boolean)
      : [];
    console.log('[search:turboseek] raw urls', { count: urls.length, urls: urls.slice(0, 20) });
  } catch (e) {
    const errorDetail = e?.response?.data || e?.response?.status || e?.message || e;
    console.warn('[search:turboseek] gagal:', e.response?.status || e.message || errorDetail);
  }

  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (!(await isWhitelisted(u))) continue;
    const norm = u.split('#')[0];
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= limit) break;
  }

  console.log('[search] whitelist filtered urls', { count: out.length, urls: out });
  return out;
}
