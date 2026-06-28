import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatJson } from "../llm/openrouter.js";
import { hasLLM } from "../config.js";
import { detectWilayahFromText, normalizeWilayahTag, humanWilayah, isKabKota } from "../util/wilayah.js";
import { insertLaporanLayanan, updateLaporanLayananStatus, insertLaporanLayananSubmitLog } from "../db/index.js";
import { submitLaporGub } from "../portal/laporgub.js";
import { submitAduanKonten, ADUANKONTEN_CATEGORIES } from "../portal/aduankonten.js";
import { matchScamPattern } from "./lapor.js";

const SERVICE_KEYWORDS = /\b(lapor|aduan|pengaduan|adukan|rusak|mati listrik|mati air|jalan rusak|jalan berlubang|sampah|pdam|pln|listrik|air|jalan|kebersihan|fasilitas umum|lampu jalan|banjir|konten|situs|website|web|hoaks|hoax|pornografi|judi|penipuan online|sara|terorisme|radikalisme)\b/i;
// Sinyal yang mengarah ke penipuan OFFLINE/sosial — biarkan brain.js yang menangani.
// Kombinasikan juga dengan matchScamPattern dari lapor.js untuk coverage lebih luas.
const FRAUD_KEYWORDS = /\b(transfer|otp|pulsa|rekening|kartu kredit|hadiah|ngaku petugas|modus|biaya pencairan)\b/i;

const CATEGORY_PATTERNS = [
  { key: "listrik", re: /\b(listrik|pln|mati listrik|listrik padam|tagihan listrik)\b/i },
  { key: "air", re: /\b(air|pdam|mati air|air mati|pipa bocor)\b/i },
  { key: "jalan", re: /\b(jalan|berlubang|aspal|rusak jalan|jalur rusak|jalan rusak|macet)\b/i },
  { key: "sampah", re: /\b(sampah|pembuangan|tumpukan sampah|kebersihan|tpa|tempat sampah)\b/i },
  { key: "lainnya", re: /\b(fasilitas|umum|jalan umum|pelayanan umum|jenazah|trotoar|saluran)\b/i },
];

// Portal routing: tentukan portal mana yang cocok untuk sebuah aduan.
// LaporGub = hanya Jawa Tengah (kabupaten/kota di Jateng).
// AduanKonten = laporan konten internet negatif (URL/situs), berlaku nasional.
const JATENG_TAGS = new Set([
  "kabupaten:banyumas","kabupaten:cilacap","kabupaten:kebumen","kabupaten:purworejo",
  "kabupaten:wonosobo","kabupaten:magelang","kabupaten:boyolali","kabupaten:klaten",
  "kabupaten:sukoharjo","kabupaten:wonogiri","kabupaten:karanganyar","kabupaten:sragen",
  "kabupaten:grobogan","kabupaten:blora","kabupaten:rembang","kabupaten:pati",
  "kabupaten:kudus","kabupaten:jepara","kabupaten:demak","kabupaten:semarang",
  "kabupaten:temanggung","kabupaten:kendal","kabupaten:batang","kabupaten:pekalongan",
  "kabupaten:pemalang","kabupaten:tegal","kabupaten:brebes","kabupaten:purbalingga",
  "kabupaten:banjarnegara","kabupaten:magelang",
  "kota:semarang","kota:surakarta","kota:magelang","kota:salatiga",
  "kota:pekalongan","kota:tegal",
  "provinsi:jawa_tengah",
]);
const KONTEN_KEYWORDS = /\b(konten|situs|website|web|url|link|hoaks|hoax|pornografi|judi online|penipuan online|sara|terorisme|radikalisme|fitnah online)\b/i;

/**
 * Tentukan portal target berdasarkan isi aduan dan wilayah.
 * @returns {"laporgub"|"aduankonten"|null} null bila tidak ada portal yang cocok
 */
function resolvePortal(text, wilayahTag) {
  // Konten internet → AduanKonten (nasional, tidak perlu wilayah Jateng)
  if (KONTEN_KEYWORDS.test(text)) return "aduankonten";
  // Aduan layanan publik fisik → LaporGub hanya untuk wilayah Jateng
  if (wilayahTag && (JATENG_TAGS.has(wilayahTag) || wilayahTag === "provinsi:jawa_tengah")) return "laporgub";
  // Wilayah diketahui tapi bukan Jateng → tidak ada portal yang cocok saat ini
  if (wilayahTag && isKabKota(wilayahTag)) return null;
  // Wilayah belum diketahui → tunda keputusan (akan diputuskan setelah lokasi diketahui)
  return "unknown";
}

