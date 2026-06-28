import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatJson } from "../llm/openrouter.js";
import { hasAduanKonten, hasLLM } from "../config.js";
import { insertLaporanLayanan, updateLaporanLayananStatus, insertLaporanLayananSubmitLog } from "../db/index.js";
import { ADUANKONTEN_CATEGORIES, submitAduanKonten } from "../portal/aduankonten.js";

const URL_RE = /\b(?:https?:\/\/[^\s<>"'`]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"'`]*)?)/i;
const REPORT_WORDS = /\b(lapor|laporkan|pengaduan|aduan|adukan|report|blokir|blokirkan|takedown|take\s*down)\b/i;
const EXPLICIT_ADUANKONTEN_HINTS = /\b(aduan\s*konten|konten\s*negatif|blokir|blokirkan|takedown|take\s*down)\b/i;
const NEGATIVE_CONTENT_HINTS = /\b(judi|slot|togel|casino|taruhan|betting|penipuan|phishing|scam|hoaks|hoax|pinjol\s*ilegal|investasi\s*ilegal|pornografi|porno|pemerasan|malware|retas|kebocoran\s*data)\b/i;
const PENDING_TTL = 15 * 60 * 1000;

const pendingKonten = new Map();

function getPending(sessionId) {
  if (!sessionId) return null;
  const data = pendingKonten.get(sessionId);
  if (!data) return null;
  if (Date.now() - data.ts > PENDING_TTL) {
    pendingKonten.delete(sessionId);
    return null;
  }
  return data;
}

export function hasPendingLaporKonten(sessionId) {
  return Boolean(getPending(sessionId));
}

function isAffirmative(text) {
  return /\b(ya|oke|ok|iya|yes|betul|lanjut|kirim)\b/i.test(text || "");
}

function isNegative(text) {
  return /\b(tidak|enggak|ga|gak|batal|nanti|jangan)\b/i.test(text || "");
}

function cleanUrl(raw) {
  return String(raw || "")
    .trim()
    .replace(/[)\].,;!?]+$/g, "");
}

function extractUrl(text) {
  const match = String(text || "").match(URL_RE);
  return match ? cleanUrl(match[0]) : null;
}

function normalizeCategoryKey(value) {
  const key = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (ADUANKONTEN_CATEGORIES[key]) return key;
  if (key.includes("judi") || key.includes("slot") || key.includes("togel") || key.includes("casino")) return "perjudian";
  if (key.includes("hoaks") || key.includes("hoax") || key.includes("berita_bohong")) return "hoaks";
  if (key.includes("phishing") || key.includes("scam") || key.includes("tipu")) return "penipuan";
  if (key.includes("porno")) return "pornografi";
  if (key.includes("peras")) return "pemerasan";
  if (key.includes("sara")) return "sara";
  if (key.includes("hki")) return "hki";
  return null;
}

function detectCategoryKey(text, url = "") {
  const hay = `${text || ""} ${url || ""}`.toLowerCase();
  if (/\b(judi|slot|togel|casino|taruhan|betting)\b/i.test(hay)) return "perjudian";
  if (/\b(hoaks|hoax|berita bohong|disinformasi|misinformasi)\b/i.test(hay)) return "hoaks";
  if (/\b(phishing|scam|penipuan|tipu|otp|rekening|hadiah|undian|login palsu|akun palsu)\b/i.test(hay)) return "penipuan";
  if (/\b(pornografi|porno|seksual eksplisit)\b/i.test(hay)) return "pornografi";
  if (/\b(pemerasan|ancaman sebar|sextortion)\b/i.test(hay)) return "pemerasan";
  if (/\b(pinjol ilegal|investasi ilegal|keuangan ilegal)\b/i.test(hay)) return "rekomendasi_sektor";
  if (/\b(retas|malware|deface|kebocoran data|credential|kredensial)\b/i.test(hay)) return "keamanan_informasi";
  return "penipuan";
}

