import crypto from "node:crypto";
import { config, hasLLM } from "../config.js";
import { chatJson } from "../llm/openrouter.js";
import { getLaporanLayanan, listSubmittedLaporanLayanan, updateLaporanLayananStatus } from "../db/index.js";
import { fetchAduanKontenStatus } from "../portal/aduankonten.js";

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

function recipientJidFromSessionId(sessionId) {
  if (!sessionId) return null;
  const str = String(sessionId);
  const lastColon = str.lastIndexOf(":");
  if (lastColon > 0) {
    const maybeGroup = str.slice(0, lastColon);
    const participant = str.slice(lastColon + 1);
    if (maybeGroup.endsWith("@g.us") && participant) {
      // Kirim notifikasi ke grup (bukan japri) agar warga yang lapor di grup
      // dapat update di konteks yang sama. Baileys kirim ke grup butuh JID grup.
      return maybeGroup;
    }
  }
  // Japri: pastikan JID punya domain yang valid
  if (!str.includes("@")) return `${str}@s.whatsapp.net`;
  return str;
}

function statusUrl() {
  return String(config.aduankonten.baseUrl || "https://aduankonten.id").replace(/\/+$/, "");
}

function statusNotifyIntervalMs() {
  const hours = Number(config.aduankonten.checkIntervalHours || 6);
  return Math.max(1, Number.isFinite(hours) ? hours : 6) * 60 * 60 * 1000;
}

function isStatusNotificationDue(lastNotifiedAt) {
  if (!lastNotifiedAt) return true;
  const last = Date.parse(lastNotifiedAt);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= statusNotifyIntervalMs();
}

export function setAduanKontenNotifier(fn) {
  _notifySender = typeof fn === "function" ? fn : null;
}

function hasAduanKontenNotifier() {
  return Boolean(_notifySender);
}

async function sendAduanKontenNotification(jid, text) {
  if (!_notifySender) throw new Error("AduanKonten notifier belum diset");
  await _notifySender(jid, text);
}

function meaningfulItems(parsed) {
  if (!parsed?.items?.length) return [];
  return parsed.items
    .map((item) => ({
      title: cleanText(item.title),
      date: cleanText(item.date),
      status: cleanText(item.status),
      description: cleanText(item.description),
    }))
    .filter((item) => item.title || item.date || item.status || item.description)
    .filter((item) => !/^(Tinjauan Laporan|Detail Laporan)$/i.test(item.title));
}

function fingerprintStatus(parsed) {
  const payload = {
    ticket: parsed?.ticket || "",
    statusText: parsed?.statusText || "",
    items: meaningfulItems(parsed),
    text: cleanText(parsed?.text || "").slice(0, 2000),
  };
  return sha1(JSON.stringify(payload));
}

function detailLines(parsed) {
  const d = parsed?.details || {};
  const lines = [];
  if (d.status) lines.push(`Status laporan: ${d.status}`);
  if (d.category) lines.push(`Kandungan konten: ${d.category}`);
  if (d.reportedUrl) lines.push(`Link laporan: ${d.reportedUrl}`);
  if (d.previewTitle) lines.push(`Tinjauan: ${d.previewTitle}`);
  if (d.previewTitle && !/perjudian/i.test(d.category || "") && /\b(judol|judi|slot|togel|casino|sabung\s*ayam|sportsbook|gacor|taruhan|betting)\b/i.test(d.previewTitle)) {
    lines.push("Catatan: Tinjauan halaman mengandung sinyal perjudian. Untuk laporan baru, bot akan memakai kategori Perjudian saat preview AduanKonten menunjukkan pola ini.");
  }
  if (d.totalPelapor) lines.push(`Total pelapor: ${d.totalPelapor}`);
  if (d.tanggalLapor) lines.push(`Tanggal lapor: ${d.tanggalLapor}`);
  if (d.tanggalDiperbarui) lines.push(`Terakhir diperbarui: ${d.tanggalDiperbarui}`);
  if (d.officialResponse) lines.push(`Tanggapan resmi: ${d.officialResponse.slice(0, 700)}`);
  return lines;
}

