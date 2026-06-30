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
const PUBLIC_SERVICE_SUBJECTS = /\b(jalan|sampah|pdam|pln|listrik|air|kebersihan|fasilitas umum|lampu jalan|trotoar|saluran|drainase|jembatan|penerangan)\b/i;
const PUBLIC_SERVICE_PROBLEMS = /\b(rusak|berlubang|mati|padam|tidak\s+keluar|keruh|bocor|mampet|banjir|menumpuk|gelap|longsor|macet|patah|amblas|terputus|perlu\s+diperbaiki|tolong\s+diperbaiki)\b/i;
const REPORT_INTENT = /\b(lapor|aduan|pengaduan|adukan|ngadu|tolong|mohon)\b/i;
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

// Image store: simpan buffer gambar per sessionId agar bisa dipakai saat submitLaporanLayanan
// dipanggil dari brain.js (yang tidak punya akses ke imageBuffer langsung)
const imageStore = new Map(); // sessionId → { buffer, mimetype, text, ts }
const IMAGE_STORE_TTL = 30 * 60 * 1000; // 30 menit

export function storeImageForSession(sessionId, { imageBuffer, imageMimetype, imageText }) {
  if (!sessionId || !imageBuffer) return;
  imageStore.set(sessionId, { buffer: imageBuffer, mimetype: imageMimetype, text: imageText, ts: Date.now() });
}

function getStoredImage(sessionId) {
  if (!sessionId) return null;
  const e = imageStore.get(sessionId);
  if (!e) return null;
  if (Date.now() - e.ts > IMAGE_STORE_TTL) {
    imageStore.delete(sessionId);
    return null;
  }
  return e;
}

export function clearStoredImage(sessionId) {
  imageStore.delete(sessionId);
}

// Frasa yang hanya menyatakan niat melapor, bukan isi aduan — harus masuk stage content dulu
const INTENT_ONLY_PATTERNS = /^(mau lapor|ingin lapor|mo lapor|pengen lapor|lapor dong|lapor nih|lapor pak|lapor bu|mau aduan|ingin aduan|mo aduan|ada aduan|mau ngadu|ingin mengadu|pengaduan)\s*[.!?]?$/i;

// Sinyal bahasa yang menunjukkan warga mereferensikan gambar/foto tapi belum mengirimnya
const IMAGE_REFERENCE_SIGNALS = /\b(pada gambar|di gambar|gambarnya|fotonya|foto terlampir|terlampir|lihat gambar|seperti gambar|seperti foto|ada fotonya|ada gambarnya|foto di atas|gambar di atas|screenshot|screenshoot|tangkapan layar|ss nya|ss-nya|ini fotonya|ini gambarnya)\b/i;

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

