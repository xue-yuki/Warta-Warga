import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, { fetchLatestBaileysVersion, DisconnectReason, jidNormalizedUser, downloadMediaMessage } from "@whiskeysockets/baileys";
import { resetDeferredAuthState, useDeferredMultiFileAuthState } from "./deferredAuthState.js";
import { config, hasVision } from "../config.js";
import { getGrup } from "../db/index.js";
import { setLaporgubNotifier } from "../agent2/laporgub-checker.js";
import { setAduanKontenNotifier } from "../agent2/aduankonten-checker.js";
import { startAgent2ServiceCheckers } from "../agent2/layanan-checker.js";
import { describeImage } from "../agent2/vision.js";
import { setBroadcaster, broadcastPendingPeringatan } from "../agent1/broadcast.js";
import { alreadySeen, isStartCommand, isRegisteredTarget, startUsage, handleGroup, handleJapri } from "./pipeline.js";
import { setBaileysStatus } from "./status.js";

let _connecting = false;
let _reconnectTimer = null;
let _pendingBroadcastTimer = null;
let _qrRescanTimer = null;
let _currentSock = null;
const QR_RESCAN_DELAY_MS = 15_000;
let _manuallyOff = false;

/** Timestamp ISO untuk tiap baris log supaya jarak antar-event bisa dilacak di production. */
function ts() {
  return new Date().toISOString();
}
function tlog(...args) {
  console.log(`[${ts()}]`, ...args);
}
function twarn(...args) {
  console.warn(`[${ts()}]`, ...args);
}

/** Ringkas objek lastDisconnect (Boom error) jadi satu baris log yang informatif. */
function describeDisconnect(lastDisconnect) {
  const err = lastDisconnect?.error;
  const statusCode = err?.output?.statusCode;
  const payload = err?.output?.payload;
  return JSON.stringify({
    statusCode,
    message: err?.message,
    payload,
    stack: err?.stack ? String(err.stack).split("\n").slice(0, 3).join(" | ") : undefined,
  });
}

let _guardsInstalled = false;
function installProcessGuards() {
  if (_guardsInstalled) return;
  _guardsInstalled = true;
  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    const message = args.map((arg) => (arg instanceof Error ? arg.message : String(arg || ""))).join(" ");
    if (
      /Failed to decrypt message with any known session/i.test(message) ||
      /Session error:.*(?:Bad MAC|MessageCounterError|Key used already or never filled)/i.test(message)
    ) {
      if (process.env.WA_DEBUG_DECRYPT === "true") originalConsoleError(...args);
      return;
    }
    originalConsoleError(...args);
  };
  process.on("unhandledRejection", (err) => {
    twarn("[bot] unhandledRejection diabaikan:", err?.message || err, err?.stack ? `\n${err.stack}` : "");
  });
  process.on("uncaughtException", (err) => {
    twarn("[bot] uncaughtException diabaikan:", err?.message || err, err?.stack ? `\n${err.stack}` : "");
  });
}

/** Buka bungkus pesan (ephemeral/viewOnce/dll) agar contextInfo & teks terbaca. */
function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
    else break;
  }
  return m || {};
}

function extractText(msg) {
  const m = unwrap(msg.message);
  if (!m) return "";
  return (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || "").trim();
}

/** Bagian 'user' dari sebuah JID tanpa device & domain: 628xx:12@s.whatsapp.net → 628xx */
function userPart(jid) {
  return String(jid || "")
    .split("@")[0]
    .split(":")[0];
}

function isMentioned(msg, sock) {
  const m = unwrap(msg.message);
  // Mention bisa ada di teks biasa ATAU di caption gambar/video.
  const ctx = m?.extendedTextMessage?.contextInfo || m?.imageMessage?.contextInfo || m?.videoMessage?.contextInfo || m?.documentMessage?.contextInfo || m?.contextInfo;
  if (!ctx) return false;

  const botNums = new Set([userPart(sock?.user?.id), userPart(sock?.user?.lid)].filter(Boolean));

  const mentioned = ctx.mentionedJid || [];
  if (mentioned.some((j) => botNums.has(userPart(j)))) return true;

  // Reply ke pesan bot juga dihitung sebagai 'memanggil bot'.
  if (ctx.participant && botNums.has(userPart(ctx.participant))) return true;

  return false;
}

