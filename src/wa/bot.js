import path from "node:path";
import pino from "pino";
import qrcode from "qrcode-terminal";
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, jidNormalizedUser, downloadMediaMessage } from "@whiskeysockets/baileys";
import { config, hasSearch, hasVision } from "../config.js";
import { getGrup, upsertGrup, countInfoByWilayah } from "../db/index.js";
import { respondToMessage, GREETING } from "../agent2/handler.js";
import { handleLaporKonten, maybeOfferAduanKontenReport, rememberAduanKontenUrlFromText } from "../agent2/lapor-konten.js";
import { handleAduanKontenStatus } from "../agent2/aduankonten-status.js";
import { handleLaporLayanan, hasPendingLaporanLayanan, storeImageForSession } from "../agent2/lapor-layanan.js";
import { setLaporgubNotifier } from "../agent2/laporgub-checker.js";
import { setAduanKontenNotifier } from "../agent2/aduankonten-checker.js";
import { startAgent2ServiceCheckers } from "../agent2/layanan-checker.js";
import { describeImage } from "../agent2/vision.js";
import { groupScopeTags, normalizeWilayahTag, inferProvinsiTag, detectWilayahFromText, isKabKota, humanWilayah } from "../util/wilayah.js";
import { scrapeRegion } from "../agent1/scheduler.js";
import { setBroadcaster } from "../agent1/broadcast.js";

// Stateless bot: hanya cache efemeral siapa yang sudah disapa (tidak dipersist → privasi).
const greeted = new Set();

// Dedup pesan: cegah balasan dobel saat WhatsApp me-resync pesan yang sama (mis. setelah reconnect).
const seenMsgIds = new Set();
function alreadySeen(id) {
  if (!id) return false;
  if (seenMsgIds.has(id)) return true;
  seenMsgIds.add(id);
  if (seenMsgIds.size > 1000) seenMsgIds.delete(seenMsgIds.values().next().value);
  return false;
}

// On-demand discovery: lacak daerah yang sedang dicari (anti-double) + cooldown agar
// daerah yang barusan dicoba & nihil tidak di-scrape ulang tiap pesan.
const regionJobs = new Set();
const regionAttempts = new Map(); // wilayahTag -> ts terakhir dicoba
const REGION_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 jam
function recentlyAttempted(tag) {
  const ts = regionAttempts.get(tag);
  return ts && Date.now() - ts < REGION_COOLDOWN_MS;
}

// Single-flight reconnect: cegah banyak socket bertumpuk (akar penyebab badai code 440).
let _connecting = false;
let _reconnectTimer = null;

