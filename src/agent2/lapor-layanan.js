import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatJson } from "../llm/openrouter.js";
import { hasLLM, hasVision } from "../config.js";
import { detectWilayahFromText, normalizeWilayahTag, humanWilayah, isKabKota } from "../util/wilayah.js";
import { insertLaporanLayanan, updateLaporanLayananStatus, insertLaporanLayananSubmitLog, getLaporanLayanan } from "../db/index.js";
import { submitLaporGub } from "../portal/laporgub.js";

const SERVICE_KEYWORDS = /\b(lapor|aduan|pengaduan|adukan|rusak|mati listrik|mati air|jalan rusak|jalan berlubang|sampah|pdam|pln|listrik|air|jalan|kebersihan|fasilitas umum|lampu jalan|banjir)\b/i;
const FRAUD_KEYWORDS = /\b(penipuan|hoaks|hoax|scam|transfer|otp|link|klik|rekening|kartu kredit|hadiah)\b/i;
const CATEGORY_PATTERNS = [
  { key: "listrik", re: /\b(listrik|pln|mati listrik|listrik padam|tagihan listrik)\b/i },
  { key: "air", re: /\b(air|pdam|mati air|air mati|pipa bocor)\b/i },
  { key: "jalan", re: /\b(jalan|berlubang|aspal|rusak jalan|jalur rusak|jalan rusak|macet)\b/i },
  { key: "sampah", re: /\b(sampah|pembuangan|tumpukan sampah|kebersihan|tpa|tempat sampah)\b/i },
  { key: "lainnya", re: /\b(fasilitas|umum|jalan umum|pelayanan umum|jenazah|trotoar|saluran)\b/i },
];

const PENDING_TTL = 15 * 60 * 1000;
const pendingLaporan = new Map();

function getPending(sessionId) {
  if (!sessionId) return null;
  const data = pendingLaporan.get(sessionId);
  if (!data) return null;
  if (Date.now() - data.ts > PENDING_TTL) {
    pendingLaporan.delete(sessionId);
    return null;
  }
  return data;
}

export function hasPendingLaporanLayanan(sessionId) {
  return Boolean(getPending(sessionId));
}

function isServiceReportIntent(text) {
  if (!text) return false;
  if (!SERVICE_KEYWORDS.test(text)) return false;
  if (FRAUD_KEYWORDS.test(text)) return false;
  return true;
}

function isAffirmative(text) {
  return /\b(ya|oke|ok|iya|yes|betul|lanjut|kirim)\b/i.test(text);
}

function isNegative(text) {
  return /\b(tidak|enggak|ga|gak|batal|nanti|jangan)\b/i.test(text);
}

function detectCategory(text) {
  for (const pattern of CATEGORY_PATTERNS) {
    if (pattern.re.test(text)) return pattern.key;
  }
  return "lainnya";
}

async function parseLaporanLayanan(text) {
  const fallback = {
    kategori: detectCategory(text),
    lokasi: detectWilayahFromText(text),
    deskripsi: text.trim().replace(/\s+/g, " ").slice(0, 800),
  };

  if (!hasLLM()) return fallback;

  const prompt =
    `Kamu parser laporan layanan publik. Outputkan JSON valid dengan properti:\n` +
    `{
  "kategori": "listrik|air|jalan|sampah|lainnya",
  "lokasi": "nama kabupaten/kota spesifik, atau null jika tidak ada",
  "deskripsi": "ringkas 1-2 kalimat tentang masalahnya, tanpa nama/nomor"
}` +
    `\n\nLaporan: """${text.slice(0, 1200)}"""`;
  try {
    const r = await chatJson({
      tier: "fast",
      temperature: 0,
      maxTokens: 220,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: "Ekstrak data laporan layanan publik." },
      ],
    });
    return {
      kategori:
        String(r?.kategori || fallback.kategori)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_") || fallback.kategori,
      lokasi: r?.lokasi || fallback.lokasi,
      deskripsi: String(r?.deskripsi || fallback.deskripsi).trim(),
    };
  } catch {
    return fallback;
  }
}

