// Orkestrator pesan WhatsApp — TRANSPORT-AGNOSTIK. Dipakai baik oleh koneksi Baileys langsung
// (src/wa/bot.js) maupun webhook kirimi.id (src/wa/kirimiWebhook.js), lewat sebuah `adapter`
// kecil yang menyembunyikan detail transport:
//   adapter.send(jid, text, { quoted } = {})  -> kirim balasan
//   adapter.markRead(msg)                     -> tandai dibaca (no-op kalau transport tak dukung)
//   adapter.presence(jid, state)              -> 'composing' | 'paused' (no-op kalau tak dukung)
// `msg` yang dilempar ke sini boleh berupa apa saja (opaque) — hanya diteruskan balik ke
// adapter.markRead/adapter.send({quoted}); Baileys butuh objek pesan aslinya, kirimi tidak
// butuh apa-apa jadi boleh null.
//
// Kenapa dipisah dari bot.js: bot.js tadinya mencampur logika koneksi Baileys (socket, QR,
// reconnect, deteksi mention lewat contextInfo) dengan logika PRODUK (registrasi /start, brain,
// aduan konten, lapor layanan publik, on-demand discovery). Supaya kirimi.id dapat SEMUA fitur
// itu tanpa ditulis ulang, bagian produk dipindah ke sini dan diparameterisasi lewat adapter.

import { getGrup, upsertGrup, isAiEnabled, countInfoByWilayah } from "../db/index.js";
import { respondToMessage, GREETING } from "../agent2/handler.js";
import { handleLaporKonten, maybeOfferAduanKontenReport, rememberAduanKontenUrlFromText } from "../agent2/lapor-konten.js";
import { handleAduanKontenStatus } from "../agent2/aduankonten-status.js";
import { handleLaporLayanan, hasPendingLaporanLayanan, isPublicServiceReportIntent, storeImageForSession } from "../agent2/lapor-layanan.js";
import { groupScopeTags, normalizeWilayahTag, inferProvinsiTag, detectWilayahFromText, isKabKota, humanWilayah } from "../util/wilayah.js";
import { scrapeRegion } from "../agent1/scheduler.js";
import { config, hasSearch } from "../config.js";

// Stateless bot: hanya cache efemeral siapa yang sudah disapa (tidak dipersist → privasi).
const greeted = new Set();