export function isPublicServiceReportIntent(text) {
  if (!text) return false;
  if (!PUBLIC_SERVICE_SUBJECTS.test(text)) return false;
  if (!REPORT_INTENT.test(text) && !PUBLIC_SERVICE_PROBLEMS.test(text)) return false;
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

function cleanLaporgubLocationQuery(value) {
  return String(value || "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/^(kab(?:upaten)?\.?\s*|kota\s*|kec(?:amatan)?\.?\s*|kel(?:urahan)?\.?\s*|desa\s*)/i, "")
    .replace(/\b(?:rusak|berlubang|mati|padam|banjir|tolong|mohon|perlu|diperbaiki|diperhatikan)\b[\s\S]*$/i, "")
    .replace(/[.,;:!?()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferLaporgubLocationQuery(deskripsi, lokasiDetail, lokasiTag) {
  const text = String(deskripsi || "");
  const candidates = [];
  const re = /\b(?:di|ke|menuju|arah|sekitar|dekat|antara)\s+([^.,\n]+)/gi;
  let match;
  while ((match = re.exec(text))) {
    let segment = match[1] || "";
    if (/\bke\b/i.test(segment)) segment = segment.split(/\bke\b/i).pop();
    if (/\bdan\b/i.test(segment)) segment = segment.split(/\bdan\b/i).pop();
    const cleaned = cleanLaporgubLocationQuery(segment);
    if (cleaned && cleaned.length >= 3) candidates.push(cleaned);
  }

  const fromDescription = candidates.at(-1);
  if (fromDescription) return fromDescription;

  const explicit = cleanLaporgubLocationQuery(lokasiDetail);
  if (explicit) return explicit;

  return cleanLaporgubLocationQuery(humanWilayah(lokasiTag));
}

const ASK_SERVICE_DETAIL = 'Silakan ceritakan masalahnya ya. Contoh: "listrik mati di jalan Sudirman, Kota Semarang" atau "air PDAM tidak keluar sejak pagi".';
const ASK_SERVICE_LOCATION = 'Untuk mengirim aduan, sebutkan dulu kabupaten/kota yang terkena. Misal: "Kab. Banyumas" atau "Kota Semarang".';
const ASK_SERVICE_LOCATION_KONTEN = 'Untuk laporan konten internet, sebutkan URL/link situs yang ingin dilaporkan ya.';
const ASK_SERVICE_AWAITING_TEXT = 'Foto diterima 📷 Sekarang ceritakan masalahnya ya — apa yang terjadi, di mana lokasinya?';
const ASK_SERVICE_WANT_IMAGE = 'Kalau ada foto kondisinya, kirim sekarang ya — membantu aduan lebih kuat. Kalau tidak ada, balas *Tidak* untuk lanjut tanpa foto.';
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

  // Kasus: hanya gambar tanpa teks (caption kosong) — tunggu teks follow-up
  const hasImage = Boolean(imageBuffer);
  const hasText = Boolean(text && text.replace(/\[Isi gambar[^\]]*\]/gi, "").trim());
  if (hasImage && !hasText) {
    // Gambar dikirim tanpa teks — periksa apakah imageText dari OCR sudah cukup sebagai deskripsi
    if (!imageText || imageText.trim().length < 20) {
      // OCR tidak cukup → minta teks penjelasan dari warga
      pendingLaporan.set(sessionId, {
        stage: "awaiting_text",
        data: { imageBuffer, imageMimetype, imageText, messageId },
        ts: Date.now(),
      });
      return { reply: ASK_SERVICE_AWAITING_TEXT };
    }
    // OCR cukup → lanjut proses dengan imageText sebagai konten
  }

  if (!isServiceReportIntent(text || imageText || "")) return null;

  // "mau lapor" dan sejenisnya — hanya niat, bukan isi aduan → langsung minta detail
  if (INTENT_ONLY_PATTERNS.test((text || "").trim())) {
    pendingLaporan.set(sessionId, {
      stage: "content",
      data: { kategori: "lainnya", deskripsi: "", lokasiTag: null, imageBuffer, imageMimetype, imageText, messageId },
      ts: Date.now(),
    });
    return { reply: ASK_SERVICE_DETAIL };
  }

  const message = [text, imageText].filter(Boolean).join("\n\n");
  const parsed = await parseLaporanLayanan(message);
  const wilayahTag = normalizeLaporanLocation(detectWilayahFromText(message));

  if (!parsed.deskripsi || parsed.deskripsi.length < 20) {
    pendingLaporan.set(sessionId, {
      stage: "content",
      data: { kategori: parsed.kategori, deskripsi: parsed.deskripsi, lokasiTag: wilayahTag, imageBuffer, imageMimetype, imageText, messageId },
      ts: Date.now(),
    });
    return { reply: ASK_SERVICE_DETAIL };
  }

  // Teks ada tapi ada sinyal referensi gambar dan gambar belum dikirim → tanya gambar
  if (!hasImage && IMAGE_REFERENCE_SIGNALS.test(text || "")) {
    pendingLaporan.set(sessionId, {
      stage: "awaiting_image",
      data: { kategori: parsed.kategori, deskripsi: parsed.deskripsi, lokasiTag: wilayahTag, lokasiDetail: parsed.lokasi, messageId },
      ts: Date.now(),
    });
    return { reply: ASK_SERVICE_WANT_IMAGE };
  }

  // Konten internet: tidak perlu wilayah, langsung ke AduanKonten
  const portalEarly = resolvePortal(text || imageText || "", wilayahTag);
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
  const portal = resolvePortal(text || imageText || "", wilayahTag);
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

  // Stage: gambar sudah diterima, menunggu teks penjelasan dari warga
  if (pending.stage === "awaiting_text") {
    const prev = pending.data;
    if (!text || text.trim().length < 5) {
      return { reply: ASK_SERVICE_AWAITING_TEXT };
    }
    // Gabungkan teks baru dengan imageText dari gambar sebelumnya
    const mergedImageText = prev.imageText || null;
    const mergedBuffer = prev.imageBuffer;
    const mergedMimetype = prev.imageMimetype;
    pendingLaporan.delete(sessionId);
    // Re-proses dengan data lengkap (teks + gambar)
    return handleLaporLayanan({
      text,
      imageText: mergedImageText,
      imageBuffer: mergedBuffer,
      imageMimetype: mergedMimetype,
      sessionId,
      messageId: messageId || prev.messageId,
    });
  }

  // Stage: teks sudah ada, menunggu gambar (atau konfirmasi tidak ada gambar)
  if (pending.stage === "awaiting_image") {
    const prev = pending.data;
    const hasImage = Boolean(imageBuffer);
    if (isNegative(text) && !hasImage) {
      // Warga bilang tidak ada gambar → lanjut tanpa foto
      pendingLaporan.delete(sessionId);
      return handleLaporLayanan({
        text: prev.deskripsi,
        imageText: null,
        imageBuffer: null,
        imageMimetype: null,
        sessionId,
        messageId: prev.messageId,
      });
    }
    if (hasImage) {
      // Gambar diterima → gabungkan dengan deskripsi sebelumnya lalu lanjut
      pendingLaporan.delete(sessionId);
      return handleLaporLayanan({
        text: prev.deskripsi,
        imageText,
        imageBuffer,
        imageMimetype,
        sessionId,
        messageId: messageId || prev.messageId,
      });
    }
    // Pesan teks lain yang bukan "tidak" dan bukan gambar → tunggu lagi
    return { reply: ASK_SERVICE_WANT_IMAGE };
  }

  if (pending.stage === "content") {
    const prev = pending.data;
    const message = [text, imageText, prev.deskripsi].filter(Boolean).join("\n\n");
    const parsed = await parseLaporanLayanan(message);
    const lokasiTag = prev.lokasiTag || normalizeLaporanLocation(detectWilayahFromText(message));
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
      // Teks bukan nama kab/kota yang dikenali — cek apakah ini justru isi aduan (user salah urutan)
      const likelyContent = SERVICE_KEYWORDS.test(text) && text.trim().length > 10;
      if (likelyContent) {
        // Tampaknya user kirim isi aduan, bukan lokasi → gabung ke deskripsi dan tanya lokasi lagi
        const mergedDesc = [prev.deskripsi, text].filter(Boolean).join(". ");
        pendingLaporan.set(sessionId, { stage: "location", data: { ...prev, deskripsi: mergedDesc }, ts: Date.now() });
        return { reply: `Oke, catatannya sudah ditambah. Sekarang sebutkan kabupaten/kotanya ya — misal: "Kab. Banyumas" atau "Kota Semarang".` };
      }
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

/**
 * Dipanggil oleh brain.js saat LLM memutuskan untuk call tool kirim_aduan_layanan.
 * Menerima data yang sudah divalidasi LLM, langsung submit ke portal yang sesuai.
 * @returns {object} hasil yang akan dikirim balik ke LLM sebagai tool result
 */
export async function submitLaporanLayanan({ deskripsi, kabupatenKota, kategori = "lainnya", wilayahTagGrup = null, sessionId = null }) {
  // Tentukan wilayah tag
  let wilayahTag = wilayahTagGrup && isKabKota(wilayahTagGrup) ? wilayahTagGrup : null;
  if (!wilayahTag && kabupatenKota) {
    const norm = normalizeWilayahTag(kabupatenKota);
    if (isKabKota(norm)) wilayahTag = norm;
  }

  if (!wilayahTag) {
    return { ok: false, pesan: "Kabupaten/kota tidak dikenali. Sebutkan nama kabupaten atau kota yang lebih spesifik ya." };
  }

  if (!deskripsi || deskripsi.trim().length < 50) {
    return { ok: false, pesan: `Deskripsi aduan terlalu pendek (${deskripsi?.trim().length || 0} karakter). Perlu minimal 50 karakter — ceritakan lebih detail ya.` };
  }

  // Tentukan portal
  const portal = resolvePortal(deskripsi, wilayahTag);
  if (!portal || portal === "unknown") {
    return { ok: false, pesan: `Aduan layanan publik untuk wilayah *${humanWilayah(wilayahTag)}* belum didukung portal otomatis saat ini. Silakan lapor langsung ke portal resmi daerahmu ya.` };
  }

  // Simpan ke DB
  const id = await insertLaporanLayanan({
    kategori,
    deskripsi: deskripsi.trim(),
    lokasiDetail: kabupatenKota,
    wilayahTag,
    fotoPath: null,
    fotoOcr: null,
    portalTarget: portal,
    messageId: null,
    sessionId,
    notes: "Dikirim via LLM tool",
  });
  await updateLaporanLayananStatus(id, "confirmed");

  // Submit ke portal
  try {
    let hasil;
    // Strip prefix Kab./Kota dari kabupatenKota sebelum dikirim ke form
    // Form Select2 LaporGub mencari berdasarkan nama murni, bukan "Kab. Banyumas"
    const lokasiForm = kabupatenKota
      .replace(/^(kab(?:upaten)?\.?\s*|kota\s*)/i, "")
      .trim();

    // Ambil gambar yang tersimpan untuk sesi ini (dikirim sebelumnya via WhatsApp)
    const storedImg = getStoredImage(sessionId);
    let lampiranPath = null;
    if (storedImg?.buffer && storedImg?.mimetype) {
      lampiranPath = tempFilePath(storedImg.buffer, storedImg.mimetype);
      fs.writeFileSync(lampiranPath, storedImg.buffer);
    }
    clearStoredImage(sessionId);

    if (portal === "aduankonten") {
      hasil = await _submitToAduanKonten({ id, deskripsi: deskripsi.trim(), imageText: storedImg?.text || null, lampiranPath, kategori });
    } else {
      hasil = await _submitToLaporGub({ id, deskripsi: deskripsi.trim(), lokasiDetail: lokasiForm, lokasiTag: wilayahTag, lampiranPath });
    }
    return { ok: hasil.reply?.startsWith("✅"), pesan: hasil.reply };
  } catch (err) {
    await updateLaporanLayananStatus(id, "failed", { notes: err.message });
    await insertLaporanLayananSubmitLog({ laporanId: id, portal, attempt: 1, status: "failed", errorMsg: err.message });
    return { ok: false, pesan: `Gagal mengirim aduan: ${err.message}` };
  }
}
  // LaporGub mensyaratkan minimal 50 karakter — cek sebelum buka browser
async function _submitToLaporGub({ id, deskripsi, lokasiDetail, lokasiTag, lampiranPath }) {
  if (!deskripsi || deskripsi.trim().length < 50) {
    await updateLaporanLayananStatus(id, "failed", { notes: "Deskripsi aduan terlalu pendek (minimal 50 karakter)" });
    await insertLaporanLayananSubmitLog({ laporanId: id, portal: "laporgub", attempt: 1, status: "failed", errorMsg: "Deskripsi terlalu pendek" });
    return { reply: `⚠️ Deskripsi aduan terlalu pendek (${deskripsi?.trim().length || 0} karakter). LaporGub membutuhkan minimal 50 karakter. Silakan ceritakan masalahnya lebih detail ya — lokasi, kondisi, dan sudah berapa lama terjadi.` };
  }
  // LaporGub Select2 mencari Kota/Kecamatan/Kelurahan. Untuk aduan seperti
  // "Mersi ke Sokaraja", pakai detail lokasi di deskripsi alih-alih hanya "Banyumas".
  const lokasiAduan = inferLaporgubLocationQuery(deskripsi, lokasiDetail, lokasiTag);
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