/** Tandai pesan sudah dibaca (centang biru). */
async function markRead(sock, msg) {
  try {
    await sock.readMessages([msg.key]);
  } catch {
    /* abaikan */
  }
}

/** Set status kehadiran (composing = 'mengetik...', paused = berhenti). */
async function presence(sock, jid, state) {
  try {
    await sock.sendPresenceUpdate(state, jid);
  } catch {
    /* abaikan */
  }
}

/** Adapter pipeline.js untuk transport Baileys. */
function baileysAdapter(sock) {
  return {
    send: (jid, body, opts = {}) => sock.sendMessage(jid, { text: body }, opts.quoted ? { quoted: opts.quoted } : undefined),
    markRead: (msg) => (msg ? markRead(sock, msg) : Promise.resolve()),
    presence: (jid, state) => presence(sock, jid, state),
  };
}

function clearQrRescanTimer() {
  if (_qrRescanTimer) {
    clearTimeout(_qrRescanTimer);
    _qrRescanTimer = null;
  }
}

function scheduleReconnect(delayMs = 3000) {
  if (_reconnectTimer) {
    twarn(`[bot] scheduleReconnect diabaikan: timer sudah berjalan (delay=${delayMs}ms).`);
    return; // sudah ada reconnect yang dijadwalkan
  }
  tlog(`[bot] scheduleReconnect: reconnect dijadwalkan dalam ${delayMs}ms. _connecting=${_connecting} _currentSock=${!!_currentSock}`);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    tlog("[bot] scheduleReconnect: timer fired, memanggil startBot()...");
    startBot().catch((e) => twarn("[bot] reconnect gagal:", e?.message, e?.stack ? `\n${e.stack}` : ""));
  }, delayMs);
}

function scheduleQrRescan(delayMs = QR_RESCAN_DELAY_MS) {
  if (_qrRescanTimer) {
    twarn(`[bot] scheduleQrRescan diabaikan: timer sudah berjalan (delay=${delayMs}ms).`);
    return; // 408 bisa beruntun; cukup satu reset auth + QR baru.
  }
  const seconds = Math.round(delayMs / 1000);
  tlog(`[bot] scheduleQrRescan: dijadwalkan dalam ${seconds}s. _connecting=${_connecting} _currentSock=${!!_currentSock}`);
  setBaileysStatus("qr_pending", {
    connectedAs: null,
    message: "Koneksi timeout (408). Auth akan direset dalam " + seconds + " detik untuk scan QR ulang.",
  });
  _qrRescanTimer = setTimeout(async () => {
    _qrRescanTimer = null;
    tlog("[bot] scheduleQrRescan: timer fired.");
    if (_manuallyOff) {
      tlog("[bot] scheduleQrRescan: dibatalkan karena _manuallyOff=true.");
      return;
    }

    try { _currentSock?.end?.(new Error("408 rescan")); } catch (e) { twarn("[bot] scheduleQrRescan: gagal end() sock lama:", e?.message); }
    _currentSock = null;
    _connecting = false;

    try {
      tlog("[bot] scheduleQrRescan: mereset auth_state...");
      await resetDeferredAuthState(config.wa.authDir);
      tlog("📱 Timeout 408: auth_state direset. Menyiapkan QR baru untuk scan ulang...");
      setBaileysStatus("connecting", { connectedAs: null });
      await startBot();
    } catch (e) {
      twarn("[bot] reset auth setelah 408 gagal:", e?.message || e, e?.stack ? `\n${e.stack}` : "");
      setBaileysStatus("disconnected", { connectedAs: null });
      scheduleQrRescan();
    }
  }, delayMs);
}

