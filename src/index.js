import { initDb, countChunks, countInfoBansos } from "./db/index.js";
import { hasLLM, hasSupabase, config } from "./config.js";
import { startBot } from "./wa/bot.js";
import { startAutoScrape } from "./agent1/scheduler.js";
import { startDashboard } from "./dashboard/server.js";
import { startLaporgubChecker } from "./agent2/laporgub-checker.js";
import { initWhitelistCache } from './agent1/fetch.js';

async function main() {
  await initDb(); // init skema (SQLite atau Postgres/Supabase)
  await initWhitelistCache(); // pre-load whitelist dari DB sebelum request pertama
  console.log("🏘️  Warta Warga — Asisten Info Bansos + Anti-Hoaks");
  console.log(`   Penyimpanan: ${hasSupabase() ? "Supabase (Postgres)" : "SQLite lokal"}`);
  const nChunks = await countChunks();
  console.log(`   Knowledge Base: ${await countInfoBansos()} info, ${nChunks} chunk`);
  console.log(`   Embeddings: ${config.embeddings.provider} | LLM: ${hasLLM() ? "OpenRouter aktif" : "TIDAK aktif (mode fallback)"}`);
  if (nChunks === 0) {
    console.warn("   ⚠️  KB kosong. Jalankan `npm run seed` (data sintetis) atau `npm run ingest` dulu.");
  }
  if (!hasLLM()) {
    console.warn("   ⚠️  OPENROUTER_API_KEY belum diset — jawaban memakai fallback ekstraktif/heuristik.");
  }
  // Agent 1 jalan otomatis di latar belakang (refresh KB dari sumber resmi).
  startAutoScrape();

  // Dashboard approval pengurus (Fitur Lapor). Embed di proses bot agar approve langsung
  // memakai koneksi WhatsApp untuk menyebar peringatan. Matikan dengan DASHBOARD_ENABLED=false.
  if ((process.env.DASHBOARD_ENABLED ?? "true") !== "false") {
    try {
      startDashboard();
    } catch (e) {
      console.warn("[dashboard] gagal start:", e.message);
    }
  }

  console.log("\nMenyalakan WhatsApp bot...\n");
  await startBot();
  // startLaporgubChecker();
}

main().catch((err) => {
  console.error("Gagal start:", err);
  process.exit(1);
});