// Error transien libsignal/kirim-saat-tutup tidak boleh mematikan proses bot.
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
    console.warn("[bot] unhandledRejection diabaikan:", err?.message || err);
  });
  process.on("uncaughtException", (err) => {
    console.warn("[bot] uncaughtException diabaikan:", err?.message || err);
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
  return (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || "").trim();
}

/** Bagian 'user' dari sebuah JID tanpa device & domain: 628xx:12@s.whatsapp.net → 628xx */
function userPart(jid) {
  return String(jid || "")
    .split("@")[0]
    .split(":")[0];
}

function isStartCommand(text) {
  return /^\/start\b/i.test(String(text || "").trim());
}

function isRegisteredTarget(row) {
  return Boolean(row && Number(row.status_start) === 1);
}

export function startUsage(isGroup) {
  const target = isGroup ? "grup ini" : "nomor ini";
  return (
    `Untuk mengaktifkan ${target}, kirim:\n` +
    "`/start <daerah>`\n\n" +
    "Contoh:\n" +
    "`/start Kab. Banyumas`\n" +
    "`/start Kota Semarang`\n\n" +
    "Setelah aktif, Bapak/Ibu bisa pilih menu 1, 2, atau 3."
  );
}

async function registerTarget({ jid, text, send, isGroup }) {
  const arg = String(text || "").replace(/^\/start\b/i, "").trim();
  if (!arg) {
    await send(startUsage(isGroup));
    return false;
  }

  const wilayahTag = normalizeWilayahTag(arg);
  const provinsiTag = inferProvinsiTag(wilayahTag);
  await upsertGrup({ idGrup: jid, daerah: arg, wilayahTag, provinsiTag });

  const target = isGroup ? "Grup" : "Nomor";
  await send(
    `✅ ${target} terdaftar untuk wilayah *${arg}* ` +
      `(tag: ${wilayahTag}${provinsiTag ? `, ${provinsiTag}` : ""}).\n\n` +
      (isGroup
        ? "Mention saya (@) untuk tanya info atau cek kabar bansos."
        : GREETING),
  );
  return true;
}

/**
 * Deteksi mention bot. Tahan terhadap:
 * - device suffix (:12), domain beda (@s.whatsapp.net vs @lid)
 * - identitas bot berupa nomor HP ATAU LID
 * - balasan (reply) ke pesan bot
 */
function isMentioned(msg, sock) {
  const m = unwrap(msg.message);
  // Mention bisa ada di teks biasa ATAU di caption gambar/video.
  const ctx = m?.extendedTextMessage?.contextInfo || m?.imageMessage?.contextInfo || m?.videoMessage?.contextInfo || m?.contextInfo;
  if (!ctx) return false;

  const botNums = new Set([userPart(sock?.user?.id), userPart(sock?.user?.lid)].filter(Boolean));

  const mentioned = ctx.mentionedJid || [];
  if (mentioned.some((j) => botNums.has(userPart(j)))) return true;

  // Reply ke pesan bot juga dihitung sebagai 'memanggil bot'.
  if (ctx.participant && botNums.has(userPart(ctx.participant))) return true;

  return false;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

function scheduleReconnect(delayMs = 3000) {
  if (_reconnectTimer) return; // sudah ada reconnect yang dijadwalkan
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    startBot().catch((e) => console.warn("[bot] reconnect gagal:", e?.message));
  }, delayMs);
}

export async function startBot() {
  installProcessGuards();
  if (_connecting) return; // single-flight: jangan buat socket baru bila satu sedang berjalan
  _connecting = true;

  const { state, saveCreds } = await useMultiFileAuthState(config.wa.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  let closedHandled = false; // satu socket → satu penanganan close
  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log("\n📱 Scan QR ini di WhatsApp (Perangkat Tertaut):\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      const me = jidNormalizedUser(sock.user?.id);
      console.log(`✅ Terhubung sebagai ${me}`);
      // Daftarkan pengirim broadcast agar Agent 1 bisa menyebar info baru ke grup.
      setBroadcaster(async (jid, text, imagePath = null) => {
              if (imagePath) {
                return sock.sendMessage(jid, { image: { url: imagePath }, caption: text });
              }
              return sock.sendMessage(jid, { text });
            });      
      
            // Daftarkan pengirim notifikasi LaporGub agar follow-up bisa dikirim ke pelapor.
      setLaporgubNotifier((jid, text) => sock.sendMessage(jid, { text }));
      // Daftarkan pengirim notifikasi AduanKonten.
      setAduanKontenNotifier((jid, text) => sock.sendMessage(jid, { text }));
      startAgent2ServiceCheckers();
    }
    if (connection === "close") {
      if (closedHandled) return;
      closedHandled = true;
      _connecting = false;
      setBroadcaster(null); // sock mati → jangan broadcast lewat koneksi basi; daftar ulang saat 'open'.
      setLaporgubNotifier(null);
      setAduanKontenNotifier(null);
      const code = lastDisconnect?.error?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        console.log(`❌ Logged out. Hapus folder ${config.wa.authDir} lalu jalankan ulang untuk scan QR baru.`);
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        // Sesi digantikan koneksi lain (mis. Web/instance lain). Jangan dilawan → cegah badai 440.
        console.log("⚠️ Sesi digantikan koneksi lain (440). Berhenti agar tidak bentrok. Pastikan hanya 1 instance.");
        return;
      }
      // 515 restartRequired, 428 connectionClosed, 408 timeout, dll → reconnect sekali (terjadwal).
      console.log(`⚠️ Koneksi tertutup (code=${code}). Mencoba ulang dalam 3 detik...`);
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
        console.error("[handler] error:", err.message);
      }
    }
  });

  return sock;
}

