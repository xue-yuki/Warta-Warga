import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../src/config.js';
import { initDb, upsertGrup, countInfoBansos } from '../src/db/index.js';
import { generateAndSavePoster } from '../src/llm/imageGen.js';
import { storeStructured } from '../src/agent1/index.js';
import { setBroadcaster, broadcastNewInfos } from '../src/agent1/broadcast.js';

// Use a temporary demo DB file to avoid dirtying the production database
process.env.DB_PATH = './data/_demo_gpt_image.db';

async function main() {
  console.log('🎬 DEMO: Ingest and Broadcast with ChatGPT Image Generator (gpt-image-2)');
  console.log('======================================================================');

  // Verify API credentials
  const apiKey = config.images.apiKey;
  const model = config.images.model;
  
  if (!apiKey) {
    console.error('❌ Error: No API key found. Make sure to define IMAGE_API_KEY or OPENAI_API_KEY in your .env file.');
    process.exit(1);
  }

  console.log(`🔑 API Key detected.`);
  console.log(`🤖 Using Image Model: ${model}`);
  console.log(`📁 Saving posters in: data/posters/\n`);

  // Clean old demo DB
  if (fs.existsSync(process.env.DB_PATH)) {
    fs.rmSync(process.env.DB_PATH);
  }

  // Initialize DB
  await initDb();

  // 1. Setup a demo WhatsApp group
  const jid = 'demo-group-banyumas@g.us';
  await upsertGrup({
    idGrup: jid,
    daerah: 'Kab. Banyumas',
    wilayahTag: 'kabupaten:banyumas',
    provinsiTag: 'provinsi:jawa_tengah'
  });
  console.log(`✅ Demo WhatsApp group registered: ${jid} (Kab. Banyumas)`);

  // 2. Define a sample Bansos record
  const sampleBansos = {
    program: 'Bantuan Pangan Beras 10kg Banyumas',
    ringkasan: 'Pemerintah menyalurkan bantuan beras 10kg untuk keluarga miskin ekstrim di Banyumas periode Juli 2026.',
    syarat: ['Terdaftar di desil 1-3 DTKS', 'Membawa KTP asli saat pengambilan'],
    tanggal_penting: 'Penyaluran mulai 5 Juli - 15 Juli 2026',
    batas_daftar: '2026-07-01',
    cara_daftar: 'Hubungi ketua RT/RW setempat untuk verifikasi undangan',
    wilayah_tag: 'kabupaten:banyumas',
    sumber_url: 'https://banyumaskab.go.id/beras-10kg',
    tanggal_ambil: new Date().toISOString().slice(0, 10)
  };

  console.log('\n🚀 Starting ingestion pipeline...');
  console.log(`➡️ Ingesting program: "${sampleBansos.program}"...`);
  
  // This will call generateAndSavePoster using the real API credentials, save it, and save path to SQLite
  const result = await storeStructured(sampleBansos);
  if (!result.ok) {
    console.error(`❌ Ingestion failed: ${result.error}`);
    process.exit(1);
  }

  const storedRecord = result.record;
  console.log('✅ Ingestion succeeded.');
  console.log(`📁 Stored image file path: ${storedRecord.image_path}`);

  // 3. Setup console broadcaster to show the final message
  setBroadcaster(async (targetJid, text, imagePath) => {
    console.log('\n======================================================');
    console.log(`📤 BROADCASTING TO WA GROUP: ${targetJid}`);
    console.log('======================================================');
    if (imagePath) {
      console.log(`🖼️ [ATTACHED IMAGE PATH]: ${imagePath}`);
      console.log(`🔍 (Click link to view generated image: file://${imagePath})`);
    } else {
      console.log('📝 [ATTACHED IMAGE]: None (Standard Text-only Broadcast)');
    }
    console.log('------------------------------------------------------');
    console.log(text);
    console.log('======================================================\n');
  });

  // 4. Trigger Broadcast
  console.log('📢 Launching broadcast process...');
  const broadcastResult = await broadcastNewInfos([storedRecord]);
  console.log(`🎉 Demo complete! Sent broadcasts for ${broadcastResult.infos} program(s) across ${broadcastResult.sent} group(s).`);
  
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Demo exception:', err);
  process.exit(1);
});
