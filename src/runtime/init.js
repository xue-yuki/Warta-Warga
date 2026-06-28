import { initDb, countChunks, countInfoBansos } from "../db/index.js";
import { hasLLM, hasSupabase, config } from "../config.js";
import { initWhitelistCache } from "../agent1/fetch.js";

export async function initRuntime({ logStatus = true } = {}) {
  await initDb(); // init skema (SQLite atau Postgres/Supabase)
  await initWhitelistCache(); // pre-load whitelist dari DB sebelum request pertama

  const infoCount = await countInfoBansos();
  const chunkCount = await countChunks();

  if (logStatus) {
    console.log("🏘️  Warta Warga — Asisten Info Bansos + Anti-Hoaks");
    console.log(`   Penyimpanan: ${hasSupabase() ? "Supabase (Postgres)" : "SQLite lokal"}`);
    console.log(`   Knowledge Base: ${infoCount} info, ${chunkCount} chunk`);
    console.log(`   Embeddings: ${config.embeddings.provider} | LLM: ${hasLLM() ? "OpenRouter aktif" : "TIDAK aktif (mode fallback)"}`);

    if (chunkCount === 0) {
      console.warn("   ⚠️  KB kosong. Jalankan `npm run seed` (data sintetis) atau `npm run ingest` dulu.");
    }

    if (!hasLLM()) {
      console.warn("   ⚠️  OPENROUTER_API_KEY belum diset — jawaban memakai fallback ekstraktif/heuristik.");
    }
  }

  return { infoCount, chunkCount };
}