export async function startBot() {
  installProcessGuards();
  tlog(`[bot] startBot() dipanggil. _connecting=${_connecting} _currentSock=${!!_currentSock} _manuallyOff=${_manuallyOff}`);
  if (_connecting) {
    twarn("[bot] startBot() dibatalkan: sudah ada proses connect yang berjalan (single-flight guard).");
    return; // single-flight: jangan buat socket baru bila satu sedang berjalan
  }
  _connecting = true;
  setBaileysStatus("connecting");

  let sock;
  try {
    tlog("[bot] startBot(): memuat auth_state...");
    const { state, saveCreds } = await useDeferredMultiFileAuthState(config.wa.authDir);
    tlog(`[bot] startBot(): auth_state dimuat. registered=${!!state?.creds?.registered}`);

    tlog("[bot] startBot(): mengambil versi Baileys terbaru...");
    const { version } = await fetchLatestBaileysVersion();
    tlog(`[bot] startBot(): versi Baileys = ${JSON.stringify(version)}`);

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    tlog("[bot] startBot(): socket Baileys berhasil dibuat.");
    _currentSock = sock;

    sock.ev.on("creds.update", saveCreds);
  } catch (e) {
    // Penting: kalau gagal di titik manapun sebelum socket jadi, reset _connecting.
    // Kalau tidak, semua panggilan startBot() berikutnya (mis. dari scheduleReconnect)
    // akan langsung return di guard single-flight di atas dan bot macet permanen.
    twarn("[bot] startBot(): GAGAL sebelum socket terbentuk:", e?.message || e, e?.stack ? `\n${e.stack}` : "");
    _connecting = false;
    _currentSock = null;
    setBaileysStatus("disconnected", { connectedAs: null });
    throw e;
  }

  let closedHandled = false; // satu socket → satu penanganan close
  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (sock !== _currentSock) {
      twarn(`[bot][connection.update] event dari sock BASI diabaikan. connection=${connection} qr=${!!qr}`);
      return;
    }
    tlog(`[bot][connection.update] connection=${connection ?? "(unchanged)"} qr=${!!qr} closedHandled=${closedHandled}` + (connection === "close" ? ` lastDisconnect=${describeDisconnect(lastDisconnect)}` : ""));
    if (qr) {
      // QR tidak lagi dicetak di terminal — scan lewat dashboard web (GET /wa/status) saja.
      console.log("📱 QR baru tersedia. Buka dashboard → Koneksi WhatsApp untuk scan.");
      QRCode.toDataURL(qr)
        .then((dataUrl) => {
          if (sock === _currentSock && !_manuallyOff) setBaileysStatus("qr_pending", { qr: dataUrl });
        })
        .catch((e) => twarn("[bot] gagal generate QR image:", e.message));
    }
    if (connection === "open") {
      clearQrRescanTimer();
      const me = jidNormalizedUser(sock.user?.id);
      tlog(`✅ Terhubung sebagai ${me}`);
      setBaileysStatus("connected", { connectedAs: me });
      // Daftarkan pengirim broadcast agar Agent 1 bisa menyebar info baru ke grup.
      setBroadcaster(async (jid, text, imagePath = null) => {
        if (imagePath) {
          const imageBuffer = fs.readFileSync(imagePath);
          return sock.sendMessage(jid, { image: imageBuffer, caption: text });
        }
        return sock.sendMessage(jid, { text });
      });

      // Daftarkan pengirim notifikasi LaporGub agar follow-up bisa dikirim ke pelapor.
      setLaporgubNotifier((jid, text) => sock.sendMessage(jid, { text }));
      // Daftarkan pengirim notifikasi AduanKonten.
      setAduanKontenNotifier((jid, text) => sock.sendMessage(jid, { text }));
      startAgent2ServiceCheckers();

      // Replay laporan approved saat bot offline hanya kalau auto-polling memang diaktifkan.
      // Default mati supaya seed/demo rows yang pernah di-approve tidak langsung spam saat reconnect.
      if (config.pendingBroadcast.autoPolling) {
        if (_pendingBroadcastTimer) clearTimeout(_pendingBroadcastTimer);
        _pendingBroadcastTimer = setTimeout(() => {
          _pendingBroadcastTimer = null;
          broadcastPendingPeringatan().catch(e => console.warn('[Bot] Pending broadcast gagal:', e.message));
        }, 4000);
      } else {
        console.log('[PendingBroadcast] Replay on reconnect NONAKTIF. Gunakan dashboard atau PENDING_BROADCAST_AUTO=true.');
      }
    }
    if (connection === "close") {
      if (closedHandled) {
        twarn("[bot][close] event close DUPLIKAT untuk socket yang sama, diabaikan (closedHandled=true).");
        return;
      }
      closedHandled = true;
      _connecting = false;
      tlog(`[bot][close] menangani close. code=${lastDisconnect?.error?.output?.statusCode} _manuallyOff=${_manuallyOff} detail=${describeDisconnect(lastDisconnect)}`);
      // Batalkan timer pending broadcast agar koneksi baru nanti yang memicu, bukan koneksi lama ini.
      if (_pendingBroadcastTimer) { clearTimeout(_pendingBroadcastTimer); _pendingBroadcastTimer = null; }
      setBroadcaster(null); // sock mati → jangan broadcast lewat koneksi basi; daftar ulang saat 'open'.
      setLaporgubNotifier(null);
      setAduanKontenNotifier(null);

      // Admin mematikan bot lewat dashboard (POST /wa/stop) → sock ini ditutup sengaja oleh
      // stopBaileys(), jangan timpa status "off" dan jangan auto-reconnect.
      if (_manuallyOff) {
        tlog("[bot][close] _manuallyOff=true → tidak auto-reconnect, status diset 'off'.");
        setBaileysStatus("off", { connectedAs: null });
        return;
      }

      const code = lastDisconnect?.error?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        tlog(`❌ [bot][close] Logged out (code=${code}). Hapus folder ${config.wa.authDir} lalu jalankan ulang untuk scan QR baru.`);
        setBaileysStatus("logged_out", { connectedAs: null });
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        // Sesi digantikan koneksi lain (mis. Web/instance lain). Jangan dilawan → cegah badai 440.
        tlog(`⚠️ [bot][close] Sesi digantikan koneksi lain (code=${code}). Berhenti agar tidak bentrok. Pastikan hanya 1 instance.`);
        setBaileysStatus("disconnected");
        return;
      }
      if (code === 408) {
        // Timeout 408 sering berarti sesi Baileys macet di auth lama. Jangan loop reconnect 3 detik;
        // reset auth setelah grace period singkat supaya dashboard mendapat QR baru untuk scan ulang.
        _currentSock = null;
        tlog("⚠️ [bot][close] Koneksi timeout (code=408). Akan scan QR ulang otomatis dalam 15 detik...");
        scheduleQrRescan();
        return;
      }
      // 515 restartRequired, 428 connectionClosed, dll → reconnect sekali (terjadwal).
      tlog(`⚠️ [bot][close] Koneksi tertutup (code=${code}). Mencoba ulang dalam 3 detik... _reconnectTimer=${!!_reconnectTimer}`);
      setBaileysStatus("disconnected");
      scheduleReconnect();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    const botJid = config.wa.botJid || jidNormalizedUser(sock.user?.id);

    for (const msg of messages) {
      try {
        await handleOne(sock, msg, botJid);
      } catch (err) {
        twarn("[handler] error:", err.message, err?.stack ? `\n${err.stack}` : "");
      }
    }
  });

  tlog("[bot] startBot(): selesai, socket siap & event listener terpasang.");
  return sock;
}

