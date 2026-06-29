// Demo validasi alur WhatsApp tanpa konek ke WhatsApp.
// Jalankan: npm run demo:wa-validation
//
// Yang dicek:
// 1. Nomor/grup wajib /start dulu sebelum chat apa pun.
// 2. Menu angka dengan teks tambahan tetap dianggap menu, mis. "1 saya mau tanya".
// 3. Balasan lapor memakai format aman: jelaskan dulu, baru bilang laporan dicatat.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.SUPABASE_DB_URL = "";
process.env.DB_PATH = process.env.DEMO_WA_DB_PATH || path.join(os.tmpdir(), `warta-warga-demo-wa-validation-${process.pid}.db`);

const { getGrup, upsertGrup } = await import("../src/db/index.js");
const { respondToMessage } = await import("../src/agent2/handler.js");
const { formatCatatLaporanReply } = await import("../src/agent2/brain.js");
const { hasLLM } = await import("../src/config.js");
const { groupScopeTags } = await import("../src/util/wilayah.js");
const { startUsage } = await import("../src/wa/bot.js");

const runId = Date.now();
const privateJid = `demo-${runId}@s.whatsapp.net`;
const groupJid = `demo-${runId}@g.us`;

function printCase(title, reply) {
  console.log("\n" + "-".repeat(72));
  console.log(title);
  console.log("-".repeat(72));
  console.log(reply);
}

function isStartCommand(text) {
  return /^\/start\b/i.test(String(text || "").trim());
}

async function ensureRegistered(jid, isGroup, text) {
  if (isStartCommand(text)) return null;
  const row = await getGrup(jid);
  return row && Number(row.status_start) === 1 ? row : null;
}

async function main() {
  console.log("Demo DB:", process.env.DB_PATH);

  const blockedPrivate = await ensureRegistered(privateJid, false, "halo min");
  assert.equal(blockedPrivate, null);
  const privateStartReply = startUsage(false);
  assert.match(privateStartReply, /\/start <daerah>/i);
  printCase("1. Nomor belum /start -> ditolak ke instruksi /start", privateStartReply);

  const blockedGroup = await ensureRegistered(groupJid, true, "1 saya mau tanya bansos");
  assert.equal(blockedGroup, null);
  const groupStartReply = startUsage(true);
  assert.match(groupStartReply, /\/start <daerah>/i);
  printCase("2. Grup belum /start lalu mention bot -> ditolak ke instruksi /start", groupStartReply);

  const privateRegistered = await upsertGrup({
    idGrup: privateJid,
    daerah: "Kab. Banyumas",
    wilayahTag: "kabupaten:banyumas",
    provinsiTag: "provinsi:jawa_tengah",
  });
  assert.equal(privateRegistered.status_start, 1);
  assert.equal((await getGrup(privateJid)).wilayah_tag, "kabupaten:banyumas");
  printCase("3. /start Kab. Banyumas -> nomor terdaftar", JSON.stringify(privateRegistered, null, 2));

  const groupRegistered = await upsertGrup({
    idGrup: groupJid,
    daerah: "Kab. Banyumas",
    wilayahTag: "kabupaten:banyumas",
    provinsiTag: "provinsi:jawa_tengah",
  });
  const scopeTags = groupScopeTags(groupRegistered);
  assert.deepEqual(scopeTags, ["nasional", "kabupaten:banyumas", "provinsi:jawa_tengah"]);

  const menuInfo = await respondToMessage({
    text: "1 saya mau tanya PKH",
    konteks: "japri",
    scopeTags,
    wilayahTag: privateRegistered.wilayah_tag,
    sessionId: `${privateJid}:menu-info`,
  });
  assert.equal(menuInfo.aksi, "info");
  assert.equal(menuInfo.label, "menu");
  assert.match(menuInfo.reply, /Silakan, info bansos apa/i);
  assert.match(menuInfo.reply, /Banyumas/i);
  printCase('4. "1 saya mau tanya PKH" -> tetap masuk menu tanya bansos + konteks wilayah', menuInfo.reply);

  const menuLapor = await respondToMessage({
    text: "3 link palsu bansos",
    konteks: "grup",
    scopeTags,
    wilayahTag: groupRegistered.wilayah_tag,
    sessionId: `${groupJid}:menu-lapor`,
  });
  assert.equal(menuLapor.aksi, "lapor");
  assert.equal(menuLapor.label, "menu");
  assert.match(menuLapor.reply, /Silakan ceritakan penipuan/i);
  assert.match(menuLapor.reply, /Banyumas/i);
  printCase('5. "3 link palsu bansos" -> tetap masuk menu lapor + konteks wilayah', menuLapor.reply);

  const deterministicReportReply = formatCatatLaporanReply(
    {
      ringkasan_modus: "Ada link pendaftaran bansos palsu yang meminta NIK dan OTP.",
      tingkat_bahaya: "jelas_penipuan",
      teks_peringatan: "Jangan isi data pribadi atau OTP lewat link pendaftaran bansos yang tidak jelas.",
    },
    { ok: true, wilayah: "Kab./Kota Banyumas" },
  );
  assert.match(deterministicReportReply, /^🚨/);
  assert.match(deterministicReportReply, /Kenapa bahaya:/);
  assert.match(deterministicReportReply, /Laporan Bapak\/Ibu sudah saya catat/);
  printCase("6. Format lapor deterministik -> jelaskan dulu, catat di akhir", deterministicReportReply);

  if (hasLLM()) {
    const aiReport = await respondToMessage({
      text: "Saya lapor ada link pendaftaran bansos palsu yang minta NIK dan kode OTP.",
      konteks: "japri",
      scopeTags,
      wilayahTag: privateRegistered.wilayah_tag,
      sessionId: `${privateJid}:ai-report`,
    });
    assert.equal(aiReport.aksi, "lapor");
    assert.match(aiReport.reply, /Kenapa bahaya:/);
    assert.match(aiReport.reply, /Laporan Bapak\/Ibu sudah saya catat/);
    printCase("7. AI lapor real dengan LLM -> wajib explain + catat", aiReport.reply);
  } else {
    printCase("7. AI lapor real dengan LLM", "SKIP: OPENROUTER_API_KEY belum diset. Format deterministik sudah divalidasi di langkah 6.");
  }

  console.log("\nSemua validasi demo selesai.");
}

main().catch((err) => {
  console.error("\nDemo validasi gagal:", err);
  process.exit(1);
});
