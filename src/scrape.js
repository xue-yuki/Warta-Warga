// CLI auto-scrape Agent 1 (sekali jalan, untuk refresh KB manual / cron OS).
//   node src/scrape.js
import { initDb } from './db/index.js';
import { hasLLM } from './config.js';
import { scrapeAllSources } from './agent1/scheduler.js';

async function main() {
  await initDb();
  if (!hasLLM()) {
    console.error('❌ Auto-scrape butuh OPENROUTER_API_KEY. Untuk demo tanpa LLM pakai `npm run seed`.');
    process.exit(1);
  }
  const r = await scrapeAllSources({ reason: 'cli' });
  console.log(`Ringkasan: ${r.ok}/${r.total} sumber tersimpan, ${r.skip} dilewati.`);
  process.exit(0);
}

main();
