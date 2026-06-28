import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "node:crypto";
import { config, hasLLM, hasLaporGub } from "../config.js";
import { chatJson } from "../llm/openrouter.js";
import { getLaporanLayanan, listSubmittedLaporanLayanan, updateLaporanLayananStatus } from "../db/index.js";
import { fetchLaporGubDetail } from "../portal/laporgub.js";

const USER_AGENT = "WartaWargaBot/0.1 (+https://github.com/wartawarga)";

let _notifySender = null;
let _timer = null;
let _running = false;

function sha1(str) {
  return crypto
    .createHash("sha1")
    .update(String(str || ""))
    .digest("hex");
}

function cleanText(value) {
  if (!value) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

export function setLaporgubNotifier(fn) {
  _notifySender = typeof fn === "function" ? fn : null;
}

function hasLaporgubNotifier() {
  return Boolean(_notifySender);
}

async function sendLaporgubNotification(jid, text) {
  if (!_notifySender) throw new Error("Laporgub notifier belum diset");
  await _notifySender(jid, text);
}

function recipientJidFromSessionId(sessionId) {
  if (!sessionId) return null;
  const str = String(sessionId);
  const lastColon = str.lastIndexOf(":");
  if (lastColon > 0) {
    const maybeGroup = str.slice(0, lastColon);
    const participant = str.slice(lastColon + 1);
    if (maybeGroup.endsWith("@g.us") && participant) {
      return participant;
    }
  }
  return str;
}

function ticketUrl(ticket) {
  const base = String(config.laporgub.baseUrl || "https://laporgub.jatengprov.go.id").replace(/\/+$/, "");
  return `${base}/detail/${encodeURIComponent(String(ticket).trim())}.html`;
}

async function fetchDetail(ticket) {
  if (hasLaporGub()) {
    return await fetchLaporGubDetail(ticket);
  }
  const url = ticketUrl(ticket);
  const res = await axios.get(url, { headers: { "User-Agent": USER_AGENT }, timeout: 20000 });
  return res.data;
}

function parseTimeline(html) {
  const $ = cheerio.load(html);
  let nodes = $(".timeline-content");
  if (!nodes.length) {
    nodes = $(".timeline-item .timeline-content");
  }

  const items = [];
  nodes.each((_, el) => {
    const $el = $(el);
    const title = cleanText($el.find(".timeline-title").text());
    const date = cleanText($el.find(".timeline-date").text());
    const user = cleanText($el.find(".timeline-user").text());
    let descHtml = $el.find(".timeline-description").html() || "";
    descHtml = descHtml
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<p[^>]*>/gi, "\n")
      .replace(/<\/p>/gi, "\n");
    const description = cleanText(cheerio.load(descHtml).text());
    if (title || date || user || description) {
      items.push({ title, date, responder: user, description });
    }
  });

  return items;
}

async function formatWithLLM(items) {
  const system = `You are a concise assistant that formats timeline updates into a strict JSON object. Given timeline entries extracted from an official site, you MUST NOT add new facts, invent dates, or change the meaning. Return a JSON object with keys:\n- items: array of {title, date, responder, description} (strings)\n- conclusion: one short paragraph (Indonesian) summarizing the current status, based ONLY on the provided entries.\nDo NOT include any markup or explanation outside the JSON.`;
  const body = ["Here are the timeline entries (preserve exact text):", ""];
  items.forEach((it, idx) => {
    body.push(`${idx + 1}. TITLE: ${it.title}`);
    body.push(`   DATE: ${it.date}`);
    body.push(`   RESPONDER: ${it.responder}`);
    body.push(`   DESCRIPTION: ${it.description}`);
    body.push("");
  });

  const parsed = await chatJson({
    tier: "fast",
    messages: [
      { role: "system", content: system },
      { role: "user", content: body.join("\n") },
    ],
  });
  if (!parsed) return null;
  if (Array.isArray(parsed.items)) {
    parsed.items = parsed.items.map((it) => ({
      title: String(it?.title || it?.timeline_title || it?.["Timeline Title"] || "").trim(),
      date: String(it?.date || it?.timeline_date || it?.["Timeline Date"] || "").trim(),
      responder: String(it?.responder || it?.user || it?.["Responder"] || "").trim(),
      description: String(it?.description || it?.timeline_description || it?.["Timeline Description"] || "").trim(),
    }));
  }
  return parsed;
}

function formatTemplate(items) {
  const lines = [];
  lines.push(`📌 Pembaruan Laporan — ${items.length} entri terbaru`);
  lines.push("");
  items.forEach((it) => {
    lines.push(`• *${it.title || "-"}*`);
    if (it.date) lines.push(`  Tanggal: ${it.date}`);
    if (it.responder) lines.push(`  Oleh: ${it.responder}`);
    if (it.description) lines.push(`  Isi: ${it.description}`);
    lines.push("");
  });
  const titles = items.map((i) => String(i.title || "").toLowerCase()).join(" ");
  let conclusion = `Ada ${items.length} pembaruan pada laporan Anda.`;
  if (titles.includes("verifikasi")) {
    conclusion = "Status: laporan sedang proses verifikasi oleh instansi terkait.";
  } else if (titles.includes("ditolak") || titles.includes("tidak layak")) {
    conclusion = "Status: laporan ditolak atau tidak layak menurut peninjau.";
  }
  lines.push(`Kesimpulan: ${conclusion}`);
  return { items, conclusion, text: lines.join("\n") };
}

