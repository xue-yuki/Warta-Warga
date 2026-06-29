import axios from 'axios';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as cheerio from 'cheerio';
import { chatJson } from '../llm/openrouter.js';
import { hasLLM } from '../config.js';
import { insertInfoBansos, deleteInfoBySource } from '../db/index.js';
import { indexInfo } from '../kb/vectorStore.js';

const require = createRequire(import.meta.url);

const ORIGIN = 'https://trustpositif.komdigi.go.id';
const BASE = `${ORIGIN}/pdfhoaks/Harian`;
const CHUNK_SIZE = 4500;
const CHUNK_OVERLAP = 150;
const MONTHS_ID = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

function formatKomdigiDate(date) {
  const d = String(date.getDate()).padStart(2, '0');
  return `${d} ${MONTHS_ID[date.getMonth()]} ${date.getFullYear()}`;
}

export function buildPdfUrl(date = new Date()) {
  return `${ORIGIN}/assets/hoaks_harian/${encodeURIComponent(`${formatKomdigiDate(date)} - Isu Hoaks Harian.pdf`)}`;
}

function normalizeText(value) {
  try {
    value = decodeURIComponent(String(value));
  } catch {
    value = String(value);
  }
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function listKomdigiDailyPdfLinks() {
  const res = await axios.get(BASE, {
    responseType: 'text',
    timeout: 30000,
    validateStatus: null,
    headers: { 'User-Agent': 'WartaWargaBot/0.1 (+hoaks-verifikasi)' },
  });

  if (res.status !== 200) {
    throw new Error(`listing HTTP ${res.status}`);
  }

  const $ = cheerio.load(res.data || '');
  const links = [];
  $('a[href*=".pdf"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    links.push({
      url: new URL(href, ORIGIN).href,
      text: $(el).text(),
    });
  });
  return links;
}

export async function resolveKomdigiPdfUrl(date = new Date()) {
  const label = normalizeText(formatKomdigiDate(date));
  const links = await listKomdigiDailyPdfLinks();
  const match = links.find((link) => {
    const haystack = normalizeText(`${link.text} ${link.url}`);
    return haystack.includes(label) && haystack.includes('isu hoaks harian');
  });
  return match?.url || null;
}

async function parsePdf(buffer) {
  const pdfParse = require('pdf-parse');

  if (typeof pdfParse === 'function') {
    const data = await pdfParse(buffer);
    return data.text || '';
  }

  if (typeof pdfParse.PDFParse === 'function') {
    const parser = new pdfParse.PDFParse({ data: buffer });
    try {
      const data = await parser.getText();
      return data.text || '';
    } finally {
      await parser.destroy?.();
    }
  }

  throw new Error('pdf-parse export tidak didukung');
}

const EXTRACT_SYSTEM =
  'Kamu ekstraktor data dari daftar hoaks/disinformasi resmi pemerintah Indonesia (Komdigi).' +
  ' Tugasmu: ekstrak SETIAP entri hoaks dari teks dan kembalikan sebagai JSON array.' +
  ' Kembalikan HANYA array JSON tanpa markdown, tanpa penjelasan tambahan.' +
  ' Jika tidak ada entri, kembalikan [].';

async function extractBatch(textChunk) {
  const result = await chatJson({
    tier: 'fast',
    temperature: 0,
    maxTokens: 2000,
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      {
        role: 'user',
        content:
          'Ekstrak semua entri hoaks dari teks ini. Tiap entri:\n' +
          '- "judul": klaim/judul hoaks\n' +
          '- "penjelasan": penjelasan singkat mengapa ini hoaks\n' +
          '- "verdict": "hoaks" | "disinformasi" | "konten_menyesatkan"\n' +
          '- "links": array URL yang disebut (boleh [])\n\n' +
          'Format: [{"judul":"...","penjelasan":"...","verdict":"...","links":[]}]\n\n' +
          `TEKS:\n"""\n${textChunk}\n"""`,
      },
    ],
  });
  if (!Array.isArray(result)) return [];
  return result.filter((e) => e?.judul && e?.penjelasan);
}

async function extractHoaksEntries(text) {
  const segments = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
    segments.push(text.slice(i, i + CHUNK_SIZE));
    if (i + CHUNK_SIZE >= text.length) break;
  }

  const all = [];
  const seen = new Set();
  for (const seg of segments) {
    try {
      const entries = await extractBatch(seg);
      for (const e of entries) {
        const key = e.judul.trim().toLowerCase().slice(0, 60);
        if (!seen.has(key)) {
          seen.add(key);
          all.push(e);
        }
      }
    } catch (err) {
      console.warn('[Komdigi] Batch ekstrak gagal:', err.message);
    }
  }
  return all;
}

