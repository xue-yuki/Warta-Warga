import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatJson } from "../llm/openrouter.js";
import { hasAduanKonten, hasLLM } from "../config.js";
import { insertLaporanLayanan, updateLaporanLayananStatus, insertLaporanLayananSubmitLog } from "../db/index.js";
import { ADUANKONTEN_CATEGORIES, submitAduanKonten } from "../portal/aduankonten.js";
import { inspectUrl } from "./checkurl.js";

const URL_RE = /\b(?:https?:\/\/[^\s<>"'`]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"'`]*)?)/i;
const REPORT_WORDS = /\b(lapor(?:kan|in)?|pengaduan|aduan|adukan|report|blokir|blokirkan|takedown|take\s*down)\b/i;
const EXPLICIT_ADUANKONTEN_HINTS = /\b(aduan\s*konten|konten\s*negatif|blokir|blokirkan|takedown|take\s*down)\b/i;
const WEB_REPORT_HINTS = /\b(situs|website|web|url|link|domain|akun|aplikasi)\b/i;
const NEGATIVE_CONTENT_HINTS = /\b(judi|slot|togel|casino|taruhan|betting|penipuan|phishing|scam|hoaks|hoax|pinjol\s*ilegal|investasi\s*ilegal|pornografi|porno|pemerasan|malware|retas|kebocoran\s*data)\b/i;
const GAMBLING_SITE_HINTS = /(?:\b(judi|slot|togel|casino|taruhan|betting|gacor|maxwin|scatter|pragmatic|pgsoft|habanero|spadegaming|sbobet|poker|roulette|blackjack|jackpot|zeus|olympus)\b|rtp\s*slot|mahjong\s*ways|starlight\s*princess|\bslot\d+\b|\bdewa\d+[a-z0-9-]*\b)/i;
const PENDING_TTL = 15 * 60 * 1000;
const RECENT_URL_TTL = 30 * 60 * 1000;

const pendingKonten = new Map();
const recentKontenUrls = new Map();

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
  return /\b(ya|oke|ok|iya|yes|betul|lanjut|kirim|lapor(?:kan|in)?|gas|setuju)\b/i.test(text || "");
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

function rememberKontenUrl(sessionId, url) {
  if (!sessionId || !url) return;
  recentKontenUrls.set(sessionId, { url: cleanUrl(url), ts: Date.now() });
}

function recentKontenUrl(sessionId) {
  if (!sessionId) return null;
  const data = recentKontenUrls.get(sessionId);
  if (!data) return null;
  if (Date.now() - data.ts > RECENT_URL_TTL) {
    recentKontenUrls.delete(sessionId);
    return null;
  }
  return data.url;
}

function isContextualReportIntent(text) {
  const raw = String(text || "");
  return REPORT_WORDS.test(raw) && (WEB_REPORT_HINTS.test(raw) || /\b(tadi|barusan|sebelumnya|itu|tersebut|aneh|bahaya|mencurigakan)\b/i.test(raw));
}

function isDangerousUrlReply(reply) {
  return /\b(BAHAYA|jangan buka|berbahaya|penipuan|phishing|scam|judi|slot|togel|casino|konten negatif|link mencurigakan|situs mencurigakan)\b/i.test(String(reply || ""));
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

function detectCategoryHintKey(text, url = "") {
  const hay = `${text || ""} ${url || ""}`.toLowerCase();
  if (GAMBLING_SITE_HINTS.test(hay)) return "perjudian";
  if (/\b(hoaks|hoax|berita bohong|disinformasi|misinformasi)\b/i.test(hay)) return "hoaks";
  if (/\b(phishing|scam|penipuan|tipu|otp|rekening|hadiah|undian|login palsu|akun palsu)\b/i.test(hay)) return "penipuan";
  if (/\b(pornografi|porno|seksual eksplisit)\b/i.test(hay)) return "pornografi";
  if (/\b(pemerasan|ancaman sebar|sextortion)\b/i.test(hay)) return "pemerasan";
  if (/\b(pinjol ilegal|investasi ilegal|keuangan ilegal)\b/i.test(hay)) return "rekomendasi_sektor";
  if (/\b(retas|malware|deface|kebocoran data|credential|kredensial)\b/i.test(hay)) return "keamanan_informasi";
  return null;
}

function detectCategoryKey(text, url = "") {
  const hinted = detectCategoryHintKey(text, url);
  if (hinted) return hinted;
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
    .replace(/\b(lapor(?:kan|in)?|pengaduan|aduan|adukan|report|blokir|blokirkan|takedown|take\s*down)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isWeakReason(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/\b(saya|aku|kami|mau|ingin|tolong|mohon|website|situs|web|link|url|domain|ini|tersebut|dong|ya)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  return normalized.length < 8;
}

function inspectionHaystack(inspection) {
  if (!inspection) return "";
  return [
    inspection.input_url,
    inspection.final_url,
    inspection.host,
    inspection.page_title,
    inspection.download_type,
    ...(inspection.redirect_chain || []).map((hop) => hop?.to),
    ...(inspection.field_mencurigakan || []),
    inspection.render_diblokir ? "render diblokir anti bot" : "",
    inspection.minta_data_sensitif ? "minta data sensitif phishing login otp password" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function describeInspectionTarget(inspection, fallbackUrl) {
  const finalUrl = inspection?.final_url || fallbackUrl;
  const host = inspection?.host || hostFromUrl(finalUrl);
  const title = String(inspection?.page_title || "").replace(/\s+/g, " ").trim();
  if (title && host) return `${title} (${host})`;
  if (host) return `domain ${host}`;
  return "konten tersebut";
}

function reasonFromInspection({ url, categoryKey, inspection, userReason }) {
  const target = describeInspectionTarget(inspection, url);
  const finalUrl = inspection?.final_url && inspection.final_url !== url ? inspection.final_url : null;
  const redirectNote = finalUrl ? ` URL pendek tersebut mengarah ke ${finalUrl}.` : "";

  if (categoryKey === "perjudian") {
    return `Berdasarkan pemeriksaan awal, URL ${url} mengarah ke ${target} yang diduga memuat promosi atau layanan perjudian online.${redirectNote}`;
  }
  if (categoryKey === "hoaks") {
    return `Berdasarkan pemeriksaan awal, URL ${url} diduga memuat informasi bohong atau menyesatkan yang dapat merugikan masyarakat.${redirectNote}`;
  }
  if (categoryKey === "pornografi") {
    return `Berdasarkan pemeriksaan awal, URL ${url} diduga memuat konten pornografi atau materi seksual eksplisit yang dapat diakses publik.${redirectNote}`;
  }
  if (categoryKey === "pemerasan") {
    return `Berdasarkan pemeriksaan awal, URL ${url} diduga digunakan untuk pemerasan atau ancaman terhadap korban.${redirectNote}`;
  }
  if (inspection?.minta_data_sensitif) {
    const fields = inspection.field_mencurigakan?.length ? ` seperti ${inspection.field_mencurigakan.join(", ")}` : "";
    return `Berdasarkan pemeriksaan awal, URL ${url} mengarah ke ${target} dan terindikasi meminta data sensitif${fields}, sehingga patut dilaporkan sebagai penipuan/phishing.${redirectNote}`;
  }
  if (inspection?.render_diblokir) {
    return `Berdasarkan pemeriksaan awal, URL ${url} mengarah ke ${target}, tetapi isi halaman sulit diperiksa otomatis. Link ini tetap patut ditinjau karena dilaporkan sebagai konten negatif.${redirectNote}`;
  }
  if (inspection?.ok === false || inspection?.unreachable) {
    return `URL ${url} perlu ditinjau oleh AduanKonten karena dilaporkan sebagai konten negatif, namun pemeriksaan awal belum berhasil mengakses isi halaman.`;
  }
  if (userReason && !isWeakReason(userReason)) {
    return userReason.slice(0, 800);
  }
  return defaultReason(categoryKey, url);
}

async function classifyWithInspection({ url, userReason, categoryKey, inspection }) {
  const inspectedText = inspectionHaystack(inspection);
  const inspectionCategory = detectCategoryHintKey(inspectedText, url);
  const userCategory = detectCategoryHintKey(userReason, "");
  const fallbackCategory = inspectionCategory || userCategory || normalizeCategoryKey(categoryKey) || "penipuan";
  const fallback = {
    categoryKey: fallbackCategory,
    reason: reasonFromInspection({
      url,
      categoryKey: fallbackCategory,
      inspection,
      userReason,
    }),
  };

  if (!hasLLM() || !inspection) return fallback;

  try {
    const parsed = await chatJson({
      tier: "fast",
      temperature: 0,
      maxTokens: 280,
      messages: [
        {
          role: "system",
          content:
            "Kamu mengklasifikasikan hasil pemeriksaan awal URL untuk laporan aduankonten.id. " +
            "Gunakan hanya data pemeriksaan yang diberikan. Jangan mengarang fakta. " +
            "Return JSON valid: {\"categoryKey\":\"pornografi|perjudian|pencemaran|penipuan|sara|kekerasan|produk_khusus|terorisme|separatisme|hki|keamanan_informasi|rekomendasi_sektor|sosial_budaya|hoaks|pemerasan\",\"reason\":\"alasan laporan 1 kalimat, minimal 20 karakter, diawali 'Berdasarkan pemeriksaan awal' jika memakai hasil pemeriksaan\"}.",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              url,
              userReason,
              currentCategory: categoryKey,
              inspection: {
                ok: inspection.ok,
                input_url: inspection.input_url,
                final_url: inspection.final_url,
                host: inspection.host,
                page_title: inspection.page_title,
                redirect_chain: inspection.redirect_chain,
                is_download: inspection.is_download,
                download_type: inspection.download_type,
                minta_data_sensitif: inspection.minta_data_sensitif,
                field_mencurigakan: inspection.field_mencurigakan,
                render_diblokir: inspection.render_diblokir,
                error: inspection.error,
              },
            },
            null,
            2,
          ),
        },
      ],
    });
    const parsedCategory = inspectionCategory || normalizeCategoryKey(parsed?.categoryKey) || fallback.categoryKey;
    const parsedReason = String(parsed?.reason || "").trim();
    const fallbackReason = reasonFromInspection({ url, categoryKey: parsedCategory, inspection, userReason });
    return {
      categoryKey: parsedCategory,
      reason: inspectionCategory ? fallbackReason : parsedReason.length >= 20 && !isWeakReason(parsedReason) ? parsedReason.slice(0, 800) : fallbackReason,
    };
  } catch {
    return fallback;
  }
}

async function enrichWithUrlInspection(data, userText = "") {
  if (!data?.url) return data;
  const userReason = String(data.reason || "").trim();
  let inspection = null;
  try {
    inspection = await inspectUrl(data.url);
  } catch (err) {
    inspection = { ok: false, input_url: data.url, final_url: data.url, error: err?.message || String(err) };
  }
  const classified = await classifyWithInspection({
    url: data.url,
    userReason,
    categoryKey: data.categoryKey,
    inspection,
    userText,
  });
  return {
    ...data,
    categoryKey: classified.categoryKey,
    reason: classified.reason,
  };
}

async function parseLaporKonten(text) {
  const fallbackUrl = extractUrl(text);
  const fallbackCategory = detectCategoryKey(text, fallbackUrl);
  const rawReason = fallbackUrl ? stripUrlFromText(text, fallbackUrl) : String(text || "").trim();
  const fallback = {
    url: fallbackUrl,
    categoryKey: fallbackCategory,
    reason: rawReason.length >= 20 && !isWeakReason(rawReason) ? rawReason.slice(0, 800) : defaultReason(fallbackCategory, fallbackUrl || "konten tersebut"),
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
    return { url: url || null, categoryKey, reason: reason.length >= 20 && !isWeakReason(reason) ? reason.slice(0, 800) : fallback.reason };
  } catch {
    return fallback;
  }
}

function isAduanKontenIntent(text) {
  if (!text) return false;
  const hasUrl = Boolean(extractUrl(text));
  if (hasUrl && REPORT_WORDS.test(text) && WEB_REPORT_HINTS.test(text)) return true;
  if (hasUrl && REPORT_WORDS.test(text) && (NEGATIVE_CONTENT_HINTS.test(text) || EXPLICIT_ADUANKONTEN_HINTS.test(text))) return true;
  if (REPORT_WORDS.test(text) && (EXPLICIT_ADUANKONTEN_HINTS.test(text) || /situs\s*judi|website\s*judi|link\s*judi/i.test(text))) return true;
  return false;
}

export function rememberAduanKontenUrlFromText(sessionId, text) {
  const url = extractUrl(text);
  if (url) rememberKontenUrl(sessionId, url);
  return url;
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

  let message = [text, imageText].filter(Boolean).join("\n\n");
  const directUrl = extractUrl(message);
  if (directUrl) rememberKontenUrl(sessionId, directUrl);

  if (!directUrl && isContextualReportIntent(message)) {
    const rememberedUrl = recentKontenUrl(sessionId);
    if (rememberedUrl) {
      message = `${message}\n${rememberedUrl}`;
    } else {
      const parsed = await parseLaporKonten(message);
      const data = buildData(parsed, null, { imageText, imageBuffer, imageMimetype, messageId });
      pendingKonten.set(sessionId, { stage: "url", data, ts: Date.now() });
      return { reply: ASK_URL };
    }
  } else if (!isAduanKontenIntent(message)) {
    return null;
  }

  const parsed = await parseLaporKonten(message);
  let data = buildData(parsed, null, { imageText, imageBuffer, imageMimetype, messageId });
  data = await enrichWithUrlInspection(data, message);

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

export async function maybeOfferAduanKontenReport({ text, reply, imageText = null, imageBuffer = null, imageMimetype = null, sessionId = null, messageId = null }) {
  const message = [text, imageText].filter(Boolean).join("\n\n");
  const url = extractUrl(message);
  if (!url || !reply || !isDangerousUrlReply(reply)) return reply;
  if (getPending(sessionId)) return reply;

  rememberKontenUrl(sessionId, url);
  const parsed = await parseLaporKonten(`laporkan link ini ${url}`);
  let data = buildData(parsed, null, { imageText, imageBuffer, imageMimetype, messageId });
  data = await enrichWithUrlInspection(data, message);

  if (!data?.url || !data?.reason) return reply;
  pendingKonten.set(sessionId, { stage: "confirm", data, ts: Date.now() });
  return `${reply}\n\n${ASK_CONFIRM(data.categoryKey, data.url, data.reason)}`;
}

async function consumeLaporKontenReply({ sessionId, text, imageText = null, imageBuffer = null, imageMimetype = null, messageId = null }) {
  const pending = getPending(sessionId);
  if (!pending) return null;

  if (pending.stage === "url") {
    const parsed = await parseLaporKonten([text, pending.data.reason].filter(Boolean).join("\n\n"));
    let data = buildData(parsed, pending.data, { imageText, imageBuffer, imageMimetype, messageId });
    data = await enrichWithUrlInspection(data, text);
    if (!data.url) return { reply: ASK_URL };
    pendingKonten.set(sessionId, { stage: "confirm", data, ts: Date.now() });
    return { reply: ASK_CONFIRM(data.categoryKey, data.url, data.reason) };
  }

  if (pending.stage === "reason") {
    const parsed = await parseLaporKonten([pending.data.url, text, imageText].filter(Boolean).join("\n\n"));
    let data = buildData(parsed, pending.data, { imageText, imageBuffer, imageMimetype, messageId });
    data = await enrichWithUrlInspection(data, text);
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