/** Mapping kategori aduan layanan → kategori AduanKonten (best-effort). */
function toAduanKontenCategory(text) {
  if (/\b(hoaks|hoax|bohong|fitnah)\b/i.test(text)) return ADUANKONTEN_CATEGORIES.hoaks.id;
  if (/\b(penipuan|scam|fraud)\b/i.test(text)) return ADUANKONTEN_CATEGORIES.penipuan.id;
  if (/\b(pornografi|porno|vulgar)\b/i.test(text)) return ADUANKONTEN_CATEGORIES.pornografi.id;
  if (/\b(judi|gambling|togel)\b/i.test(text)) return ADUANKONTEN_CATEGORIES.perjudian.id;
  if (/\b(sara|diskriminasi|kebencian)\b/i.test(text)) return ADUANKONTEN_CATEGORIES.sara.id;
  if (/\b(teroris|radikalis|isis|ekstremis)\b/i.test(text)) return ADUANKONTEN_CATEGORIES.terorisme.id;
  return ADUANKONTEN_CATEGORIES.hoaks.id; // default: hoaks sebagai kategori umum
}

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
  // Cek fraud patterns dari lapor.js (lebih komprehensif dari regex FRAUD_KEYWORDS)
  // Kalau teks mengandung pola penipuan → biarkan brain.js yang handle
  if (FRAUD_KEYWORDS.test(text)) return false;
  if (matchScamPattern(text)) return false;
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
  "lokasi": "nama kabupaten/kota spesifiknya, tanpa teks Kab./Kota dan sebagainya. null jika tidak ada.",
  "deskripsi": "ringkas 1-2 kalimat tentang masalahnya, tanpa nama/nomor. Jangan hilangkan informasi dan detail penting"
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
      lokasi: r?.lokasi ? cleanLokasiDetail(r.lokasi) : fallback.lokasi,
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

/** Bersihkan output LLM dari prefix Kab./Kota yang kadang ikut disertakan meski sudah diprompt. */
function cleanLokasiDetail(lokasi) {
  if (!lokasi) return lokasi;
  return String(lokasi)
    .replace(/^(kab(?:upaten)?\.?\s*|kota\s*)/i, "")
    .trim();
}