async function storeHoaksEntry(entry, sumberUrl) {
  const today = new Date().toISOString().slice(0, 10);
  const verdictLabel =
    entry.verdict === 'disinformasi'
      ? 'DISINFORMASI'
      : entry.verdict === 'konten_menyesatkan'
        ? 'KONTEN MENYESATKAN'
        : 'HOAKS';

  const program = `[Hoaks] ${entry.judul.trim()}`;
  const ringkasan = `${verdictLabel}: ${entry.penjelasan.trim()}`;
  const syarat = Array.isArray(entry.links) ? entry.links.filter(Boolean) : [];

  const id = await insertInfoBansos({
    program,
    ringkasan,
    syarat,
    tanggal_penting: null,
    batas_daftar: null,
    cara_daftar: null,
    wilayah_tag: 'nasional',
    sumber_url: sumberUrl,
    tanggal_ambil: today,
    image_id: null,
    image_path: null,
  });

  const nChunks = await indexInfo(id, { program, ringkasan, syarat, wilayah_tag: 'nasional', sumber_url: sumberUrl, tanggal_ambil: today });
  console.log(`[Komdigi]   • "${program.slice(0, 65)}" → id=${id}, ${nChunks} chunk`);
  return id;
}

/**
 * Ingest PDF hoaks harian dari Komdigi. Coba tanggal hari ini, mundur ke kemarin bila belum ada di listing.
 * Idempoten: hapus entri lama dari URL yang sama sebelum insert ulang.
 * @param {{ date?: Date }} [opts]
 */
export async function ingestKomdigiHoaks({ date } = {}) {
  if (!hasLLM()) {
    console.warn('[Komdigi] LLM tidak tersedia — dilewati.');
    return { ok: false, error: 'no_llm' };
  }

  const today = date || new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  let buffer = null;
  let sumberUrl = null;

  for (const d of [today, yesterday]) {
    const label = formatKomdigiDate(d);
    try {
      const url = await resolveKomdigiPdfUrl(d);
      if (!url) {
        console.log(`[Komdigi] PDF ${label} belum ada di listing.`);
        continue;
      }

      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        validateStatus: null,
        headers: { 'User-Agent': 'WartaWargaBot/0.1 (+hoaks-verifikasi)' },
      });
      const candidate = Buffer.from(res.data || []);
      const isPdf = candidate.subarray(0, 4).toString('latin1') === '%PDF';
      if (res.status === 200 && isPdf && candidate.byteLength > 500) {
        buffer = candidate;
        sumberUrl = url;
        break;
      }
      if (res.status === 404) {
        console.log(`[Komdigi] PDF ${url} belum ada (404).`);
        continue;
      }
      const contentType = res.headers?.['content-type'] || '-';
      const magic = candidate.subarray(0, 16).toString('latin1').replace(/\s+/g, ' ');
      console.warn(`[Komdigi] Respons bukan PDF valid (${res.status}, ${contentType}, magic="${magic}") untuk ${url} — dilewati.`);
    } catch (err) {
      console.warn(`[Komdigi] Gagal fetch PDF ${label}: ${err.message}`);
    }
  }

  if (!buffer) {
    console.log('[Komdigi] PDF tidak tersedia — dilewati.');
    return { ok: false, skip: true };
  }

  const tmpPath = path.join(os.tmpdir(), `komdigi_${Date.now()}.pdf`);
  try {
    fs.writeFileSync(tmpPath, buffer);
    console.log(`[Komdigi] 📥 ${sumberUrl} (${(buffer.length / 1024).toFixed(0)} KB)`);

    let text;
    try {
      text = await parsePdf(buffer);
    } catch (err) {
      console.warn('[Komdigi] Gagal parse PDF:', err.message);
      return { ok: false, error: `parse: ${err.message}` };
    }

    if (!text || text.trim().length < 50) {
      console.warn('[Komdigi] Teks PDF kosong — dilewati.');
      return { ok: false, error: 'empty_text' };
    }

    console.log(`[Komdigi] 📄 ${text.length} karakter diekstrak, memproses...`);

    const entries = await extractHoaksEntries(text);
    if (!entries.length) {
      console.log('[Komdigi] Tidak ada entri hoaks berhasil diekstrak.');
      return { ok: true, count: 0 };
    }

    await deleteInfoBySource(sumberUrl).catch(() => {});

    let saved = 0;
    for (const entry of entries) {
      try {
        await storeHoaksEntry(entry, sumberUrl);
        saved++;
      } catch (err) {
        console.warn(`[Komdigi] Gagal simpan "${String(entry.judul).slice(0, 40)}": ${err.message}`);
      }
    }

    console.log(`[Komdigi] ✅ ${saved}/${entries.length} entri hoaks tersimpan dari ${sumberUrl}`);
    return { ok: true, count: saved, url: sumberUrl };
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }
}
