// Demo Agent 2 tanpa WhatsApp: simulasikan japri & grup.
// Pakai: npm run demo   (pastikan sudah `npm run seed`)
import { getDb, countChunks } from '../src/db/index.js';
import { respondToMessage, GREETING } from '../src/agent2/handler.js';
import { groupScopeTags } from '../src/util/wilayah.js';
import { hasLLM } from '../src/config.js';

const line = () => console.log('─'.repeat(64));

async function ask({ text, konteks, scopeTags, label }) {
  line();
  console.log(`👤 [${label}] ${text}`);
  const { reply, jenis, label: lbl } = await respondToMessage({ text, konteks, scopeTags });
  console.log(`🤖 (jenis=${jenis}${lbl ? `, label=${lbl}` : ''})\n${reply}`);
}

async function main() {
  getDb();
  if ((await countChunks()) === 0) {
    console.error('KB kosong. Jalankan dulu: npm run seed');
    process.exit(1);
  }
  console.log(`Mode LLM: ${hasLLM() ? 'OpenRouter aktif' : 'FALLBACK (tanpa LLM)'}\n`);
  console.log('=== Sapaan pembuka japri (F2.6) ===');
  console.log(GREETING);

  // Scope grup Banyumas (nasional + provinsi + kabupaten)
  const grupBanyumas = { wilayah_tag: 'kabupaten:banyumas', provinsi_tag: 'provinsi:jawa_tengah' };
  const scopeBanyumas = groupScopeTags(grupBanyumas);

  await ask({ text: 'Syarat PKH apa saja?', konteks: 'japri', scopeTags: null, label: 'japri/info' });
  await ask({ text: 'Apakah ada bansos khusus di Banyumas?', konteks: 'grup', scopeTags: scopeBanyumas, label: 'grup/info' });
  await ask({ text: 'apakah saya pasti dapat bansos?', konteks: 'japri', scopeTags: null, label: 'japri/kelayakan' });
  await ask({
    text: 'ini bener nggak: ada bantuan PKH lewat e-warong pakai KKS?',
    konteks: 'japri', scopeTags: null, label: 'japri/klaim-verified',
  });
  await ask({
    text: 'katanya ada bantuan 600rb, tinggal klik link ini dan transfer 50rb biaya admin, bener?',
    konteks: 'japri', scopeTags: null, label: 'japri/klaim-unverified',
  });
  line();
  console.log('Selesai. (Cek juga log_interaksi anonim di DB.)');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
