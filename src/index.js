import dns from "node:dns";
import { config } from "./config.js";
import { startBot } from "./wa/bot.js";
import { startKirimiWebhookServer } from "./wa/kirimiWebhook.js";
import { startIngestScheduler } from "./agent1/scheduler.js";
import { startDashboard } from "./dashboard/server.js";
import { initRuntime } from "./runtime/init.js";

// Server ini punya rute IPv6 yang rusak (AAAA WhatsApp/domain lain resolve tapi
// "No route to host"). Node tidak otomatis fallback ke IPv4 seperti curl/browser
// (happy eyeballs), jadi socket gagal instan dan salah dibaca sebagai timeout.
// Paksa IPv4 dulu di semua dns.lookup() supaya koneksi keluar (Baileys, fetch, dll) tidak lagi kena rute mati.
dns.setDefaultResultOrder("ipv4first");

async function main() {
  await initRuntime();
  startIngestScheduler();


  if ((process.env.DASHBOARD_ENABLED ?? "true") !== "false") {
    try {
      startDashboard();
    } catch (e) {
      console.warn("[dashboard] gagal start:", e.message);
    }
  }

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
