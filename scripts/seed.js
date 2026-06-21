// Seed Knowledge Base + DB dari data sintetis pre-strukturkan.
// Berjalan OFFLINE (tanpa OPENROUTER_API_KEY) — memakai embeddings lokal.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../src/config.js';
import { getDb, resetKnowledge, countInfoBansos, countChunks } from '../src/db/index.js';
import { storeStructured } from '../src/agent1/index.js';

async function main() {
  getDb();
  console.log(`🌱 Seeding KB (embeddings: ${config.embeddings.provider})...`);
  resetKnowledge();

  const file = path.join(ROOT, 'data', 'synthetic', 'info_bansos.json');
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));

  let ok = 0;
  for (const it of items) {
    const r = await storeStructured(it);
    if (r.ok) ok++;
    else console.warn(`  SKIP ${it.program}: ${r.error}`);
  }

  console.log(`\n✅ Selesai. ${ok}/${items.length} info tersimpan.`);
  console.log(`   Total: ${countInfoBansos()} info_bansos, ${countChunks()} chunk di vector store.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