// Dedup pesan: cegah balasan dobel — resync Baileys setelah reconnect, ATAU retry webhook
// kirimi.id yang mengirim event yang sama dua kali. Dipakai kedua transport lewat fungsi yang
// sama supaya tidak ada dua implementasi dedup yang bisa berbeda perilaku.
const seenMsgIds = new Set();
export function alreadySeen(id) {
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

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function isStartCommand(text) {
  return /^\/start\b/i.test(String(text || "").trim());
}

export function isRegisteredTarget(row) {
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

export async function registerTarget({ jid, text, send, isGroup }) {
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
 * Grup: /start mendaftarkan, selain itu hanya merespons kalau `addressed` true
 * (di-mention/di-reply — dideteksi oleh transport layer, bukan di sini).
 */
export async function handleGroup(adapter, { jid, msg = null, text, addressed, sender, imageText = null, imageBuffer = null, imageMimetype = null, messageId = null }) {
  const send = (body) => adapter.send(jid, body, { quoted: msg });

  if (isStartCommand(text)) {
    await adapter.markRead(msg);
    await adapter.presence(jid, "composing");
    try {
      await registerTarget({ jid, text, send, isGroup: true });
    } finally {
      await adapter.presence(jid, "paused");
    }
    return;
  }

  const sessionId = `${jid}:${sender}`;
  if (process.env.WA_DEBUG) {
    console.log("[grup-debug] addressed=%s sender=%s", addressed, sender);
  }
  if (!addressed) return;

  await adapter.markRead(msg);
  await adapter.presence(jid, "composing");
  try {
    const cleanText = text.replace(/@\d+/g, "").trim();
    const grup = await getGrup(jid);
    if (!isRegisteredTarget(grup)) {
      await send(startUsage(true));
      return;
    }
    const scopeTags = groupScopeTags(grup);
    // Riwayat chat per-ORANG di dalam grup (bukan per-grup) → konteks follow-up tak kecampur antar warga.
    await handleContent(adapter, jid, {
      text: cleanText || text,
      konteks: "grup",
      scopeTags,
      wilayahTag: grup?.wilayah_tag || null,
      send,
      sessionId,
      imageText,
      imageBuffer,
      imageMimetype,
      messageId,
      quoted: msg, // kutip pesan pemicu pada balasan & follow-up (termasuk jawaban tertunda)
    });
  } finally {
    await adapter.presence(jid, "paused");
  }
}

/**
 * Jawab pesan berkonten, dan bila user menanyakan info untuk daerah yang BELUM ada di KB,
 * picu on-demand scraping: balas 'bentar ya' lalu follow-up otomatis setelah datanya ketemu.
 */
export async function handleContent(adapter, jid, { text, konteks, scopeTags, wilayahTag, justGreeted, send, sessionId, imageText = null, imageBuffer = null, imageMimetype = null, messageId = null, quoted = null }) {
  // Saklar dashboard ("AI on/off"): kalau nonaktif, pipeline percakapan (agent2) tidak dipanggil
  // sama sekali — tidak ada balasan, tidak ada pemakaian LLM. Registrasi /start tetap jalan
  // karena itu di-handle SEBELUM titik ini (di handleGroup/handleJapri), bukan lewat AI.
  if (!(await isAiEnabled())) return;

  rememberAduanKontenUrlFromText(sessionId, [text, imageText].filter(Boolean).join("\n\n"));

  // Daerah spesifik yang disebut user (atau wilayah grup) yang belum punya data lokal.
  const target = detectWilayahFromText(text) || (isKabKota(wilayahTag) ? wilayahTag : null);
  const uncovered = target && isKabKota(target) && (await countInfoByWilayah(target)) === 0;

  let aduanKontenTypingTimer = null;
  let aduanKontenTypingReassert = null;
  const startAduanKontenTyping = async () => {
    await adapter.presence(jid, "composing");
    aduanKontenTypingReassert = setTimeout(() => {
      aduanKontenTypingReassert = null;
      if (aduanKontenTypingTimer) adapter.presence(jid, "composing").catch(() => {});
    }, 1200);
    if (!aduanKontenTypingTimer) {
      aduanKontenTypingTimer = setInterval(() => {
        adapter.presence(jid, "composing").catch(() => {});
      }, 8000);
    }
  };
  const stopAduanKontenTyping = async () => {
    if (aduanKontenTypingReassert) {
      clearTimeout(aduanKontenTypingReassert);
      aduanKontenTypingReassert = null;
    }
    if (aduanKontenTypingTimer) {
      clearInterval(aduanKontenTypingTimer);
      aduanKontenTypingTimer = null;
    }
    await adapter.presence(jid, "paused");
  };
  const handleLayananWithTyping = async (payload) => {
    await startAduanKontenTyping();
    try {
      const layananResult = await handleLaporLayanan(payload);
      if (layananResult?.reply) {
        await send(layananResult.reply);
        return true;
      }
      return false;
    } finally {
      await stopAduanKontenTyping();
    }
  };

  // Brain memutuskan aksi + menulis respons sekaligus (1 LLM call). Discovery regional diputuskan
  // dari aksi-nya: pertanyaan info untuk daerah yang belum ada datanya → tawarkan scrape on-demand.
  const aduanKontenStatusResult = await handleAduanKontenStatus({
    text,
    sessionId,
    onStatusStart: startAduanKontenTyping,
    onStatusDone: stopAduanKontenTyping,
  });
  if (aduanKontenStatusResult?.reply) {
    await send(aduanKontenStatusResult.reply);
    return;
  }

  const kontenResult = await handleLaporKonten({
    text,
    imageText,
    imageBuffer,
    imageMimetype,
    sessionId,
    messageId,
    onSubmitStart: startAduanKontenTyping,
    onSubmitResult: async (result) => {
      if (result?.reply) await send(result.reply);
    },
    onSubmitDone: stopAduanKontenTyping,
  });
  if (kontenResult?.reply) {
    await send(kontenResult.reply);
    if (kontenResult.followupReply) {
      await delay(700);
      await send(kontenResult.followupReply);
    }
    return;
  }

  // Simpan gambar ke image store agar bisa dipakai saat submit aduan layanan via LLM tool
  if (imageBuffer && sessionId) {
    storeImageForSession(sessionId, { imageBuffer, imageMimetype, imageText });
  }

  const layananMessage = [text, imageText].filter(Boolean).join("\n\n");
  if (isPublicServiceReportIntent(layananMessage)) {
    if (await handleLayananWithTyping({ text, imageText, imageBuffer, imageMimetype, sessionId, messageId })) return;
  }

  // Untuk gambar tanpa teks: tangkap dulu di lapor-layanan agar buffer tersimpan di pending state,
  // menunggu teks penjelasan dari warga. Pesan teks biasa langsung ke brain (tidak perlu keyword matching).
  if (imageBuffer && !text) {
    if (await handleLayananWithTyping({ text, imageText, imageBuffer, imageMimetype, sessionId, messageId })) return;
  }

  // Cek pending image state (warga sedang menunggu konfirmasi setelah kirim gambar)
  if (hasPendingLaporanLayanan(sessionId)) {
    if (await handleLayananWithTyping({ text, imageText, imageBuffer, imageMimetype, sessionId, messageId })) return;
  }

  const result = await respondToMessage({ text, konteks, scopeTags, wilayahTag, justGreeted, sessionId });

  if (result.aksi === "info" && uncovered && config.onDemandDiscovery.enabled && hasSearch() && !recentlyAttempted(target)) {
    if (regionJobs.has(target)) {
      await send(`Sabar ya kak 🙏 info buat *${humanWilayah(target)}* lagi aku cariin, sebentar lagi aku kabarin.`);
    } else {
      regionAttempts.set(target, Date.now());
      await send(`Oke, soal bansos di *${humanWilayah(target)}* aku belum punya datanya nih. ` + `Bentar ya, aku cariin dari situs resmi pemerintah dulu… 🔎 nanti aku kabarin lagi.`);
      discoverAndFollowUp(adapter, jid, { text, konteks, scopeTags, target, sessionId, quoted }); // background, JANGAN di-await
    }
    return;
  }

  if (result.reply) {
    const offerResult = await maybeOfferAduanKontenReport({ text, reply: result.reply, imageText, imageBuffer, imageMimetype, sessionId, messageId });
    if (typeof offerResult === "string") {
      await send(offerResult);
    } else if (offerResult?.reply) {
      await send(offerResult.reply);
      if (offerResult.followupReply) {
        await delay(700);
        await send(offerResult.followupReply);
      }
    }
  }
}

/** Proses latar belakang: scrape daerah lewat web search, lalu kirim follow-up berisi hasilnya. */
async function discoverAndFollowUp(adapter, jid, { text, konteks, scopeTags, target, sessionId, quoted = null }) {
  regionJobs.add(target);
  try {
    await scrapeRegion(humanWilayah(target), target);

    // Jawab ulang dengan scope yang mencakup daerah target (+ provinsinya).
    const newScope = scopeTags ? [...new Set([...scopeTags, target, inferProvinsiTag(target)].filter(Boolean))] : null;
    await adapter.presence(jid, "composing");
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
    await adapter.send(jid, `📌 _Lanjutan dari pencarianku tadi soal *${humanWilayah(target)}*:_\n\n${out}`, { quoted });
  } catch (e) {
    console.warn("[ondemand] gagal:", e?.message);
    await adapter.send(jid, `Maaf kak, ada kendala pas nyari info *${humanWilayah(target)}*. Coba lagi nanti ya 🙏`, { quoted }).catch(() => {});
  } finally {
    regionJobs.delete(target);
    await adapter.presence(jid, "paused");
  }
}

export async function handleJapri(adapter, { jid, msg = null, text, imageText = null, imageBuffer = null, imageMimetype = null, messageId = null }) {
  const send = (body) => adapter.send(jid, body);
  await adapter.markRead(msg); // centang biru (no-op kalau transport tak dukung)
  await adapter.presence(jid, "composing"); // 'mengetik...'

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
    await handleContent(adapter, jid, {
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
    await adapter.presence(jid, "paused");
  }
}