async function handleOne(sock, msg, botJid) {
  // F2.3: abaikan pesan dari diri sendiri (cegah loop).
  if (msg.key.fromMe) return;

  // Cegah proses ganda atas pesan yang sama (resync/duplikat event).
  if (alreadySeen(msg.key.id)) return;

  const jid = msg.key.remoteJid;
  if (!jid) return;

  const isGroup = jid.endsWith("@g.us");
  const adapter = baileysAdapter(sock);
  const send = (body) => adapter.send(jid, body, isGroup ? { quoted: msg } : undefined);
  let text = extractText(msg);

  if (!isStartCommand(text)) {
    if (isGroup) {
      if (isMentioned(msg, sock)) {
        const grup = await getGrup(jid);
        if (!isRegisteredTarget(grup)) {
          await markRead(sock, msg);
          await presence(sock, jid, "composing");
          try {
            await send(startUsage(true));
          } finally {
            await presence(sock, jid, "paused");
          }
          return;
        }
      }
    } else {
      const registered = await getGrup(jid);
      if (!isRegisteredTarget(registered)) {
        await markRead(sock, msg);
        await presence(sock, jid, "composing");
        try {
          await send(startUsage(false));
        } finally {
          await presence(sock, jid, "paused");
        }
        return;
      }
    }
  }

  const img = unwrap(msg.message)?.imageMessage;
  let imageText = null;
  let imageBuffer = null;
  let imageMimetype = null;
  if (img) {
    const willRespond = !isStartCommand(text) && (isGroup ? isMentioned(msg, sock) : true);
    if (willRespond) {
      await presence(sock, jid, "composing");
      const desc = await imageToText(sock, msg, img).catch((e) => {
        console.warn("[vision] gagal:", e.message);
        return null;
      });
      if (desc) {
        text = [text, `[Isi gambar yang dikirim warga]\n${desc.text}`].filter(Boolean).join("\n\n");
        imageText = desc.text;
        imageBuffer = desc.buffer;
        imageMimetype = img.mimetype || "image/jpeg";
      } else if (!hasVision() && !text) {
        await send("Maaf, aku belum bisa membaca gambar 🙏 Tolong ketik isinya, atau kirim teks/link-nya ya.");
        return;
      }
    }
  }

  const doc = unwrap(msg.message)?.documentMessage;
  if (doc && !isStartCommand(text)) {
    const willRespond = isGroup ? isMentioned(msg, sock) : true;
    if (willRespond) {
      const filename = doc.fileName || doc.title || "(tanpa nama)";
      const ext = filename.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() || "";
      const sizeKb = doc.fileLength ? Math.round(Number(doc.fileLength) / 1024) : null;
      const meta =
        `[Lampiran file dari warga] nama file: "${filename}"${ext ? ` (ekstensi ${ext})` : ""}` +
        `${sizeKb ? `, ukuran ${sizeKb} KB` : ""}, tipe: ${doc.mimetype || "tidak diketahui"}. ` +
        `(Isi file TIDAK dibuka/dipindai otomatis — nilai dari nama & jenis filenya saja.)`;
      text = [text, meta].filter(Boolean).join("\n\n");
    }
  }

  if (!text) return;

  if (isGroup) {
    const sender = userPart(msg.key.participant || msg.participant || jid);
    await handleGroup(adapter, { jid, msg, text, addressed: isMentioned(msg, sock), sender, imageText, imageBuffer, imageMimetype, messageId: msg.key.id });
  } else {
    await handleJapri(adapter, { jid, msg, text, imageText, imageBuffer, imageMimetype, messageId: msg.key.id });
  }
}

