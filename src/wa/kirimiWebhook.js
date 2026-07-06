// Transport kirimi.id — webhook publik yang menerima pesan masuk dari WhatsApp (kirimi menjalankan
// Baileys di sisi mereka dan meneruskan event ke sini) + endpoint statis untuk media keluar.
//
// PENTING soal loop: kirimi.id sendiri bilang webhook yang sama dipakai untuk DUA hal — status
// pengiriman pesan KITA, dan balasan BARU dari warga (lihat catatan di /docs FAQ). Skema payload
// persisnya tidak didokumentasikan publik, jadi normalizeIncoming() di bawah menebak beberapa nama
// field yang lazim dipakai gateway WA sejenis. Nyalakan KIRIMI_WEBHOOK_DEBUG=true untuk mencetak
// body mentah begitu webhook asli terpasang di dashboard kirimi.id, supaya pemetaan field ini bisa
// dikoreksi cepat kalau meleset.
//
// Pencegahan loop dilakukan berlapis & TIDAK bergantung pada tebakan nama field di atas benar:
//  1) payload tanpa teks pesan (hanya status pengiriman) → diabaikan.
//  2) fromMe / nomor pengirim == nomor bot sendiri → diabaikan (jangan pernah balas diri sendiri).
//  3) message_id yang sama diproses lagi (retry webhook) → diabaikan (dedup, sama seperti transport Baileys).

import express from "express";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { config, hasVision, ROOT } from "../config.js";
import { setLaporgubNotifier } from "../agent2/laporgub-checker.js";
import { setAduanKontenNotifier } from "../agent2/aduankonten-checker.js";
import { startAgent2ServiceCheckers } from "../agent2/layanan-checker.js";
import { describeImage } from "../agent2/vision.js";
import { setBroadcaster, broadcastPendingPeringatan, setKirimiDeviceOnline } from "../agent1/broadcast.js";
import { alreadySeen, isStartCommand, handleGroup, handleJapri } from "./pipeline.js";
import { kirimiSendMessage, kirimiDeviceStatus } from "./kirimiClient.js";

const POSTERS_DIR = path.join(ROOT, "data", "posters");

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

/**
 * Menebak bentuk payload webhook kirimi.id — belum didokumentasikan publik (OpenAPI resmi
 * kirimi.id hanya mencakup send-message/broadcast/OTP/device, tidak ada skema webhook). Field
 * dicoba dengan urutan prioritas: dulukan nama yang kirimi PAKAI SENDIRI di endpoint lain
 * ('phone' utk nomor, 'message' utk teks, 'device_id') sebelum menebak nama lazim gateway WA lain
 * (sender/from/number, text/body, dst). Nyalakan KIRIMI_WEBHOOK_DEBUG=true lalu cek log begitu
 * webhook asli terpasang untuk mengoreksi pemetaan ini kalau meleset.
 */
function normalizeIncoming(body = {}) {
  const data = body.data && typeof body.data === "object" ? body.data : body;
  const messageId = data.message_id || data.messageId || data.id || null;
  const from = onlyDigits(data.phone || data.sender || data.from || data.number || data.jid);
  const text = String(data.message || data.text || data.body || "").trim();
  const mediaUrl = data.media_url || data.mediaUrl || data.image_url || null;
  const fromMe = Boolean(data.fromMe ?? data.from_me ?? data.is_from_me ?? data.self ?? false);
  const groupId = data.group_id || data.groupId || (String(data.jid || "").includes("-group") ? data.jid : null);
  const isGroup = Boolean(data.is_group ?? data.isGroup ?? groupId);
  // Payload delivery-status kirimi.id biasanya punya 'status'/'delivery_status' TANPA teks pesan.
  const looksLikeStatusOnly = !text && !mediaUrl && Boolean(data.status || data.delivery_status || data.ack);
  return { messageId, from, text, mediaUrl, fromMe, isGroup, groupId, looksLikeStatusOnly };
}

function verifyToken(req) {
  const expected = config.kirimi.webhookToken;
  if (!expected) return true; // belum diset → lewati verifikasi (WARNING dicetak saat boot)
  const got = req.query?.token || req.get("x-kirimi-token") || "";
  return got === expected;
}