async function handleOne(sock, msg, botJid) {
  // F2.3: abaikan pesan dari diri sendiri (cegah loop).
  if (msg.key.fromMe) return;

  // Cegah proses ganda atas pesan yang sama (resync/duplikat event).
  if (alreadySeen(msg.key.id)) return;

  const jid = msg.key.remoteJid;
  if (!jid) return;

  // F2.1: bedakan grup vs japri dari JID.
  const isGroup = jid.endsWith("@g.us");
  // Di grup, balas dengan MENGUTIP (reply) pesan pemicunya supaya jelas menjawab pertanyaan
  // siapa — beberapa warga bisa bertanya berbarengan. Di japri (1-1) tak perlu kutipan.
  const send = (body) => sock.sendMessage(jid, { text: body }, isGroup ? { quoted: msg } : undefined);
  let text = extractText(msg);

  // Enforce registration before any expensive AI work. This keeps private numbers and
  // mentioned groups on the /start path even when they send images or free text first.
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

  // Gambar (poster/screenshot/struk penipuan): baca jadi teks via vision lalu gabung dgn caption.
  // Mahal → hanya saat bot memang akan merespons (japri, atau di grup ketika di-mention).
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

  if (!text) return;

  if (isGroup) {
    await handleGroup(sock, jid, msg, text, botJid, send, imageText, imageBuffer, imageMimetype, msg.key.id);
  } else {
    await handleJapri(sock, jid, msg, text, send, imageText, imageBuffer, imageMimetype, msg.key.id);
  }
}

/** Unduh media gambar lalu ubah jadi teks (OCR + deskripsi) via model vision. */
async function imageToText(sock, msg, img) {
  const buffer = await downloadMediaMessage(msg, "buffer", {}, { reuploadRequest: sock.updateMediaMessage });
  const text = await describeImage(buffer, img.mimetype || "image/jpeg", img.caption || "");
  return { text, buffer };
}

async function handleGroup(sock, jid, msg, text, botJid, send, imageText = null, imageBuffer = null, imageMimetype = null, messageId = null) {
  // /start → daftarkan grup + set wilayah.
  if (isStartCommand(text)) {
    await markRead(sock, msg);
    await presence(sock, jid, "composing");
    try {
      await registerTarget({ jid, text, send, isGroup: true });
    } finally {
      await presence(sock, jid, "paused");
    }
    return;
  }

  // F2.2: di grup, hanya merespons saat di-mention. Selain itu DIAM (tak tandai dibaca/ketik).
  const mentioned = isMentioned(msg, sock);
  if (process.env.WA_DEBUG) {
    const ctx = unwrap(msg.message)?.extendedTextMessage?.contextInfo;
    console.log("[grup-debug] mention=%s | bot.id=%s bot.lid=%s | mentionedJid=%j", mentioned, sock?.user?.id, sock?.user?.lid, ctx?.mentionedJid || []);
  }
  if (!mentioned) return;

  await markRead(sock, msg);
  await presence(sock, jid, "composing");
  try {
    const cleanText = text.replace(/@\d+/g, "").trim();
    const grup = await getGrup(jid);
    if (!isRegisteredTarget(grup)) {
      await send(startUsage(true));
      return;
    }
    const scopeTags = groupScopeTags(grup);
    // Riwayat chat per-ORANG di dalam grup (bukan per-grup) → konteks follow-up tak kecampur antar warga.
    const sender = userPart(msg.key.participant || msg.participant || jid);
    await handleContent(sock, jid, {
      text: cleanText || text,
      konteks: "grup",
      scopeTags,
      wilayahTag: grup?.wilayah_tag || null,
      send,
      sessionId: `${jid}:${sender}`,
      imageText,
      imageBuffer,
      imageMimetype,
      messageId,
      quoted: msg, // kutip pesan pemicu pada balasan & follow-up (termasuk jawaban tertunda)
    });
  } finally {
    await presence(sock, jid, "paused");
  }
}

