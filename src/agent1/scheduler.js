import { config, hasLLM, hasSearch } from '../config.js';
import { ingestUrl } from './index.js';
import { extractLinks } from './fetch.js';
import { searchOfficialSources } from './search.js';
import { broadcastNewInfos, broadcastPendingPeringatan } from './broadcast.js';
import { humanWilayah } from '../util/wilayah.js';
import { listSumberCrawl } from '../db/index.js';

// Auto-scrape Agent 1: pindai daftar sumber resmi (data/sources.json) secara berkala,
// strukturkan via LLM, lalu segarkan Knowledge Base. Re-scrape = REFRESH (dedup by sumber_url).

let _timer = null;
let _pendingTimer = null;
let _running = false;

async function maybeBroadcastFreshInfos(fresh, { reason } = {}) {
  if (!fresh.length) return;
  if (!config.newInfoBroadcast.auto) {
    console.log(`[Broadcast] Auto-broadcast info baru NONAKTIF (${fresh.length} info tersimpan, reason=${reason}).`);
    return;
  }
  await broadcastNewInfos(fresh).catch((e) => console.warn('[Broadcast] gagal:', e?.message));
}

/** Baca daftar sumber dari DB (menggantikan sources.json). */
export async function loadSources() {
  try {
    const rows = await listSumberCrawl();
    return rows.map((r) => ({ url: r.url, wilayah: r.wilayah || undefined, crawl: Boolean(r.crawl) }));
  } catch (e) {
    console.warn('[Agent1] Gagal baca sumber_crawl dari DB:', e.message);
    return [];
  }
}

/**
 * Pindai semua sumber sekali jalan. Aman dipanggil ulang (anti-tumpang-tindih).
 * @returns {Promise<{total:number, ok:number, skip:number}>}
 */
export async function scrapeAllSources({ reason = 'manual' } = {}) {
  if (_running) {
    console.log('[Agent1] Auto-scrape sebelumnya masih jalan — lewati putaran ini.');
    return { total: 0, ok: 0, skip: 0 };
  }
  if (!hasLLM()) {
    console.warn('[Agent1] Auto-scrape butuh OPENROUTER_API_KEY — dilewati.');
    return { total: 0, ok: 0, skip: 0 };
  }
  const sources = await loadSources();
  if (sources.length === 0) {
    console.log('[Agent1] Tabel sumber_crawl kosong — tidak ada yang dipindai.');
    return { total: 0, ok: 0, skip: 0 };
  }

  _running = true;
  console.log(`[Agent1] 🔄 Auto-scrape (${reason}): ${sources.length} sumber resmi...`);
  let ok = 0;
  let skip = 0;
  const fresh = [];
  const MAX_CRAWL = 12; // batasi link anak per hub (hindari over-fetch)
  const ingestOne = async (url, wilayah) => {
    try {
      const r = await ingestUrl(url, { hintWilayah: wilayah, refresh: true });
      if (r.ok) {
        ok++;
        if (r.record) fresh.push(r.record);
      } else skip++;
    } catch (e) {
      skip++;
      console.warn(`[Agent1] SKIP ${url} — ${e.message}`);
    }
  };
  try {
    for (const s of sources) {
      // Halaman HUB/listing (crawl:true): ambil link program anak lalu ingest tiap-tiap (bukan hub-nya).
      if (s.crawl) {
        let links = [];
        try {
          links = (await extractLinks(s.url)).slice(0, MAX_CRAWL);
        } catch (e) {
          console.warn(`[Agent1] crawl gagal ${s.url}: ${e.message}`);
        }
        console.log(`[Agent1] 🕸️  hub ${s.url} → ${links.length} kandidat halaman program`);
        for (const link of links) await ingestOne(link, s.wilayah);
        continue;
      }
      await ingestOne(s.url, s.wilayah);
    }
  } finally {
    _running = false;
  }
  console.log(`[Agent1] ✅ Auto-scrape selesai (${reason}): ${ok} tersimpan, ${skip} dilewati.`);
  await maybeBroadcastFreshInfos(fresh, { reason });
  return { total: sources.length, ok, skip };
}

