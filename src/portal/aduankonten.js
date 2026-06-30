import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { config, ROOT } from "../config.js";

const BASE_URL = String(config.aduankonten?.baseUrl || "https://aduankonten.id").replace(/\/+$/, "");
const SESSION_PATH = config.aduankonten?.sessionPath;
const DEBUG_DIR = config.aduankonten?.debugDir || "";
const USER_DATA_DIR = config.aduankonten?.userDataDir || "";
const PYTHON_BIN = config.aduankonten?.pythonPath || process.env.ADUANKONTEN_PYTHON || process.env.PYTHON || "python";
const DRIVER_SCRIPT = config.aduankonten?.seleniumBaseScript || path.resolve(ROOT, "scripts", "aduankonten_seleniumbase.py");

export const ADUANKONTEN_CATEGORIES = Object.freeze({
  pornografi: { id: "1", label: "Pornografi" },
  perjudian: { id: "2", label: "Perjudian" },
  pencemaran: { id: "3", label: "Fitnah/Pencemaran Nama Baik" },
  penipuan: { id: "4", label: "Penipuan" },
  sara: { id: "5", label: "SARA" },
  kekerasan: { id: "6", label: "Kekerasan/Kekerasan Pada Anak" },
  produk_khusus: { id: "7", label: "Perdagangan Produk dengan aturan khusus" },
  terorisme: { id: "8", label: "Terorisme/Radikalisme" },
  separatisme: { id: "9", label: "Separatisme/Organisasi Berbahaya" },
  hki: { id: "10", label: "Hak Kekayaan Intelektual" },
  keamanan_informasi: { id: "11", label: "Pelanggaran Keamanan Informasi" },
  rekomendasi_sektor: { id: "12", label: "Konten Negatif yang Direkomendasikan Instansi Sektor" },
  sosial_budaya: { id: "13", label: "Konten yang Melanggar Nilai Sosial dan Budaya" },
  hoaks: { id: "14", label: "Berita Bohong/HOAKS" },
  pemerasan: { id: "15", label: "Pemerasan" },
});

function normalizeUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function absoluteUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, BASE_URL).toString();
  } catch {
    return href;
  }
}

