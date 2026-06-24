// Tes vision (gambar→teks) + alur end-to-end ke brain.
// Pakai: node scripts/test-vision.js <path-gambar | url-gambar>
// Perlu VISION_API_KEY (Gemini) di .env. Tanpa itu, cuma ngecek konfigurasi.
import fs from 'node:fs';
import { hasVision, config } from '../src/config.js';
import { describeImage } from '../src/agent2/vision.js';
import { respondToMessage } from '../src/agent2/handler.js';

const run = async () => {
  console.log('Vision aktif:', hasVision(), '| model:', config.vision.model, '| endpoint:', config.vision.baseUrl);
  if (!hasVision()) {
    console.log('\n⚠️  VISION_API_KEY belum diset. Tambahkan di .env:');
    console.log('   VISION_API_KEY=<key Google AI Studio>');
    console.log('   (opsional) VISION_MODEL=gemini-2.0-flash');
    console.log('Buat key gratis di https://aistudio.google.com/apikey');
    return;
  }

  const src = process.argv[2];
  if (!src) {
    console.log('\nKasih path/URL gambar: node scripts/test-vision.js <gambar.jpg | https://...>');
    return;
  }

  let buffer;
  let mimetype = 'image/jpeg';
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    mimetype = res.headers.get('content-type') || mimetype;
    buffer = Buffer.from(await res.arrayBuffer());
  } else {
    buffer = fs.readFileSync(src);
    if (/\.png$/i.test(src)) mimetype = 'image/png';
  }

  console.log(`\n📷 Baca gambar (${buffer.length} byte, ${mimetype})...`);
  const desc = await describeImage(buffer, mimetype, '');
  console.log('\n=== HASIL VISION (gambar→teks) ===\n' + desc);

  console.log('\n=== BRAIN menilai (seolah warga kirim gambar ini) ===');
  const text = `[Isi gambar yang dikirim warga]\n${desc}`;
  const r = await respondToMessage({ text, konteks: 'japri', scopeTags: null, wilayahTag: null, sessionId: 'vision_test' });
  console.log('[' + r.aksi + ']\n' + r.reply);
};

run().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
