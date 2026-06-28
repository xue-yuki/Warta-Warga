// Init skema DB + cache konfigurasi tanpa menyalakan WhatsApp bot.
// Jalankan:
//   npm run init

import { initRuntime } from "../src/runtime/init.js";

async function main() {
  await initRuntime();
  console.log("\n✅ Init selesai. Bot belum dinyalakan.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Init gagal:", err);
  process.exit(1);
});
