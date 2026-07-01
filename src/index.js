import { config } from "./config.js";
import { startBot } from "./wa/bot.js";
import { startKirimiWebhookServer } from "./wa/kirimiWebhook.js";
import { startIngestScheduler } from "./agent1/scheduler.js";
import { startDashboard } from "./dashboard/server.js";
import { initRuntime } from "./runtime/init.js";

async function main() {
  await initRuntime();

  // Agent 1 ingest scheduler jalan otomatis di latar belakang (refresh KB dari sumber resmi).
  startIngestScheduler();

  // Dashboard approval pengurus (Fitur Lapor). Embed di proses bot agar approve langsung
  // memakai koneksi WhatsApp untuk menyebar peringatan. Matikan dengan DASHBOARD_ENABLED=false.
  if ((process.env.DASHBOARD_ENABLED ?? "true") !== "false") {
    try {
      startDashboard();
    } catch (e) {
      console.warn("[dashboard] gagal start:", e.message);
    }
  }

  // Transport WhatsApp: 'kirimi' (default, hosted gateway via webhook) atau 'baileys' (fallback,
  // koneksi langsung + scan QR). Checker layanan (LaporGub + AduanKonten) di-start dari dalam
  // masing-masing transport begitu pengirim siap (connection open / server listen).
  if (config.waTransport === "baileys") {
    console.log("\nMenyalakan WhatsApp bot (transport: Baileys langsung)...\n");
    await startBot();
  } else {
    console.log("\nMenyalakan WhatsApp bot (transport: kirimi.id)...\n");
    startKirimiWebhookServer();
  }
}

main().catch((err) => {
  console.error("Gagal start:", err);
  process.exit(1);
});