const ASK_SERVICE_DETAIL = 'Silakan ceritakan masalahnya ya. Contoh: "listrik mati di jalan Sudirman, Kota Semarang" atau "air PDAM tidak keluar sejak pagi".';
const ASK_SERVICE_LOCATION = 'Untuk mengirim aduan, sebutkan dulu kabupaten/kota yang terkena. Misal: "Kab. Banyumas" atau "Kota Semarang".';
const ASK_SERVICE_LOCATION_KONTEN = 'Untuk laporan konten internet, sebutkan URL/link situs yang ingin dilaporkan ya.';
const ASK_SERVICE_CONFIRM = (kategori, lokasi, deskripsi, portal = "laporgub") => {
  const portalLabel = portal === "aduankonten" ? "AduanKonten" : "LaporGub";
  const lokasiLabel = portal === "aduankonten" ? "" : ` untuk *${humanWilayah(lokasi)}*`;
  return `Ini aduan *${kategori}*${lokasiLabel}:\n${deskripsi}\n\n` +
    `Akan dikirim ke *${portalLabel}*. Kalau sudah benar, balas *Ya* untuk saya kirim. Kalau belum, balas *Tidak*.`;
};
const ASK_SERVICE_NO_PORTAL = (wilayah) =>
  `Maaf, untuk saat ini pengiriman aduan layanan publik otomatis baru tersedia untuk wilayah *Jawa Tengah* (via LaporGub). ` +
  `Wilayah *${humanWilayah(wilayah)}* belum didukung.\n\n` +
  `Untuk melaporkan, coba langsung ke portal resmi daerahmu ya 🙏`;

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

  // Konten internet: tidak perlu wilayah, langsung ke AduanKonten
  const portalEarly = resolvePortal(text, wilayahTag);
  if (portalEarly === "aduankonten") {
    pendingLaporan.set(sessionId, {
      stage: "confirm",
      data: { kategori: parsed.kategori, deskripsi: parsed.deskripsi, lokasiDetail: null, lokasiTag: null, portal: "aduankonten", imageBuffer, imageMimetype, messageId },
      ts: Date.now(),
    });
    return { reply: ASK_SERVICE_CONFIRM(parsed.kategori, null, parsed.deskripsi, "aduankonten") };
  }

  if (!wilayahTag) {
    pendingLaporan.set(sessionId, {
      stage: "location",
      data: { kategori: parsed.kategori, deskripsi: parsed.deskripsi, imageBuffer, imageMimetype, messageId },
      ts: Date.now(),
    });
    return { reply: ASK_SERVICE_LOCATION };
  }

  // Wilayah diketahui — cek coverage portal
  const portal = resolvePortal(text, wilayahTag);
  if (!portal || portal === "unknown") {
    return { reply: ASK_SERVICE_NO_PORTAL(wilayahTag) };
  }

  pendingLaporan.set(sessionId, {
    stage: "confirm",
    data: { kategori: parsed.kategori, deskripsi: parsed.deskripsi, lokasiDetail: parsed.lokasi, lokasiTag: wilayahTag, portal, imageBuffer, imageMimetype, messageId },
    ts: Date.now(),
  });

  return { reply: ASK_SERVICE_CONFIRM(parsed.kategori, wilayahTag, parsed.deskripsi, portal) };
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
      lokasiDetail: parsed.lokasi ? cleanLokasiDetail(parsed.lokasi) : prev.lokasiDetail,
      lokasiTag,
      imageBuffer: imageBuffer || prev.imageBuffer,
      imageMimetype: imageMimetype || prev.imageMimetype,
      messageId: messageId || prev.messageId,
    };

    // Cek AduanKonten dulu (konten internet tidak perlu wilayah)
    if (resolvePortal(data.deskripsi, lokasiTag) === "aduankonten") {
      data.portal = "aduankonten";
      pendingLaporan.set(sessionId, { stage: "confirm", data, ts: Date.now() });
      return { reply: ASK_SERVICE_CONFIRM(data.kategori, null, data.deskripsi, "aduankonten") };
    }

    if (!data.lokasiTag) {
      pendingLaporan.set(sessionId, { stage: "location", data, ts: Date.now() });
      return { reply: ASK_SERVICE_LOCATION };
    }

    const portal = resolvePortal(data.deskripsi, data.lokasiTag);
    if (!portal || portal === "unknown") {
      pendingLaporan.delete(sessionId);
      return { reply: ASK_SERVICE_NO_PORTAL(data.lokasiTag) };
    }
    data.portal = portal;
    pendingLaporan.set(sessionId, { stage: "confirm", data, ts: Date.now() });
    return { reply: ASK_SERVICE_CONFIRM(data.kategori, data.lokasiTag, data.deskripsi, portal) };
  }

  if (pending.stage === "location") {
    const prev = pending.data;
    const lokasiTag = normalizeLaporanLocation(text);
    if (!lokasiTag) {
      return { reply: ASK_SERVICE_LOCATION };
    }
    const portal = resolvePortal(prev.deskripsi || "", lokasiTag);
    if (!portal || portal === "unknown") {
      pendingLaporan.delete(sessionId);
      return { reply: ASK_SERVICE_NO_PORTAL(lokasiTag) };
    }
    const data = { ...prev, lokasiDetail: text.trim(), lokasiTag, portal };
    pendingLaporan.set(sessionId, { stage: "confirm", data, ts: Date.now() });
    return { reply: ASK_SERVICE_CONFIRM(data.kategori, data.lokasiTag, data.deskripsi, portal) };
  }

  if (pending.stage === "confirm") {
    if (isNegative(text)) {
      pendingLaporan.delete(sessionId);
      return { reply: "Oke, aduan tidak saya kirim. Kalau ingin coba lagi, silakan kirim kembali detailnya ya." };
    }
    if (!isAffirmative(text)) {
      const portal = pending.data.portal || "laporgub";
      const portalLabel = portal === "aduankonten" ? "AduanKonten" : "LaporGub";
      return { reply: `Silakan balas *Ya* jika mau saya kirim aduan ini ke ${portalLabel}, atau *Tidak* jika batal.` };
    }

    const { kategori, deskripsi, lokasiDetail, lokasiTag, portal = "laporgub", imageBuffer: buf, imageMimetype: mtype } = pending.data;
    pendingLaporan.delete(sessionId);

    const lampiranPath = buf && mtype ? tempFilePath(buf, mtype) : null;
    if (lampiranPath) fs.writeFileSync(lampiranPath, buf);

    const id = await insertLaporanLayanan({
      kategori,
      deskripsi,
      lokasiDetail: lokasiDetail || (lokasiTag ? humanWilayah(lokasiTag) : "-"),
      wilayahTag: lokasiTag,
      fotoPath: lampiranPath,
      fotoOcr: imageText || null,
      portalTarget: portal,
      messageId,
      sessionId,
      notes: null,
    });

    await updateLaporanLayananStatus(id, "confirmed");

    // Kirim ke portal yang sesuai
    try {
      if (portal === "aduankonten") {
        return await _submitToAduanKonten({ id, deskripsi, imageText, lampiranPath, kategori });
      }
      return await _submitToLaporGub({ id, deskripsi, lokasiDetail, lokasiTag, lampiranPath });
    } catch (err) {
      await updateLaporanLayananStatus(id, "failed", { notes: err.message });
      await insertLaporanLayananSubmitLog({ laporanId: id, portal, attempt: 1, status: "failed", errorMsg: err.message });
      return { reply: `⚠️ Gagal mengirim aduan karena: ${err.message}` };
    }
  }

  pendingLaporan.delete(sessionId);
  return null;
}

