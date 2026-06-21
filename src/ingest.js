// CLI Agent 1 (on-demand). Contoh:
//   node src/ingest.js url https://kemensos.go.id/xxx --wilayah kabupaten:banyumas
//   node src/ingest.js file ./data/synthetic/contoh.txt --url https://dinsos.banyumaskab.go.id/x --wilayah kabupaten:banyumas
import { getDb } from './db/index.js';
import { ingestUrl, ingestLocalDoc } from './agent1/index.js';
import { hasLLM } from './config.js';

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wilayah') out.wilayah = args[++i];
    else if (args[i] === '--url') out.url = args[++i];
  }
  return out;
}

async function main() {
  const [cmd, target, ...rest] = process.argv.slice(2);
  getDb();

  if (!hasLLM()) {
    console.error('❌ Agent 1 (strukturisasi) butuh OPENROUTER_API_KEY. Untuk demo tanpa LLM, pakai `npm run seed`.');
    process.exit(1);
  }

  const flags = parseFlags(rest);

  if (cmd === 'url' && target) {
    const r = await ingestUrl(target, { hintWilayah: flags.wilayah });
    console.log(r.ok ? '✅ Selesai' : `❌ ${r.error}`);
  } else if (cmd === 'file' && target) {
    const r = await ingestLocalDoc(target, { sumberUrl: flags.url, hintWilayah: flags.wilayah });
    console.log(r.ok ? '✅ Selesai' : `❌ ${r.error}`);
  } else {
    console.log(`Pemakaian:
  node src/ingest.js url <URL_resmi> [--wilayah <tag>]
  node src/ingest.js file <path> --url <sumber_url> [--wilayah <tag>]`);
  }
  process.exit(0);
}

main();