async function formatWithLLM(parsed) {
  const items = meaningfulItems(parsed);
  const system =
    "Kamu memformat hasil lacak laporan AduanKonten menjadi JSON ketat. Jangan menambah fakta, tanggal, atau status. " +
    "Return JSON dengan keys: items array of {title,date,status,description}; conclusion string Indonesia singkat.";
  const body = [
    `Kode laporan: ${parsed.ticket || "-"}`,
    `Status terdeteksi: ${parsed.statusText || "-"}`,
    "",
    "Items:",
    ...items.map((it, index) => `${index + 1}. ${it.title} | ${it.date} | ${it.status} | ${it.description}`),
    "",
    "Teks halaman:",
    cleanText(parsed.text || "").slice(0, 2000),
  ].join("\n");

  const json = await chatJson({
    tier: "fast",
    temperature: 0,
    maxTokens: 400,
    messages: [
      { role: "system", content: system },
      { role: "user", content: body },
    ],
  });
  if (!json) return null;
  if (Array.isArray(json.items)) {
    json.items = json.items.map((item) => ({
      title: cleanText(item?.title),
      date: cleanText(item?.date),
      status: cleanText(item?.status),
      description: cleanText(item?.description),
    }));
  }
  json.conclusion = cleanText(json.conclusion);
  return json;
}

function formatTemplate(ticket, parsed) {
  const items = meaningfulItems(parsed);
  const lines = [];
  const details = detailLines(parsed);
  if (details.length) {
    lines.push(...details);
    lines.push("");
  }

  if (items.length) {
    for (const item of items.slice(0, 8)) {
      lines.push(`- *${item.title || item.status || "Pembaruan"}*`);
      if (item.date) lines.push(`  Tanggal: ${item.date}`);
      if (item.status && item.status !== item.title) lines.push(`  Status: ${item.status}`);
      if (item.description && item.description !== item.title) lines.push(`  Isi: ${item.description}`);
      lines.push("");
    }
  } else if (parsed.statusText && !details.length) {
    lines.push(`Status terdeteksi: ${parsed.statusText}`);
  } else if (!details.length) {
    lines.push("Ada perubahan pada halaman lacak AduanKonten, tetapi detail status belum bisa dipisahkan otomatis.");
  }

  const conclusion = parsed.statusText
    ? `Status terakhir yang terbaca: ${parsed.statusText}.`
    : "Silakan cek halaman AduanKonten untuk membaca detail lengkap.";
  lines.push(`Kesimpulan: ${conclusion}`);
  return { items, conclusion, text: lines.join("\n") };
}

function buildNotificationText(ticket, parsed, llmJson = null, { kind = "update" } = {}) {
  const lines = [];
  const isUpdate = kind === "update";
  const heading = isUpdate ? "Pembaruan AduanKonten" : "Status AduanKonten";
  lines.push(`${heading} - kode ${ticket}`);
  lines.push(`Lacak di: ${statusUrl()}`);
  lines.push("");
  lines.push(isUpdate ? "Ada pembaruan baru pada laporan Anda:" : "Status terkini laporan Anda:");
  lines.push("");

  let body = null;
  if (llmJson && Array.isArray(llmJson.items) && llmJson.items.length) {
    const bodyLines = [];
    for (const item of llmJson.items.slice(0, 8)) {
      bodyLines.push(`- *${item.title || item.status || "Pembaruan"}*`);
      if (item.date) bodyLines.push(`  Tanggal: ${item.date}`);
      if (item.status && item.status !== item.title) bodyLines.push(`  Status: ${item.status}`);
      if (item.description && item.description !== item.title) bodyLines.push(`  Isi: ${item.description}`);
      bodyLines.push("");
    }
    if (llmJson.conclusion) bodyLines.push(`Kesimpulan: ${llmJson.conclusion}`);
    body = bodyLines.join("\n");
  }
  if (!body) {
    body = formatTemplate(ticket, parsed).text;
  }

  lines.push(body);
  return lines.join("\n");
}

export function buildAduanKontenStatusText(ticket, parsed, { kind = "manual" } = {}) {
  return buildNotificationText(ticket, parsed, null, { kind });
}

