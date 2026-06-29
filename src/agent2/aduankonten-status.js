import { listAduanKontenReportsForSession } from "../db/index.js";
import { fetchAduanKontenStatus } from "../portal/aduankonten.js";
import { buildAduanKontenStatusText } from "./aduankonten-checker.js";

const STATUS_WORDS = /\b(status|perkembangan|progres|progress|lacak|cek|pantau|follow\s*up)\b/i;
const REPORT_WORDS = /\b(laporan|aduan|aduankonten|aduan\s*konten|kode|tiket|ticket)\b/i;
const LATEST_WORDS = /\b(tadi|terakhir|barusan|sebelumnya|baru\s+saja)\b/i;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isStatusIntent(text) {
  if (!text) return false;
  return STATUS_WORDS.test(text) && REPORT_WORDS.test(text);
}

function isLikelySupportCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9]{6,12}$/.test(code) && /[A-Z]/.test(code) && /\d/.test(code);
}

function extractTicket(text) {
  const raw = String(text || "");
  const withLabel = raw.match(/\b(?:kode|tiket|ticket|nomor)\s*(?:laporan|aduan)?\s*[:#-]?\s*([a-z0-9]{6,12})\b/i);
  if (withLabel?.[1] && isLikelySupportCode(withLabel[1])) {
    return withLabel[1].toUpperCase();
  }

  const uppercaseTokens = raw.match(/\b[A-Z0-9]{6,12}\b/g) || [];
  for (const token of uppercaseTokens) {
    if (isLikelySupportCode(token)) return token.toUpperCase();
  }
  return null;
}

function extractKeyword(text) {
  const raw = String(text || "");
  const match = raw.match(/\byang\s+(.+)$/i);
  if (!match?.[1]) return null;
  const keyword = cleanText(match[1])
    .replace(/\b(tadi|terakhir|barusan|sebelumnya|baru\s+saja)\b/gi, "")
    .replace(/\b(laporan|aduan|aduankonten|aduan\s*konten|status|kode|tiket|ticket|saya|aku|ku)\b/gi, "")
    .replace(/[^a-z0-9.\-_\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return keyword || null;
}

function keywordTerms(keyword) {
  const key = cleanText(keyword).toLowerCase();
  if (!key) return [];
  const terms = new Set([key]);
  if (/\b(judol|judi|perjudian|slot|togel|casino)\b/i.test(key)) {
    ["judol", "judi", "perjudian", "slot", "togel", "casino", "gacor"].forEach((term) => terms.add(term));
  }
  return [...terms];
}

function reportHaystack(report) {
  return [
    report?.nomor_ticket,
    report?.kategori,
    report?.deskripsi,
    report?.lokasi_detail,
    report?.foto_ocr,
    report?.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function statusHaystack(parsed) {
  const d = parsed?.details || {};
  return [
    parsed?.ticket,
    parsed?.statusText,
    d.reportedUrl,
    d.previewTitle,
    d.status,
    d.category,
    d.dasarHukum,
    d.officialResponse,
    d.supportCode,
    ...(parsed?.items || []).flatMap((item) => [item?.title, item?.status, item?.description]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function scoreTextForKeyword(text, keyword) {
  const hay = String(text || "").toLowerCase();
  let score = 0;
  for (const term of keywordTerms(keyword)) {
    if (hay.includes(term)) score += term === keyword.toLowerCase() ? 3 : 1;
  }
  return score;
}

function chooseReportByKeyword(reports, keyword) {
  let best = null;
  let bestScore = 0;
  for (const report of reports) {
    const score = scoreTextForKeyword(reportHaystack(report), keyword);
    if (score > bestScore) {
      best = report;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function reportLabel(report) {
  const category = cleanText(report?.kategori).replace(/^aduankonten:/i, "");
  const url = cleanText(report?.lokasi_detail);
  if (category && url) return `${category} (${url})`;
  return category || url || "laporan tersebut";
}

async function fetchAndFormat(ticket, { context = "", parsed = null } = {}) {
  parsed = parsed || (await fetchAduanKontenStatus(ticket, { headless: true }));
  const prefix = context ? `Ini status laporan AduanKonten ${context}:\n\n` : "";
  return `${prefix}${buildAduanKontenStatusText(ticket, parsed, { kind: "manual" })}`;
}

async function findReportByKeywordFromStatus(reports, keyword) {
  const candidates = reports.slice(0, 5);
  let lastError = null;
  for (const report of candidates) {
    const ticket = cleanText(report?.nomor_ticket).toUpperCase();
    if (!isLikelySupportCode(ticket)) continue;
    try {
      const parsed = await fetchAduanKontenStatus(ticket, { headless: true });
      if (scoreTextForKeyword(statusHaystack(parsed), keyword) > 0) {
        return { report, parsed };
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) return { error: lastError };
  return null;
}

export async function handleAduanKontenStatus({ text, sessionId = null }) {
  if (!isStatusIntent(text)) return null;

  const ticket = extractTicket(text);
  if (ticket) {
    try {
      return { reply: await fetchAndFormat(ticket) };
    } catch (err) {
      return {
        reply:
          `Saya belum bisa mengambil status AduanKonten untuk kode *${ticket}*.\n` +
          `Pastikan kodenya benar, lalu coba lagi. Detail error: ${err?.message || err}`,
      };
    }
  }

  const reports = sessionId ? await listAduanKontenReportsForSession(sessionId, { limit: 40 }) : [];
  if (!reports.length) {
    return {
      reply:
        "Saya belum menemukan riwayat laporan AduanKonten dari chat ini. " +
        "Kalau punya kode laporan, kirim seperti: *Bagaimana status laporan saya di kode M34WQDC*.",
    };
  }

  const keyword = extractKeyword(text);
  let selected = keyword ? chooseReportByKeyword(reports, keyword) : reports[0];
  let selectedParsed = null;
  if (keyword && !selected) {
    const resolved = await findReportByKeywordFromStatus(reports, keyword);
    if (resolved?.report) {
      selected = resolved.report;
      selectedParsed = resolved.parsed;
    } else if (resolved?.error) {
      return {
        reply:
          `Saya belum bisa mengecek detail laporan untuk mencari *${keyword}*.\n` +
          `Detail error: ${resolved.error?.message || resolved.error}`,
      };
    }
  }
  if (keyword && !selected) {
    return {
      reply:
        `Saya belum menemukan laporan AduanKonten dari chat ini yang cocok dengan *${keyword}*.\n` +
        "Coba kirim kode laporannya, atau tanya: *bagaimana status laporan saya tadi*.",
    };
  }

  if (!selected && !LATEST_WORDS.test(text)) {
    return {
      reply:
        "Saya belum bisa menentukan laporan mana yang dimaksud. " +
        "Coba sebutkan kodenya, atau tulis kata kunci seperti *yang judol* / *yang koko88*.",
    };
  }

  const selectedTicket = cleanText(selected?.nomor_ticket).toUpperCase();
  if (!isLikelySupportCode(selectedTicket)) {
    return {
      reply:
        `Saya menemukan ${reportLabel(selected)}, tetapi kode dukungan AduanKonten belum tersimpan dengan format yang bisa dilacak otomatis. ` +
        "Kalau ada kode dari AduanKonten, kirim kodenya langsung.",
    };
  }

  try {
    return {
      reply: await fetchAndFormat(selectedTicket, {
        context: `untuk ${reportLabel(selected)}`,
        parsed: selectedParsed,
      }),
    };
  } catch (err) {
    return {
      reply:
        `Saya belum bisa mengambil status AduanKonten untuk kode *${selectedTicket}*.\n` +
        `Detail error: ${err?.message || err}`,
    };
  }
}