async function _submitToLaporGub({ id, deskripsi, lokasiDetail, lokasiTag, lampiranPath }) {
  // lokasiAduan: pakai lokasiDetail (nama bersih dari LLM, sudah di-strip prefix Kab./Kota),
  // fallback ke humanWilayah hanya kalau lokasiDetail benar-benar kosong.
  const lokasiAduan = lokasiDetail || humanWilayah(lokasiTag);
  const result = await submitLaporGub({
    isiAduan: deskripsi,
    lokasiAduan,
    jenisAduan: "Public",
    lampiranPath,
  });
  if (result.success) {
    await updateLaporanLayananStatus(id, "submitted", {
      nomor_ticket: result.ticketNumber || null,
      submitted_at: new Date().toISOString(),
      notes: "Dikirim otomatis ke LaporGub",
    });
    await insertLaporanLayananSubmitLog({ laporanId: id, portal: "laporgub", attempt: 1, status: "success", errorMsg: null });
    return { reply: `✅ Aduan sudah dikirim ke LaporGub. Nomor tiket: *${result.ticketNumber || "tidak tersedia"}*.` };
  }
  await updateLaporanLayananStatus(id, "failed", { notes: result.error });
  await insertLaporanLayananSubmitLog({ laporanId: id, portal: "laporgub", attempt: 1, status: "failed", errorMsg: result.error });
  return { reply: `⚠️ Aduan gagal dikirim: ${result.error}. Nanti coba lagi ya.` };
}

async function _submitToAduanKonten({ id, deskripsi, imageText, lampiranPath, kategori }) {
  // Ekstrak URL dari deskripsi/imageText untuk laporan konten
  const urlMatch = [deskripsi, imageText].filter(Boolean).join(" ").match(/https?:\/\/[^\s]+/i);
  const url = urlMatch?.[0] || null;
  if (!url) {
    await updateLaporanLayananStatus(id, "failed", { notes: "URL konten tidak ditemukan dalam deskripsi" });
    await insertLaporanLayananSubmitLog({ laporanId: id, portal: "aduankonten", attempt: 1, status: "failed", errorMsg: "URL konten tidak ditemukan" });
    return { reply: "⚠️ Laporan konten membutuhkan URL/link situs yang ingin dilaporkan. Silakan kirim ulang dengan menyertakan link-nya ya." };
  }

  const categoryId = toAduanKontenCategory(deskripsi);
  const result = await submitAduanKonten({
    url,
    categoryId,
    reason: deskripsi,
    attachmentPath: lampiranPath || null,
    headless: true,
  });

  if (result.success) {
    const ticket = result.ticketNumber || result.existingSubmissionId || null;
    const dupNote = result.duplicate ? " (konten sudah pernah dilaporkan sebelumnya)" : "";
    await updateLaporanLayananStatus(id, "submitted", {
      nomor_ticket: ticket,
      submitted_at: new Date().toISOString(),
      notes: `Dikirim otomatis ke AduanKonten${dupNote}`,
    });
    await insertLaporanLayananSubmitLog({ laporanId: id, portal: "aduankonten", attempt: 1, status: "success", errorMsg: null });
    return { reply: `✅ Laporan konten sudah dikirim ke AduanKonten${dupNote}. Kode laporan: *${ticket || "tidak tersedia"}*.` };
  }
  await updateLaporanLayananStatus(id, "failed", { notes: result.error || "Unknown error" });
  await insertLaporanLayananSubmitLog({ laporanId: id, portal: "aduankonten", attempt: 1, status: "failed", errorMsg: result.error || null });
  return { reply: `⚠️ Laporan konten gagal dikirim. Nanti coba lagi ya.` };
}