export async function checkAduanKontenReport(laporan) {
  if (!laporan || !laporan.id) {
    throw new Error("Invalid laporan_layanan record");
  }
  if (!laporan.nomor_ticket) {
    return { id: laporan.id, status: "skip_no_ticket" };
  }

  const ticket = String(laporan.nomor_ticket).trim();
  const parsed = await fetchAduanKontenStatus(ticket, { headless: true });
  const items = meaningfulItems(parsed);
  if (!items.length && !parsed.statusText && !parsed.text) {
    return { id: laporan.id, status: "skip_no_status", ticket };
  }

  const fingerprint = fingerprintStatus(parsed);
  const prev = await getLaporanLayanan(laporan.id);
  const changed = prev?.last_status_check !== fingerprint;
  const notifyDue = isStatusNotificationDue(prev?.last_status_notified_at);
  if (!changed && !notifyDue) {
    return { id: laporan.id, status: "unchanged", ticket };
  }

  let llmJson = null;
  if (hasLLM()) {
    try {
      llmJson = await formatWithLLM(parsed);
    } catch (err) {
      console.warn("[aduankonten-checker] LLM formatting gagal:", err?.message || err);
    }
  }

  const text = buildNotificationText(ticket, parsed, llmJson, { kind: changed ? "update" : "periodic" });
  const recipientJid = recipientJidFromSessionId(laporan.session_id);
  if (!recipientJid) {
    return { id: laporan.id, status: "skip_no_recipient", ticket, text };
  }
  if (!hasAduanKontenNotifier()) {
    return { id: laporan.id, status: "skip_no_notifier", ticket, recipientJid, text };
  }

  try {
    await sendAduanKontenNotification(recipientJid, text);
    await updateLaporanLayananStatus(laporan.id, laporan.status, {
      last_status_check: fingerprint,
      last_status_notified_at: new Date().toISOString(),
    });
    return { id: laporan.id, status: changed ? "sent" : "sent_periodic", ticket, recipientJid };
  } catch (err) {
    return { id: laporan.id, status: "send_failed", ticket, recipientJid, error: err.message || String(err) };
  }
}

export async function runAduanKontenCheckerOnce() {
  if (_running) {
    console.log("[aduankonten-checker] sebelumnya masih jalan, lewati.");
    return;
  }
  _running = true;
  try {
    const reports = await listSubmittedLaporanLayanan({ portalTarget: "aduankonten" });
    console.log(`[aduankonten-checker] mengecek ${reports.length} laporan submitted`);
    for (const lap of reports) {
      try {
        const result = await checkAduanKontenReport(lap);
        if (result.status === "sent") {
          console.log(`[aduankonten-checker] update dikirim untuk ticket=${result.ticket} ke ${result.recipientJid}`);
        } else if (result.status === "sent_periodic") {
          console.log(`[aduankonten-checker] status berkala dikirim untuk ticket=${result.ticket} ke ${result.recipientJid}`);
        } else if (result.status === "unchanged") {
          console.log(`[aduankonten-checker] tidak ada perubahan untuk ticket=${result.ticket}`);
        } else if (result.status.startsWith("skip")) {
          console.log(`[aduankonten-checker] ${result.status} ticket=${result.ticket || lap.nomor_ticket || "unknown"}`);
        } else if (result.status === "send_failed") {
          console.warn(`[aduankonten-checker] gagal kirim update ticket=${result.ticket} ke ${result.recipientJid}: ${result.error}`);
        }
      } catch (err) {
        console.warn(`[aduankonten-checker] laporan id=${lap.id} gagal: ${err?.message || err}`);
      }
    }
  } finally {
    _running = false;
  }
}

export async function runAduanKontenCheckerForTicket(ticket) {
  console.log(`[aduankonten-checker] debug run untuk ticket=${ticket}`);
  const parsed = await fetchAduanKontenStatus(ticket, { headless: true });
  const items = meaningfulItems(parsed);
  console.log(`[aduankonten-checker] parsed items count=${items.length}`);
  console.log("[aduankonten-checker] statusText=", parsed.statusText || "-");
  items.forEach((item, index) => {
    console.log(`[aduankonten-checker] item ${index}:`, item);
  });
  return parsed;
}

export function startAduanKontenChecker() {
  const intervalHours = Number(config.aduankonten.checkIntervalHours || 6);
  if (intervalHours <= 0) {
    console.log("[aduankonten-checker] interval tidak valid, scheduler tidak aktif.");
    return;
  }

  if (_timer) clearInterval(_timer);
  const ms = intervalHours * 60 * 60 * 1000;
  _timer = setInterval(() => {
    runAduanKontenCheckerOnce().catch((err) => console.warn("[aduankonten-checker] error terjadwal:", err?.message || err));
  }, ms);
  _timer.unref?.();
  console.log(`[aduankonten-checker] scheduler aktif tiap ${intervalHours} jam.`);
  if (config.aduankonten.checkOnBoot) {
    runAduanKontenCheckerOnce().catch((err) => console.warn("[aduankonten-checker] error saat startup:", err?.message || err));
  } else {
    console.log("[aduankonten-checker] cek saat startup nonaktif. Cek pertama berjalan pada interval berikutnya.");
  }
}