/** Unduh media gambar lalu ubah jadi teks (OCR + deskripsi) via model vision. */
async function imageToText(sock, msg, img) {
  const buffer = await downloadMediaMessage(msg, "buffer", {}, { reuploadRequest: sock.updateMediaMessage });
  const text = await describeImage(buffer, img.mimetype || "image/jpeg", img.caption || "");
  return { text, buffer };
}

export async function relinkBaileys() {
  tlog(`[bot] relinkBaileys() dipanggil. _connecting=${_connecting} _currentSock=${!!_currentSock}`);
  _manuallyOff = false; // relink selalu menyalakan ulang, batalkan flag "dimatikan manual" kalau ada
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  clearQrRescanTimer();
  try { await _currentSock?.logout(); } catch (e) { twarn("[bot] relinkBaileys: logout() gagal (diabaikan):", e?.message); }
  try { _currentSock?.end?.(new Error("relink")); } catch (e) { twarn("[bot] relinkBaileys: end() gagal (diabaikan):", e?.message); }
  _currentSock = null;
  _connecting = false;
  await resetDeferredAuthState(config.wa.authDir).catch((e) => twarn("[bot] relinkBaileys: reset auth_state gagal:", e?.message));
  setBaileysStatus("connecting", { connectedAs: null });
  return startBot();
}


export async function stopBaileys() {
  tlog(`[bot] stopBaileys() dipanggil. _connecting=${_connecting} _currentSock=${!!_currentSock}`);
  _manuallyOff = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  clearQrRescanTimer();
  if (_pendingBroadcastTimer) { clearTimeout(_pendingBroadcastTimer); _pendingBroadcastTimer = null; }
  setBroadcaster(null);
  setLaporgubNotifier(null);
  setAduanKontenNotifier(null);
  try { _currentSock?.end?.(new Error("manual stop")); } catch (e) { twarn("[bot] stopBaileys: end() gagal (diabaikan):", e?.message); }
  _currentSock = null;
  _connecting = false;
  setBaileysStatus("off", { connectedAs: null });
}

/** Nyalakan lagi bot yang sebelumnya dimatikan lewat stopBaileys() (POST /wa/start). */
export async function startBaileys() {
  tlog(`[bot] startBaileys() dipanggil. _connecting=${_connecting} _currentSock=${!!_currentSock}`);
  _manuallyOff = false;
  clearQrRescanTimer();
  return startBot();
}