function defaultReason(categoryKey, url) {
  const host = cleanUrl(url);
  switch (categoryKey) {
    case "perjudian":
      return `URL ${host} diduga memuat promosi atau layanan perjudian online yang dapat diakses publik.`;
    case "hoaks":
      return `URL ${host} diduga memuat informasi bohong atau menyesatkan yang dapat merugikan masyarakat.`;
    case "pornografi":
      return `URL ${host} diduga memuat konten pornografi atau materi seksual eksplisit yang dapat diakses publik.`;
    case "pemerasan":
      return `URL ${host} diduga digunakan untuk pemerasan atau ancaman terhadap korban.`;
    case "rekomendasi_sektor":
      return `URL ${host} diduga memuat layanan keuangan ilegal atau konten negatif sektor terkait.`;
    case "keamanan_informasi":
      return `URL ${host} diduga melanggar keamanan informasi atau digunakan untuk mengambil data pengguna.`;
    case "penipuan":
    default:
      return `URL ${host} diduga digunakan untuk penipuan, phishing, atau modus yang merugikan masyarakat.`;
  }
}

function stripUrlFromText(text, url) {
  return String(text || "")
    .replace(url || "", "")
    .replace(URL_RE, "")
    .replace(/\b(lapor|laporkan|pengaduan|aduan|adukan|report|blokir|blokirkan|takedown|take\s*down)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function parseLaporKonten(text) {
  const fallbackUrl = extractUrl(text);
  const fallbackCategory = detectCategoryKey(text, fallbackUrl);
  const rawReason = fallbackUrl ? stripUrlFromText(text, fallbackUrl) : String(text || "").trim();
  const fallback = {
    url: fallbackUrl,
    categoryKey: fallbackCategory,
    reason: rawReason.length >= 20 ? rawReason.slice(0, 800) : defaultReason(fallbackCategory, fallbackUrl || "konten tersebut"),
  };

  if (!hasLLM()) return fallback;

  const prompt =
    `Kamu parser laporan konten negatif untuk aduankonten.id. Output JSON valid dengan properti:\n` +
    `{
  "url": "URL/domain/akun/aplikasi yang dilaporkan, atau null",
  "categoryKey": "pornografi|perjudian|pencemaran|penipuan|sara|kekerasan|produk_khusus|terorisme|separatisme|hki|keamanan_informasi|rekomendasi_sektor|sosial_budaya|hoaks|pemerasan",
  "reason": "alasan laporan minimal 20 karakter, tanpa data pribadi pelapor"
}` +
    `\n\nPesan: """${String(text || "").slice(0, 1600)}"""`;

  try {
    const parsed = await chatJson({
      tier: "fast",
      temperature: 0,
      maxTokens: 260,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: "Ekstrak data laporan konten negatif." },
      ],
    });
    const categoryKey = normalizeCategoryKey(parsed?.categoryKey) || fallback.categoryKey;
    const url = cleanUrl(parsed?.url || fallback.url || "");
    const reason = String(parsed?.reason || fallback.reason || defaultReason(categoryKey, url)).trim();
    return { url: url || null, categoryKey, reason: reason.length >= 20 ? reason.slice(0, 800) : defaultReason(categoryKey, url) };
  } catch {
    return fallback;
  }
}

function isAduanKontenIntent(text) {
  if (!text) return false;
  const hasUrl = Boolean(extractUrl(text));
  if (hasUrl && REPORT_WORDS.test(text) && (NEGATIVE_CONTENT_HINTS.test(text) || EXPLICIT_ADUANKONTEN_HINTS.test(text))) return true;
  if (REPORT_WORDS.test(text) && (EXPLICIT_ADUANKONTEN_HINTS.test(text) || /situs\s*judi|website\s*judi|link\s*judi/i.test(text))) return true;
  return false;
}