/**
 * Jawab pesan berkonten, dan bila user menanyakan info untuk daerah yang BELUM ada di KB,
 * picu on-demand scraping: balas 'bentar ya' lalu follow-up otomatis setelah datanya ketemu.
 */
async function handleContent(sock, jid, { text, konteks, scopeTags, wilayahTag, justGreeted, send, sessionId, imageText = null, imageBuffer = null, imageMimetype = null, messageId = null, quoted = null }) {
  rememberAduanKontenUrlFromText(sessionId, [text, imageText].filter(Boolean).join("\n\n"));

  // Daerah spesifik yang disebut user (atau wilayah grup) yang belum punya data lokal.
  const target = detectWilayahFromText(text) || (isKabKota(wilayahTag) ? wilayahTag : null);
  const uncovered = target && isKabKota(target) && (await countInfoByWilayah(target)) === 0;

  // Brain memutuskan aksi + menulis respons sekaligus (1 LLM call). Discovery regional diputuskan
  // dari aksi-nya: pertanyaan info untuk daerah yang belum ada datanya → tawarkan scrape on-demand.
  const aduanKontenStatusResult = await handleAduanKontenStatus({ text, sessionId });
  if (aduanKontenStatusResult?.reply) {
    await send(aduanKontenStatusResult.reply);
    return;
  }

  const kontenResult = await handleLaporKonten({ text, imageText, imageBuffer, imageMimetype, sessionId, messageId });
  if (kontenResult?.reply) {
    await send(kontenResult.reply);
    return;
  }

  // Simpan gambar ke image store agar bisa dipakai saat submit aduan layanan via LLM tool
  if (imageBuffer && sessionId) {
    storeImageForSession(sessionId, { imageBuffer, imageMimetype, imageText });
  }

  // Untuk gambar tanpa teks: tangkap dulu di lapor-layanan agar buffer tersimpan di pending state,
  // menunggu teks penjelasan dari warga. Pesan teks biasa langsung ke brain (tidak perlu keyword matching).
  if (imageBuffer && !text) {
    const imageOnlyResult = await handleLaporLayanan({ text, imageText, imageBuffer, imageMimetype, sessionId, messageId });
    if (imageOnlyResult?.reply) {
      await send(imageOnlyResult.reply);
      return;
    }
  }

  // Cek pending image state (warga sedang menunggu konfirmasi setelah kirim gambar)
  if (hasPendingLaporanLayanan(sessionId)) {
    const pendingResult = await handleLaporLayanan({ text, imageText, imageBuffer, imageMimetype, sessionId, messageId });
    if (pendingResult?.reply) {
      await send(pendingResult.reply);
      return;
    }
  }

  const result = await respondToMessage({ text, konteks, scopeTags, wilayahTag, justGreeted, sessionId });

  if (result.aksi === "info" && uncovered && config.onDemandDiscovery.enabled && hasSearch() && !recentlyAttempted(target)) {
    if (regionJobs.has(target)) {
      await send(`Sabar ya kak 🙏 info buat *${humanWilayah(target)}* lagi aku cariin, sebentar lagi aku kabarin.`);
    } else {
      regionAttempts.set(target, Date.now());
      await send(`Oke, soal bansos di *${humanWilayah(target)}* aku belum punya datanya nih. ` + `Bentar ya, aku cariin dari situs resmi pemerintah dulu… 🔎 nanti aku kabarin lagi.`);
      discoverAndFollowUp(sock, jid, { text, konteks, scopeTags, target, sessionId, quoted }); // background, JANGAN di-await
    }
    return;
  }

  if (result.reply) {
    const reply = await maybeOfferAduanKontenReport({ text, reply: result.reply, imageText, imageBuffer, imageMimetype, sessionId, messageId });
    await send(reply);
  }
}

