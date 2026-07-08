import dns from "node:dns";
import net from "node:net";
import { config } from "./config.js";
import { startBot } from "./wa/bot.js";
import { startKirimiWebhookServer } from "./wa/kirimiWebhook.js";
import { startIngestScheduler } from "./agent1/scheduler.js";
import { startDashboard } from "./dashboard/server.js";
import { initRuntime } from "./runtime/init.js";

dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(false);

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