/** Adapter pipeline.js untuk transport kirimi.id: tanpa read-receipt/typing-indicator API. */
function kirimiAdapter() {
  return {
    send: async (jid, body) => kirimiSendMessage({ to: jid, message: body }),
    markRead: async () => {},
    presence: async () => {},
  };
}

/** Unduh media dari media_url lalu jalankan vision seperti pada transport Baileys. */
async function imageToTextFromUrl(mediaUrl, caption = "") {
  const { data } = await axios.get(mediaUrl, { responseType: "arraybuffer", timeout: 30000 });
  const buffer = Buffer.from(data);
  const mimetype = "image/jpeg"; // kirimi tidak selalu mengirim mimetype eksplisit di webhook
  const text = await describeImage(buffer, mimetype, caption);
  return { text, buffer, mimetype };
}

async function processIncoming(payload) {
  const { messageId, from, text: rawText, mediaUrl, isGroup, groupId } = payload;
  let text = rawText;
  const jid = isGroup ? groupId : from;
  if (!jid) return;

  const adapter = kirimiAdapter();
  const send = (body) => adapter.send(jid, body);

  // Gambar: sama seperti transport Baileys — hanya jalankan vision kalau bot memang akan
  // merespons (japri selalu, grup hanya kalau ada indikasi mention/reply eksplisit).
  const willRespond = !isStartCommand(text) && (isGroup ? isAddressedInGroup(text) : true);
  let imageText = null;
  let imageBuffer = null;
  let imageMimetype = null;
  if (mediaUrl && willRespond) {
    const desc = await imageToTextFromUrl(mediaUrl, text || "").catch((e) => {
      console.warn("[kirimi][vision] gagal:", e.message);
      return null;
    });
    if (desc) {
      text = [text, `[Isi gambar yang dikirim warga]\n${desc.text}`].filter(Boolean).join("\n\n");
      imageText = desc.text;
      imageBuffer = desc.buffer;
      imageMimetype = desc.mimetype;
    } else if (!hasVision() && !text) {
      await send("Maaf, aku belum bisa membaca gambar 🙏 Tolong ketik isinya, atau kirim teks/link-nya ya.");
      return;
    }
  }

  if (!text) return;

  if (isGroup) {
    // Skema mention/reply kirimi.id untuk grup belum terverifikasi (lihat catatan di atas file
    // ini) — default konservatif: /start tetap mendaftarkan grup, di luar itu hanya balas kalau
    // ada tanda eksplisit di teks (mis. "@<nomor bot>") supaya bot tidak berisik di grup.
    await handleGroup(adapter, {
      jid,
      msg: null,
      text,
      addressed: isAddressedInGroup(text),
      sender: from,
      imageText,
      imageBuffer,
      imageMimetype,
      messageId,
    });
  } else {
    await handleJapri(adapter, { jid, msg: null, text, imageText, imageBuffer, imageMimetype, messageId });
  }
}

/** Best-effort: bot dianggap "dipanggil" di grup kalau teksnya menyebut nomor bot sendiri. */
function isAddressedInGroup(text) {
  const bot = config.kirimi.botNumber;
  if (!bot) return false;
  return String(text || "").replace(/\D/g, " ").includes(bot);
}