function cleanText(value) {
  if (!value) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function uniqueItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function tempJsonPath(prefix) {
  const dir = path.join(os.tmpdir(), "warta-warga-aduankonten");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function splitCommand(value) {
  const raw = String(value || "").trim();
  if (!raw) return ["python", []];
  const parts = raw.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  const cleaned = parts.map((part) => part.replace(/^["']|["']$/g, ""));
  return [cleaned[0], cleaned.slice(1)];
}

function buildDriverPayload(operation, payload = {}) {
  return {
    operation,
    baseUrl: BASE_URL,
    sessionPath: SESSION_PATH || null,
    userDataDir: USER_DATA_DIR || null,
    debugDir: payload.debugDir ?? DEBUG_DIR,
    userAgent: config.aduankonten?.userAgent || "",
    headless: Boolean(payload.headless),
    challengeWaitMs: Number(payload.challengeWaitMs || payload.waitMs || 30000),
    ...payload,
  };
}

async function runSeleniumBase(operation, payload = {}, { timeoutMs = 360000 } = {}) {
  if (!fs.existsSync(DRIVER_SCRIPT)) {
    throw new Error(`Driver SeleniumBase AduanKonten tidak ditemukan: ${DRIVER_SCRIPT}`);
  }

  const inputPath = tempJsonPath("input");
  const outputPath = tempJsonPath("output");
  const driverPayload = buildDriverPayload(operation, payload);
  fs.writeFileSync(inputPath, JSON.stringify(driverPayload), "utf8");

  const [command, extraArgs] = splitCommand(PYTHON_BIN);
  const args = [...extraArgs, DRIVER_SCRIPT, "--input", inputPath, "--output", outputPath];
  let stdout = "";
  let stderr = "";

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: ROOT,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
        },
        windowsHide: false,
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Timeout menjalankan SeleniumBase AduanKonten setelah ${timeoutMs} ms`));
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 0);
      });
    });

    let result = null;
    if (fs.existsSync(outputPath)) {
      const raw = fs.readFileSync(outputPath, "utf8").trim();
      if (raw) {
        try {
          result = JSON.parse(raw);
        } catch (err) {
          throw new Error(`Output SeleniumBase AduanKonten bukan JSON valid: ${err.message}`);
        }
      }
    }

    if (exitCode !== 0) {
      const detail = cleanText(stderr || stdout).slice(0, 2000);
      throw new Error(`SeleniumBase AduanKonten keluar dengan kode ${exitCode}${detail ? `: ${detail}` : ""}`);
    }

    if (!result) {
      const detail = cleanText(stderr || stdout).slice(0, 2000);
      throw new Error(`SeleniumBase AduanKonten tidak menghasilkan output JSON${detail ? `: ${detail}` : ""}`);
    }

    if (result.success === false) {
      const detail = cleanText(result.error || stderr || stdout).slice(0, 2000);
      throw new Error(detail || "SeleniumBase AduanKonten gagal");
    }

    return result;
  } finally {
    fs.rmSync(inputPath, { force: true });
    fs.rmSync(outputPath, { force: true });
  }
}

export function parseAduanKontenStatus(html, ticket = null) {
  const $ = cheerio.load(html || "");
  $("script, style, noscript, svg").remove();

  function detailByHeading(labelPattern) {
    let value = "";
    $("h6").each((_, el) => {
      if (value) return;
      const label = cleanText($(el).text()).replace(/:$/, "");
      if (!labelPattern.test(label)) return;
      const next = $(el).nextAll("p, .support-box").first();
      value = cleanText(next.text());
    });
    return value;
  }

  const reportedUrl =
    absoluteUrl($('p:contains("Link:") a').first().attr("href")) ||
    cleanText($('p:contains("Link:")').first().text()).replace(/^Link:\s*/i, "") ||
    null;
  const previewTitle = cleanText($('[name="title_preview"]').first().text()) || null;
  const supportCode = cleanText($(".support-code").first().text()) || null;
  const details = {
    reportedUrl,
    previewTitle,
    status: detailByHeading(/^Status Laporan$/i) || null,
    totalPelapor: detailByHeading(/^Total Pelapor$/i) || null,
    tanggalLapor: detailByHeading(/^Tanggal Lapor$/i) || null,
    tanggalDiperbarui: detailByHeading(/^Tanggal Diperbaharui|Tanggal Diperbarui$/i) || null,
    category: detailByHeading(/^Kandungan Konten$/i) || null,
    dasarHukum: detailByHeading(/^Dasar Hukum$/i) || null,
    officialResponse: detailByHeading(/^Tanggapan Resmi$/i) || null,
    supportCode,
  };

  const items = [];
  $(".timeline-content, .timeline-item, .timeline, .history, .riwayat, .tracking, .card, .alert").each((_, el) => {
    const $el = $(el);
    const text = cleanText($el.text());
    if (!text || text.length < 8) return;
    if (/Aduan Konten|Kementerian Komunikasi|Privacy|Standard Pelayanan|Lacak Aduan/i.test(text) && text.length > 600) return;
    const title =
      cleanText($el.find(".timeline-title, .card-title, h1, h2, h3, h4, h5, strong").first().text()) ||
      text.slice(0, 80);
    const date = cleanText($el.find(".timeline-date, time, .date, .tanggal").first().text());
    const status = cleanText($el.find(".status, .badge, .label").first().text());
    items.push({ title, date, status, description: text });
  });

  $("tr").each((_, tr) => {
    const cells = $(tr)
      .find("th,td")
      .map((__, cell) => cleanText($(cell).text()))
      .get()
      .filter(Boolean);
    if (cells.length >= 2) {
      items.push({ title: cells[0], date: "", status: "", description: cells.slice(1).join(" | ") });
    }
  });

  const bodyText = cleanText($("body").text());
  const statusMatch = bodyText.match(/\b(diterima|diproses|proses|verifikasi|selesai|ditolak|diblokir|tidak\s+valid|valid)\b/i);
  const ticketMatch = bodyText.match(/\b[A-Z0-9]{6,12}\b/);

  const filtered = uniqueItems(items)
    .filter((item) => {
      const text = `${item.title} ${item.description}`;
      if (!text.trim()) return false;
      if (ticket && text.includes(ticket) && text.length < 20) return false;
      return true;
    })
    .slice(0, 20);

  return {
    ticket: ticket || details.supportCode || ticketMatch?.[0] || null,
    statusText: details.status || statusMatch?.[0] || null,
    details,
    items: filtered,
    text: bodyText.slice(0, 4000),
  };
}

export async function warmupAduanKontenSession({ headless = false, debugDir = DEBUG_DIR, waitMs = 300000 } = {}) {
  return await runSeleniumBase(
    "warmup",
    {
      headless,
      debugDir,
      waitMs,
      challengeWaitMs: waitMs,
    },
    { timeoutMs: Math.max(360000, waitMs + 60000) },
  );
}

export async function fetchAduanKontenStatus(ticket, { headless = true, debugDir = DEBUG_DIR, challengeWaitMs = 30000 } = {}) {
  const rawTicket = String(ticket || "").trim();
  if (!rawTicket) throw new Error("Kode laporan AduanKonten wajib diisi");

  const result = await runSeleniumBase(
    "status",
    {
      ticket: rawTicket,
      headless,
      debugDir,
      challengeWaitMs,
    },
    { timeoutMs: Math.max(240000, challengeWaitMs + 120000) },
  );
  const html = result.html || "";
  const parsed = parseAduanKontenStatus(html, rawTicket);
  return { html, ...parsed };
}

export async function probeAduanKontenSearch({ url, headless = true, debugDir = DEBUG_DIR, challengeWaitMs = 30000 }) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) throw new Error("URL konten wajib diisi");

  return await runSeleniumBase(
    "probe",
    {
      url: normalizedUrl,
      headless,
      debugDir,
      challengeWaitMs,
    },
    { timeoutMs: Math.max(300000, challengeWaitMs + 180000) },
  );
}

export async function submitAduanKonten({
  url,
  categoryId,
  reason,
  attachmentPath = null,
  headless = true,
  debugDir = DEBUG_DIR,
  challengeWaitMs = 30000,
}) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) throw new Error("URL konten wajib diisi");
  if (!categoryId) throw new Error("Kategori AduanKonten wajib diisi");
  if (!reason || String(reason).trim().length < 20) {
    throw new Error("Alasan AduanKonten minimal 20 karakter");
  }

  return await runSeleniumBase(
    "submit",
    {
      url: normalizedUrl,
      categoryId: String(categoryId),
      reason: String(reason).trim(),
      attachmentPath,
      headless,
      debugDir,
      challengeWaitMs,
    },
    { timeoutMs: Math.max(420000, challengeWaitMs + 240000) },
  );
}
