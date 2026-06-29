import { startBot } from "./wa/bot.js";
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

  // Checker layanan (LaporGub + AduanKonten) distart dari bot.js via startAgent2ServiceCheckers()
  // saat koneksi WA terbuka, agar notifier sudah terdaftar sebelum checker pertama kali jalan.

  console.log("\nMenyalakan WhatsApp bot...\n");
  await startBot();
}

main().catch((err) => {
  console.error("Gagal start:", err);
  process.exit(1);
});