export function createKirimiWebhookApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.post("/kirimi/incoming", (req, res) => {
    if (!verifyToken(req)) return res.status(401).json({ ok: false, error: "invalid webhook token" });

    if (config.kirimi.webhookDebug) {
      console.log("[kirimi][webhook] raw body:", JSON.stringify(req.body));
    }

    const payload = normalizeIncoming(req.body);

    // --- Pencegahan loop (lihat catatan di atas file) ---
    if (payload.looksLikeStatusOnly) {
      return res.status(200).json({ ok: true, skipped: "status_callback" });
    }
    if (payload.fromMe || (config.kirimi.botNumber && payload.from === config.kirimi.botNumber)) {
      return res.status(200).json({ ok: true, skipped: "from_me" });
    }
    if (payload.messageId && alreadySeen(payload.messageId)) {
      return res.status(200).json({ ok: true, skipped: "duplicate" });
    }
    if (!payload.text && !payload.mediaUrl) {
      return res.status(200).json({ ok: true, skipped: "empty" });
    }

    // Ack dulu supaya kirimi.id tidak retry karena timeout, lalu proses di latar belakang.
    res.status(200).json({ ok: true });
    processIncoming(payload).catch((e) => console.error("[kirimi][webhook] gagal proses:", e.message));
  });

  // Penyaji media untuk poster broadcast (kirimi mengirim gambar lewat media_url, bukan upload).
  app.get("/media/:file", (req, res) => {
    const file = path.basename(req.params.file || "");
    const filePath = path.join(POSTERS_DIR, file);
    if (!file || !filePath.startsWith(POSTERS_DIR) || !fs.existsSync(filePath)) {
      return res.status(404).end();
    }
    res.sendFile(filePath);
  });

  return app;
}

function publicMediaUrl(imagePath) {
  if (!config.publicBaseUrl || !imagePath) return undefined;
  return `${config.publicBaseUrl}/media/${encodeURIComponent(path.basename(imagePath))}`;
}

/** Jalankan server webhook kirimi.id. HARUS bisa diakses publik (beda dari dashboard admin
 * yang sengaja hanya bind ke 127.0.0.1) — expose lewat reverse proxy/tunnel ke domainmu, lalu
 * daftarkan `${PUBLIC_BASE_URL}/kirimi/incoming?token=${KIRIMI_WEBHOOK_TOKEN}` di dashboard kirimi.id. */
export function startKirimiWebhookServer(port = config.kirimi.webhookPort) {
  if (!config.kirimi.webhookToken) {
    console.warn("[kirimi] KIRIMI_WEBHOOK_TOKEN belum diset — webhook menerima request dari siapa saja yang tahu URL-nya. Sangat disarankan diisi.");
  }
  if (!config.publicBaseUrl) {
    console.warn("[kirimi] PUBLIC_BASE_URL belum diset — broadcast poster/gambar akan dilewati (media_url tidak bisa dibuat).");
  }

  process.on("unhandledRejection", (err) => console.warn("[kirimi] unhandledRejection diabaikan:", err?.message || err));
  process.on("uncaughtException", (err) => console.warn("[kirimi] uncaughtException diabaikan:", err?.message || err));

  // Broadcaster untuk Agent 1 (info baru) + dashboard cluster/pending broadcast.
  setBroadcaster(async (jid, text, imagePath = null) => {
    return kirimiSendMessage({ to: jid, message: text, mediaUrl: publicMediaUrl(imagePath) });
  }, { transport: 'kirimi' });

  async function refreshKirimiDeviceOnline() {
    try {
      const data = await kirimiDeviceStatus();
      const online = /connected|online|active|ready/i.test(String(data?.status || data?.device_status || data?.message || ''));
      setKirimiDeviceOnline(online);
    } catch (e) {
      setKirimiDeviceOnline(false);
      console.warn('[kirimi] device-status gagal:', e?.message);
    }
  }
  refreshKirimiDeviceOnline();
  setInterval(refreshKirimiDeviceOnline, 60_000).unref?.();
  setLaporgubNotifier((jid, text) => kirimiSendMessage({ to: jid, message: text }));
  setAduanKontenNotifier((jid, text) => kirimiSendMessage({ to: jid, message: text }));
  startAgent2ServiceCheckers();

  if (config.pendingBroadcast.autoPolling) {
    setTimeout(() => {
      broadcastPendingPeringatan().catch((e) => console.warn("[kirimi] Pending broadcast gagal:", e.message));
    }, 4000);
  }

  const server = createKirimiWebhookApp().listen(port, "0.0.0.0", () => {
    console.log(`📡 kirimi.id webhook listening on :${port} (POST /kirimi/incoming, GET /media/:file)`);
    console.log(`   Daftarkan URL ini di dashboard kirimi.id: <PUBLIC_BASE_URL>/kirimi/incoming?token=<KIRIMI_WEBHOOK_TOKEN>`);
  });
  return server;
}
