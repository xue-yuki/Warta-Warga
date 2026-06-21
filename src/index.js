import { getDb, countChunks, countInfoBansos } from './db/index.js';
import { hasLLM, config } from './config.js';
import { startBot } from './wa/bot.js';
import { startAutoScrape } from './agent1/scheduler.js';

async function main() {
  getDb(); // init skema
  console.log('🏘️  Warta Warga — Asisten Info Bansos + Anti-Hoaks');
  console.log(`   Knowledge Base: ${countInfoBansos()} info, ${countChunks()} chunk`);
  console.log(`   Embeddings: ${config.embeddings.provider} | LLM: ${hasLLM() ? 'OpenRouter aktif' : 'TIDAK aktif (mode fallback)'}`);
  if (countChunks() === 0) {
    console.warn('   ⚠️  KB kosong. Jalankan `npm run seed` (data sintetis) atau `npm run ingest` dulu.');
  }
  if (!hasLLM()) {
    console.warn('   ⚠️  OPENROUTER_API_KEY belum diset — jawaban memakai fallback ekstraktif/heuristik.');
  }
  // Agent 1 jalan otomatis di latar belakang (refresh KB dari sumber resmi).
  startAutoScrape();

  console.log('\nMenyalakan WhatsApp bot...\n');
  await startBot();
}

main().catch((err) => {
  console.error('Gagal start:', err);
  process.exit(1);
});