/** Proses latar belakang: scrape daerah lewat web search, lalu kirim follow-up berisi hasilnya. */
async function discoverAndFollowUp(sock, jid, { text, konteks, scopeTags, target, sessionId, quoted = null }) {
  regionJobs.add(target);
  try {
    await scrapeRegion(humanWilayah(target), target);

    // Jawab ulang dengan scope yang mencakup daerah target (+ provinsinya).
    const newScope = scopeTags ? [...new Set([...scopeTags, target, inferProvinsiTag(target)].filter(Boolean))] : null;
    await presence(sock, jid, "composing");
    const { reply, grounded } = await respondToMessage({
      text,
      konteks,
      scopeTags: newScope,
      wilayahTag: target,
      sessionId,
    });

    const found = (await countInfoByWilayah(target)) > 0;
    let out;
    if (found && grounded) {
      out = `Udah ketemu nih buat *${humanWilayah(target)}* 🙌\n\n${reply}`;
    } else if (grounded) {
      // Tak nemu khusus daerahnya, tapi ada program nasional yang tetap berlaku.
      out = `Aku belum nemu info bansos KHUSUS *${humanWilayah(target)}* di situs resmi 🙏 ` + `Tapi ini yang berlaku umum/nasional buat kamu:\n\n${reply}`;
    } else {
      out = `Maaf kak, udah aku cari di situs resmi tapi belum nemu info bansos buat *${humanWilayah(target)}* 🙏 ` + `Coba cek langsung di cekbansos.kemensos.go.id atau tanya RT/pengurus setempat ya.`;
    }
    // Beri label agar jelas ini JAWABAN TERTUNDA dari pertanyaan tadi (datang setelah jeda
    // pencarian), bukan pesan acak di tengah obrolan lain. Mengurangi kesan 'bot ngelantur'.
    await sock.sendMessage(jid, { text: `📌 _Lanjutan dari pencarianku tadi soal *${humanWilayah(target)}*:_\n\n${out}` }, quoted ? { quoted } : undefined);
  } catch (e) {
    console.warn("[ondemand] gagal:", e?.message);
    await sock.sendMessage(jid, { text: `Maaf kak, ada kendala pas nyari info *${humanWilayah(target)}*. Coba lagi nanti ya 🙏` }, quoted ? { quoted } : undefined).catch(() => {});
  } finally {
    regionJobs.delete(target);
    await presence(sock, jid, "paused");
  }
}

async function handleJapri(sock, jid, msg, text, send, imageText = null, imageBuffer = null, imageMimetype = null, messageId = null) {
  await markRead(sock, msg); // centang biru
  await presence(sock, jid, "composing"); // 'mengetik...'

  try {
    if (isStartCommand(text)) {
      const registered = await registerTarget({ jid, text, send, isGroup: false });
      if (registered) greeted.add(jid);
      return;
    }

    const registered = await getGrup(jid);
    if (!isRegisteredTarget(registered)) {
      await send(startUsage(false));
      return;
    }

    // F2.6: pesan pertama di japri → sapaan pembuka (sekali per sesi proses).
    let justGreeted = false;
    if (!greeted.has(jid)) {
      greeted.add(jid);
      justGreeted = true;
      await send(GREETING);
    }
    // Japri tidak terikat satu grup → tanpa filter wilayah (semua sumber resmi).
    // justGreeted → handler tidak mengulang perkenalan kalau pesannya cuma sapaan.
    await handleContent(sock, jid, {
      text,
      konteks: "japri",
      scopeTags: groupScopeTags(registered),
      wilayahTag: registered.wilayah_tag,
      justGreeted,
      send,
      sessionId: jid,
      imageText,
      imageBuffer,
      imageMimetype,
      messageId,
    });
  } finally {
    await presence(sock, jid, "paused");
  }
}