const ASK_URL = "Kirim URL/domain/akun yang ingin dilaporkan ke aduankonten.id.";
const ASK_REASON = "Tambahkan alasan laporannya minimal 20 huruf. Contoh: situs ini mempromosikan judi online atau diduga phishing.";
const ASK_CONFIRM = (categoryKey, url, reason) => {
  const category = ADUANKONTEN_CATEGORIES[categoryKey] || ADUANKONTEN_CATEGORIES.penipuan;
  return (
    `Ini laporan Aduan Konten untuk *${category.label}*:\n` +
    `URL: ${url}\n` +
    `Alasan: ${reason}\n\n` +
    "Balas *Ya* untuk saya kirim ke aduankonten.id, atau *Tidak* untuk batal."
  );
};

function tempFilePath(buffer, mimetype) {
  const ext = mimetype?.split("/")[1] || "jpg";
  const dir = path.join(os.tmpdir(), "warta-warga-aduankonten");
  fs.mkdirSync(dir, { recursive: true });
  const name = `aduankonten-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  return path.join(dir, name);
}

function buildData(parsed, previous = {}, media = {}) {
  previous = previous || {};
  media = media || {};
  const url = parsed.url || previous.url || null;
  const categoryKey = normalizeCategoryKey(parsed.categoryKey || previous.categoryKey) || detectCategoryKey(parsed.reason, url);
  const reason =
    String(parsed.reason || previous.reason || "").trim().length >= 20
      ? String(parsed.reason || previous.reason).trim().slice(0, 800)
      : defaultReason(categoryKey, url || "konten tersebut");
  return {
    url,
    categoryKey,
    reason,
    imageBuffer: media.imageBuffer || previous.imageBuffer || null,
    imageMimetype: media.imageMimetype || previous.imageMimetype || null,
    imageText: media.imageText || previous.imageText || null,
    messageId: media.messageId || previous.messageId || null,
  };
}

export async function handleLaporKonten({ text, imageText = null, imageBuffer = null, imageMimetype = null, sessionId = null, messageId = null }) {
  const pending = getPending(sessionId);
  if (pending) {
    return consumeLaporKontenReply({ sessionId, text, imageText, imageBuffer, imageMimetype, messageId });
  }

  if (!isAduanKontenIntent(text)) return null;

  const message = [text, imageText].filter(Boolean).join("\n\n");
  const parsed = await parseLaporKonten(message);
  const data = buildData(parsed, null, { imageText, imageBuffer, imageMimetype, messageId });

  if (!data.url) {
    pendingKonten.set(sessionId, { stage: "url", data, ts: Date.now() });
    return { reply: ASK_URL };
  }

  if (!data.reason || data.reason.length < 20) {
    pendingKonten.set(sessionId, { stage: "reason", data, ts: Date.now() });
    return { reply: ASK_REASON };
  }

  pendingKonten.set(sessionId, { stage: "confirm", data, ts: Date.now() });
  return { reply: ASK_CONFIRM(data.categoryKey, data.url, data.reason) };
}

async function consumeLaporKontenReply({ sessionId, text, imageText = null, imageBuffer = null, imageMimetype = null, messageId = null }) {
  const pending = getPending(sessionId);
  if (!pending) return null;

  if (pending.stage === "url") {
    const parsed = await parseLaporKonten([text, pending.data.reason].filter(Boolean).join("\n\n"));
    const data = buildData(parsed, pending.data, { imageText, imageBuffer, imageMimetype, messageId });
    if (!data.url) return { reply: ASK_URL };
    pendingKonten.set(sessionId, { stage: "confirm", data, ts: Date.now() });
    return { reply: ASK_CONFIRM(data.categoryKey, data.url, data.reason) };
  }

  if (pending.stage === "reason") {
    const parsed = await parseLaporKonten([pending.data.url, text, imageText].filter(Boolean).join("\n\n"));
    const data = buildData(parsed, pending.data, { imageText, imageBuffer, imageMimetype, messageId });
    if (!data.reason || data.reason.length < 20) return { reply: ASK_REASON };
    pendingKonten.set(sessionId, { stage: "confirm", data, ts: Date.now() });
    return { reply: ASK_CONFIRM(data.categoryKey, data.url, data.reason) };
  }

  if (pending.stage === "confirm") {
    if (isNegative(text)) {
      pendingKonten.delete(sessionId);
      return { reply: "Oke, laporan ke Aduan Konten tidak saya kirim." };
    }
    if (!isAffirmative(text)) {
      return { reply: "Balas *Ya* untuk mengirim laporan ke aduankonten.id, atau *Tidak* untuk batal." };
    }

    pendingKonten.delete(sessionId);
    return submitPendingLaporKonten({ ...pending.data, sessionId });
  }

  pendingKonten.delete(sessionId);
  return null;
}

async function submitPendingLaporKonten({ url, categoryKey, reason, imageBuffer, imageMimetype, imageText, messageId, sessionId }) {
  if (!hasAduanKonten()) {
    return { reply: "Konfigurasi Aduan Konten belum aktif." };
  }

  const category = ADUANKONTEN_CATEGORIES[categoryKey] || ADUANKONTEN_CATEGORIES.penipuan;
  const lampiranPath = imageBuffer && imageMimetype ? tempFilePath(imageBuffer, imageMimetype) : null;
  if (lampiranPath) fs.writeFileSync(lampiranPath, imageBuffer);

  const id = await insertLaporanLayanan({
    kategori: `aduankonten:${category.label}`,
    deskripsi: reason,
    lokasiDetail: url,
    wilayahTag: null,
    fotoPath: lampiranPath,
    fotoOcr: imageText || null,
    portalTarget: "aduankonten",
    messageId,
    sessionId,
    notes: null,
  });

  await updateLaporanLayananStatus(id, "confirmed");
  try {
    const result = await submitAduanKonten({
      url,
      categoryId: category.id,
      reason,
      attachmentPath: lampiranPath,
      headless: false,
    });
    if (result.duplicate) {
      await updateLaporanLayananStatus(id, "duplicate", {
        nomor_ticket: result.existingSubmissionId || null,
        submitted_at: new Date().toISOString(),
        notes: "Konten sudah pernah dilaporkan di AduanKonten",
      });
      await insertLaporanLayananSubmitLog({ laporanId: id, portal: "aduankonten", attempt: 1, status: "duplicate", errorMsg: null });
      const support = result.supportUrl ? `\nDukungan laporan: ${result.supportUrl}` : "";
      return { reply: `Konten ini sudah pernah dilaporkan di aduankonten.id.${support}` };
    }

    if (result.success) {
      await updateLaporanLayananStatus(id, "submitted", {
        nomor_ticket: result.ticketNumber || null,
        submitted_at: new Date().toISOString(),
        notes: "Dikirim otomatis ke AduanKonten",
      });
      await insertLaporanLayananSubmitLog({ laporanId: id, portal: "aduankonten", attempt: 1, status: "success", errorMsg: null });
      return { reply: `Laporan sudah dikirim ke aduankonten.id. Kode laporan: *${result.ticketNumber || "tidak tersedia"}*.` };
    }

    const error = result.error || "AduanKonten tidak mengembalikan status sukses";
    await updateLaporanLayananStatus(id, "failed", { notes: error });
    await insertLaporanLayananSubmitLog({ laporanId: id, portal: "aduankonten", attempt: 1, status: "failed", errorMsg: error });
    return { reply: `Aduan gagal dikirim ke aduankonten.id: ${error}` };
  } catch (err) {
    await updateLaporanLayananStatus(id, "failed", { notes: err.message });
    await insertLaporanLayananSubmitLog({ laporanId: id, portal: "aduankonten", attempt: 1, status: "failed", errorMsg: err.message });
    return { reply: `Gagal mengirim laporan ke aduankonten.id karena: ${err.message}` };
  }
}