/** Aktifkan penjadwal: scrape saat boot (opsional) + interval berkala. Non-blocking. */
export function startAutoScrape() {
  if (!config.scrape.enabled) {
    console.log('[Agent1] Auto-scrape NONAKTIF (SCRAPE_AUTO=false).');
    return;
  }
  if (!hasLLM()) {
    console.warn('[Agent1] Auto-scrape dilewati: OPENROUTER_API_KEY belum diset.');
    return;
  }

  if (config.scrape.onBoot) {
    // jalan di latar belakang, jangan blokir start bot.
    scrapeAllSources({ reason: 'startup' }).catch((e) => console.warn('[Agent1] scrape startup gagal:', e.message));
  }

  const ms = Math.max(1, config.scrape.intervalHours) * 60 * 60 * 1000;
  _timer = setInterval(() => {
    scrapeAllSources({ reason: 'terjadwal' }).catch((e) => console.warn('[Agent1] scrape terjadwal gagal:', e.message));
  }, ms);
  _timer.unref?.(); // jangan menahan proses tetap hidup hanya karena timer
  console.log(`[Agent1] ⏱️  Auto-scrape aktif tiap ${config.scrape.intervalHours} jam.`);

  if (config.pendingBroadcast.autoPolling) {
    const minutes = Math.max(1, config.pendingBroadcast.intervalMinutes);
    _pendingTimer = setInterval(() => {
      broadcastPendingPeringatan().catch((e) => console.warn('[PendingBroadcast] gagal:', e?.message));
    }, minutes * 60 * 1000);
    _pendingTimer.unref?.();
    console.log(`[PendingBroadcast] Auto-polling aktif tiap ${minutes} menit.`);
  } else {
    console.log('[PendingBroadcast] Auto-polling NONAKTIF. Gunakan tombol dashboard untuk broadcast manual.');
  }
}

export function stopAutoScrape() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  if (_pendingTimer) clearInterval(_pendingTimer);
  _pendingTimer = null;
}

/**
 * ON-DEMAND: cari sumber resmi sebuah daerah lewat web search, lalu scrape & simpan.
 * Dipakai saat user menanyakan daerah yang belum ada di KB.
 * @param {string} daerah   label daerah untuk query, mis. "Kab. Bogor"
 * @param {string} wilayahTag tag baku, mis. "kabupaten:bogor"
 * @returns {Promise<{ok:number, found:number, urls:string[]}>}
 */
export async function scrapeRegion(daerah, wilayahTag) {
  if (!hasLLM() || !hasSearch()) {
    return { ok: 0, found: 0, urls: [] };
  }
  const label = daerah || humanWilayah(wilayahTag);
  // Beberapa query agar peluang menemukan halaman bansos resmi daerah lebih besar.
  const queries = [
    `bantuan sosial ${label} dinas sosial site:go.id`,
    `bansos ${label} site:go.id`,
    `program bantuan ${label} pemerintah daerah go.id`,
  ];

  const urls = new Set();
  for (const q of queries) {
    for (const u of await searchOfficialSources(q, { limit: 3 })) urls.add(u);
    if (urls.size >= 5) break;
  }

  const list = [...urls].slice(0, 5);
  console.log(`[Agent1] 🔎 On-demand "${label}" (${wilayahTag}): ${list.length} kandidat sumber resmi.`);
  let ok = 0;
  const fresh = [];
  for (const url of list) {
    try {
      const r = await ingestUrl(url, { hintWilayah: wilayahTag, refresh: true });
      if (r.ok) {
        ok++;
        if (r.record) fresh.push(r.record);
      }
    } catch (e) {
      console.warn(`[Agent1] SKIP ${url} — ${e.message}`);
    }
  }
  console.log(`[Agent1] ✅ On-demand "${label}": ${ok}/${list.length} tersimpan.`);
  await maybeBroadcastFreshInfos(fresh, { reason: 'on-demand' });
  return { ok, found: list.length, urls: list };
}
