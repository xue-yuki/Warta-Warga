import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../src/config.js';
import { initDb } from '../src/db/index.js';
import { generateAndSavePoster } from '../src/llm/imageGen.js';
import { storeStructured } from '../src/agent1/index.js';

// Setup mock global fetch to bypass real API key requirement
const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

global.fetch = async (url, options) => {
  console.log(`[Mock Fetch] Intercepted call to: ${url}`);
  return new Response(JSON.stringify({
    data: [{ b64_json: tinyPngBase64 }]
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

// Force key to be considered present for test run
config.images.apiKey = 'mock-key';

async function main() {
  console.log('🏁 Starting image generation & database integration test...');

  // Initialize DB
  await initDb();

  // Create clean slate data directory if not exists
  const postersDir = path.join(ROOT, 'data', 'posters');
  if (fs.existsSync(postersDir)) {
    fs.rmSync(postersDir, { recursive: true, force: true });
  }

  // 1. Test DALL-E Generator mock call
  const record = {
    id: 9999,
    program: 'Bantuan Token Listrik Gratis 2026',
    ringkasan: 'Subsidi listrik bulanan bagi warga rentan dan miskin di daerah Banyumas.',
    syarat: ['Terdaftar di DTKS', 'Daya listrik rumah maksimal 450VA'],
    tanggal_penting: 'Setiap tanggal 1 awal bulan',
    batas_daftar: '2026-12-31',
    cara_daftar: 'Bawa kartu keluarga ke kantor kelurahan terdekat',
    wilayah_tag: 'kabupaten:banyumas',
    sumber_url: 'https://banyumaskab.go.id/listrik-gratis',
    tanggal_ambil: '2026-06-26'
  };

  const imagePath = await generateAndSavePoster(record);
  if (!imagePath) {
    console.error('❌ Failed: generateAndSavePoster returned null.');
    process.exit(1);
  }

  if (!fs.existsSync(imagePath)) {
    console.error(`❌ Failed: File does not exist at path: ${imagePath}`);
    process.exit(1);
  }
  console.log('✅ generateAndSavePoster succeeded, file saved.');

  // 2. Test Ingestion flow (storeStructured integration)
  const result = await storeStructured(record);
  if (!result.ok) {
    console.error(`❌ Failed: storeStructured failed with error: ${result.error}`);
    process.exit(1);
  }

  const storedRecord = result.record;
  if (!storedRecord.image_path) {
    console.error('❌ Failed: Stored record is missing image_path.');
    process.exit(1);
  }

  if (!storedRecord.image_path.includes('data/posters/info_')) {
    console.error(`❌ Failed: Stored image_path format incorrect: ${storedRecord.image_path}`);
    process.exit(1);
  }
  console.log(`✅ Ingestion integration succeeded! Record saved with image_path: ${storedRecord.image_path}`);

  console.log('🎉 End-to-end local integration test passed successfully!');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Exception occurred:', err);
  process.exit(1);
});