function normalizeLaporanLocation(lokasi) {
  if (!lokasi) return null;
  const tag = normalizeWilayahTag(lokasi);
  return isKabKota(tag) ? tag : null;
}

const ASK_SERVICE_DETAIL = 'Silakan ceritakan masalahnya ya. Contoh: "listrik mati di jalan Sudirman, Kota Semarang" atau "air PDAM tidak keluar sejak pagi".';
const ASK_SERVICE_LOCATION = 'Untuk mengirim aduan ke LaporGub, sebutkan dulu kabupaten/kota yang terkena. Misal: "Kab. Banyumas" atau "Kota Semarang".';
const ASK_SERVICE_CONFIRM = (kategori, lokasi, deskripsi) => `Ini aduan *${kategori}* untuk *${humanWilayah(lokasi)}*:\n` + `${deskripsi}\n\n` + "Kalau sudah benar, balas *Ya* untuk saya kirim ke LaporGub. Kalau belum, balas *Tidak*.";

function tempFilePath(buffer, mimetype) {
  const ext = mimetype?.split("/")[1] || "jpg";
  const dir = path.join(os.tmpdir(), "warta-warga-lapor");
  fs.mkdirSync(dir, { recursive: true });
  const name = `lapor-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  return path.join(dir, name);
}

export async function handleLaporLayanan({ text, imageText = null, imageBuffer = null, imageMimetype = null, sessionId = null, messageId = null }) {
  const pending = getPending(sessionId);
  if (pending) {
    return consumeLaporLayananReply({ sessionId, text, imageText, imageBuffer, imageMimetype, messageId });
  }

  if (!isServiceReportIntent(text)) return null;

  const message = [text, imageText].filter(Boolean).join("\n\n");
  const parsed = await parseLaporanLayanan(message);
  const wilayahTag = normalizeLaporanLocation(parsed.lokasi);

  if (!parsed.deskripsi || parsed.deskripsi.length < 20) {
    pendingLaporan.set(sessionId, {
      stage: "content",
      data: { kategori: parsed.kategori, deskripsi: parsed.deskripsi, lokasiTag: wilayahTag, imageBuffer, imageMimetype, messageId },
      ts: Date.now(),
    });
    return { reply: ASK_SERVICE_DETAIL };
  }

  if (!wilayahTag) {
    pendingLaporan.set(sessionId, {
      stage: "location",
      data: { kategori: parsed.kategori, deskripsi: parsed.deskripsi, imageBuffer, imageMimetype, messageId },
      ts: Date.now(),
    });
    return { reply: ASK_SERVICE_LOCATION };
  }

  pendingLaporan.set(sessionId, {
    stage: "confirm",
    data: { kategori: parsed.kategori, deskripsi: parsed.deskripsi, lokasiDetail: parsed.lokasi, lokasiTag: wilayahTag, imageBuffer, imageMimetype, messageId },
    ts: Date.now(),
  });

  return { reply: ASK_SERVICE_CONFIRM(parsed.kategori, wilayahTag, parsed.deskripsi) };
}

async function consumeLaporLayananReply({ sessionId, text, imageText = null, imageBuffer = null, imageMimetype = null, messageId = null }) {
  const pending = getPending(sessionId);
  if (!pending) return null;

  if (pending.stage === "content") {
    const prev = pending.data;
    const message = [text, imageText, prev.deskripsi].filter(Boolean).join("\n\n");
    const parsed = await parseLaporanLayanan(message);
    const lokasiTag = normalizeLaporanLocation(parsed.lokasi || prev.lokasiTag);
    const data = {
      kategori: parsed.kategori || prev.kategori,
      deskripsi: parsed.deskripsi || prev.deskripsi,
      lokasiDetail: parsed.lokasi || prev.lokasiDetail,
      lokasiTag,
      imageBuffer: imageBuffer || prev.imageBuffer,
      imageMimetype: imageMimetype || prev.imageMimetype,
      messageId: messageId || prev.messageId,
    };
    if (!data.lokasiTag) {
      pendingLaporan.set(sessionId, { stage: "location", data, ts: Date.now() });
      return { reply: ASK_SERVICE_LOCATION };
    }
    pendingLaporan.set(sessionId, { stage: "confirm", data, ts: Date.now() });
    return { reply: ASK_SERVICE_CONFIRM(data.kategori, data.lokasiTag, data.deskripsi) };
  }

  if (pending.stage === "location") {
    const prev = pending.data;
    const lokasiTag = normalizeLaporanLocation(text);
    if (!lokasiTag) {
      return { reply: ASK_SERVICE_LOCATION };
    }
    const data = { ...prev, lokasiDetail: text.trim(), lokasiTag };
    pendingLaporan.set(sessionId, { stage: "confirm", data, ts: Date.now() });
    return { reply: ASK_SERVICE_CONFIRM(data.kategori, data.lokasiTag, data.deskripsi) };
  }

  if (pending.stage === "confirm") {
    if (isNegative(text)) {
      pendingLaporan.delete(sessionId);
      return { reply: "Oke, aduan tidak saya kirim. Kalau ingin coba lagi, silakan kirim kembali detailnya ya." };
    }
    if (!isAffirmative(text)) {
      return { reply: "Silakan balas *Ya* jika mau saya kirim aduan ini ke LaporGub, atau *Tidak* jika batal." };
    }

    const { kategori, deskripsi, lokasiDetail, lokasiTag, imageBuffer: buf, imageMimetype: mtype } = pending.data;
    pendingLaporan.delete(sessionId);

    const lampiranPath = buf && mtype ? tempFilePath(buf, mtype) : null;
    if (lampiranPath) fs.writeFileSync(lampiranPath, buf);

    const id = await insertLaporanLayanan({
      kategori,
      deskripsi,
      lokasiDetail: lokasiDetail || humanWilayah(lokasiTag),
      wilayahTag: lokasiTag,
      fotoPath: lampiranPath,
      fotoOcr: imageText || null,
      portalTarget: "laporgub",
      messageId,
      sessionId,
      notes: null,
    });

    await updateLaporanLayananStatus(id, "confirmed");
    try {
      const result = await submitLaporGub({ isiAduan: deskripsi, lokasiAduan: lokasiDetail || humanWilayah(lokasiTag), jenisAduan: "Public", lampiranPath });
      if (result.success) {
        await updateLaporanLayananStatus(id, "submitted", {
          nomor_ticket: result.ticketNumber || null,
          submitted_at: new Date().toISOString(),
          notes: "Dikirim otomatis ke LaporGub",
        });
        await insertLaporanLayananSubmitLog({ laporanId: id, portal: "laporgub", attempt: 1, status: "success", errorMsg: null });
        return {
          reply: `✅ Aduan sudah dikirim ke LaporGub. Nomor tiket: *${result.ticketNumber || "tidak tersedia"}*.`,
        };
      }
      await updateLaporanLayananStatus(id, "failed", { notes: result.error });
      await insertLaporanLayananSubmitLog({ laporanId: id, portal: "laporgub", attempt: 1, status: "failed", errorMsg: result.error });
      return { reply: `⚠️ Aduan gagal dikirim: ${result.error}. Nanti coba lagi ya.` };
    } catch (err) {
      await updateLaporanLayananStatus(id, "failed", { notes: err.message });
      await insertLaporanLayananSubmitLog({ laporanId: id, portal: "laporgub", attempt: 1, status: "failed", errorMsg: err.message });
      return { reply: `⚠️ Gagal mengirim aduan karena: ${err.message}` };
    }
  }

  pendingLaporan.delete(sessionId);
  return null;
}