function buildNotificationText(ticket, items, llmJson = null) {
  const lines = [];
  lines.push(`📌 Pembaruan LaporGub — tiket ${ticket}`);
  lines.push(`🔗 ${ticketUrl(ticket)}`);
  lines.push("");
  lines.push("Ada pembaruan baru pada laporan Anda. Berikut ringkasannya:");
  lines.push("");

  let textBody = null;
  if (llmJson && Array.isArray(llmJson.items) && llmJson.items.length > 0) {
    const itemsToUse = llmJson.items;
    const bodyLines = [];
    itemsToUse.forEach((it) => {
      bodyLines.push(`• *${it.title || "-"}*`);
      if (it.date) bodyLines.push(`  Tanggal: ${it.date}`);
      if (it.responder) bodyLines.push(`  Oleh: ${it.responder}`);
      if (it.description) bodyLines.push(`  Isi: ${it.description}`);
      bodyLines.push("");
    });
    if (llmJson.conclusion) bodyLines.push(`Kesimpulan: ${llmJson.conclusion}`);
    textBody = bodyLines.join("\n");
  }
  if (!textBody) {
    const tpl = formatTemplate(items);
    textBody = tpl.text;
  }

  lines.push(textBody);
  return lines.join("\n");
}

function fingerprintItems(items) {
  const normalized = items.map((it) => ({
    title: it.title || "",
    date: it.date || "",
    responder: it.responder || "",
    description: it.description || "",
  }));
  return sha1(JSON.stringify(normalized));
}

export async function checkLaporgubReport(laporan) {
  if (!laporan || !laporan.id) {
    throw new Error("Invalid laporan_layanan record");
  }
  if (!laporan.nomor_ticket) {
    return { id: laporan.id, status: "skip_no_ticket" };
  }

  const ticket = String(laporan.nomor_ticket).trim();
  const html = await fetchDetail(ticket);
  const items = parseTimeline(html);
  if (!items.length) {
    return { id: laporan.id, status: "skip_no_timeline", ticket };
  }

  const fingerprint = fingerprintItems(items);
  const prev = await getLaporanLayanan(laporan.id);
  if (prev?.last_status_check === fingerprint) {
    return { id: laporan.id, status: "unchanged", ticket };
  }

  let llmJson = null;
  if (hasLLM()) {
    try {
      llmJson = await formatWithLLM(items);
    } catch (err) {
      console.warn("[laporgub-checker] LLM formatting gagal:", err?.message || err);
      llmJson = null;
    }
  }

  const text = buildNotificationText(ticket, items, llmJson);
  const recipientJid = recipientJidFromSessionId(laporan.session_id);
  if (!recipientJid) {
    return { id: laporan.id, status: "skip_no_recipient", ticket, text };
  }
  if (!hasLaporgubNotifier()) {
    return { id: laporan.id, status: "skip_no_notifier", ticket, recipientJid, text };
  }

  try {
    await sendLaporgubNotification(recipientJid, text);
    await updateLaporanLayananStatus(laporan.id, laporan.status, { last_status_check: fingerprint });
    return { id: laporan.id, status: "sent", ticket, recipientJid };
  } catch (err) {
    return { id: laporan.id, status: "send_failed", ticket, recipientJid, error: err.message || String(err) };
  }
}

export async function runLaporgubCheckerOnce() {
  if (_running) {
    console.log("[laporgub-checker] sebelumnya masih jalan, lewati.");
    return;
  }
  _running = true;
  try {
    const reports = await listSubmittedLaporanLayanan({ portalTarget: "laporgub" });
    console.log(`[laporgub-checker] mengecek ${reports.length} laporan submitted`);
    for (const lap of reports) {
      try {
        const result = await checkLaporgubReport(lap);
        if (result.status === "sent") {
          console.log(`[laporgub-checker] update dikirim untuk ticket=${result.ticket} ke ${result.recipientJid}`);
        } else if (result.status === "unchanged") {
          console.log(`[laporgub-checker] tidak ada perubahan untuk ticket=${result.ticket}`);
        } else if (result.status.startsWith("skip")) {
          console.log(`[laporgub-checker] ${result.status} ticket=${result.ticket || lap.nomor_ticket || "unknown"}`);
        } else if (result.status === "send_failed") {
          console.warn(`[laporgub-checker] gagal kirim update ticket=${result.ticket} ke ${result.recipientJid}: ${result.error}`);
        }
      } catch (err) {
        console.warn(`[laporgub-checker] laporan id=${lap.id} gagal: ${err?.message || err}`);
      }
    }
  } finally {
    _running = false;
  }
}

export async function runLaporgubCheckerForTicket(ticket) {
  console.log(`[laporgub-checker] debug run untuk ticket=${ticket}`);
  const html = await fetchDetail(ticket);
  const items = parseTimeline(html);
  console.log(`[laporgub-checker] parsed items count=${items.length}`);
  items.forEach((item, index) => {
    console.log(`[laporgub-checker] item ${index}:`, item);
  });
  return items;
}

export function startLaporgubChecker() {
  const intervalHours = Number(config.laporgub.checkIntervalHours || 6);
  if (intervalHours <= 0) {
    console.log("[laporgub-checker] interval tidak valid, scheduler tidak aktif.");
    return;
  }

  if (_timer) clearInterval(_timer);
  const ms = intervalHours * 60 * 60 * 1000;
  _timer = setInterval(() => {
    runLaporgubCheckerOnce().catch((err) => console.warn("[laporgub-checker] error terjadwal:", err?.message || err));
  }, ms);
  _timer.unref?.();
  console.log(`[laporgub-checker] scheduler aktif tiap ${intervalHours} jam.`);
  runLaporgubCheckerOnce().catch((err) => console.warn("[laporgub-checker] error saat startup:", err?.message || err));
}
