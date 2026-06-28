import { fetchAndParse, readLocalDoc, isWhitelisted } from './fetch.js';
import { structureContent } from './structure.js';
import { insertInfoBansos, deleteInfoBySource } from '../db/index.js';
import { indexInfo } from '../kb/vectorStore.js';
import { normalizeWilayahTag } from '../util/wilayah.js';

/**
 * Pipeline Agent 1 untuk SATU URL resmi: fetch -> parse -> structure (LLM) -> simpan + index.
 * Requirement: F1.1 whitelist, F1.2 sumber_url+tanggal_ambil, F1.3 wilayah_tag, F1.4 skip bila gagal.
 */
export async function ingestUrl(url, { hintWilayah, refresh = false } = {}) {
  if (!(await isWhitelisted(url))) {
    return { ok: false, url, error: 'URL bukan sumber resmi terkurasi (whitelist).' };
  }
  const fetched = await fetchAndParse(url);
  if (!fetched.ok) {
    console.warn(`[Agent1] SKIP ${url} — ${fetched.error}`);
    return { ok: false, url, error: fetched.error };
  }
  return finalizeFromText(fetched.text, { sumberUrl: url, hintWilayah, refresh });
}

/** Pipeline untuk dokumen sintetis lokal (demo) — sumber_url tetap WAJIB diisi. */
export async function ingestLocalDoc(filePath, { sumberUrl, hintWilayah } = {}) {
  if (!sumberUrl) return { ok: false, error: 'sumberUrl wajib (F1.2) untuk dokumen lokal.' };
  const { text } = readLocalDoc(filePath);
  return finalizeFromText(text, { sumberUrl, hintWilayah });
}

async function finalizeFromText(text, { sumberUrl, hintWilayah, refresh = false }) {
  const structured = await structureContent(text, { hintWilayah, sumberUrl });
  if (!structured.ok) {
    console.warn(`[Agent1] SKIP ${sumberUrl} — ${structured.error}`);
    return { ok: false, url: sumberUrl, error: structured.error };
  }
  // refresh: hapus versi lama dari sumber yang sama supaya re-scrape tidak menumpuk duplikat.
  if (refresh) await deleteInfoBySource(sumberUrl);
  return storeStructured({ ...structured.data, sumber_url: sumberUrl, hintWilayah });
}

/**
 * Simpan objek info terstruktur (juga dipakai seeder untuk data pre-strukturkan).
 * Memvalidasi field WAJIB sebelum menulis.
 */
export async function storeStructured(info) {
  const wilayah = info.wilayah_tag || normalizeWilayahTag(info.hintWilayah) || 'nasional';
  const record = {
    program: info.program,
    ringkasan: info.ringkasan,
    syarat: info.syarat || [],
    tanggal_penting: info.tanggal_penting || null,
    batas_daftar: info.batas_daftar || null,
    cara_daftar: info.cara_daftar || null,
    wilayah_tag: wilayah, // F1.3
    sumber_url: info.sumber_url, // F1.2
    tanggal_ambil: info.tanggal_ambil || new Date().toISOString().slice(0, 10), // F1.2
  };
  if (!record.sumber_url) return { ok: false, error: 'sumber_url wajib (F1.2).' };
  if (!record.program || !record.ringkasan) return { ok: false, error: 'program & ringkasan wajib.' };

  const id = await insertInfoBansos({ ...record, image_id: null, image_path: null });

  record.id = id;
  record.image_id = `info_${id}`;
  // Poster dibuat saat broadcast (bukan saat ingest) agar tidak boros API tiap scrape.

  const nChunks = await indexInfo(id, record);
  console.log(`[Agent1] OK  ${record.program} (${record.wilayah_tag}) → id=${id}, ${nChunks} chunk`);
  // `record` dikembalikan utuh agar pemanggil (scheduler) bisa broadcast info baru ke grup.
  return { ok: true, id, program: record.program, wilayah_tag: record.wilayah_tag, chunks: nChunks, record };
}
