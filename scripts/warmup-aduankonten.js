#!/usr/bin/env node
import "dotenv/config";
import { warmupAduanKontenSession } from "../src/portal/aduankonten.js";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv.length > idx + 1) return process.argv[idx + 1];
  return fallback;
}

async function main() {
  const headless = process.argv.includes("--headless");
  const waitMs = Number(argValue("wait-ms", 300000));
  const debugDir = argValue("debug-dir", process.argv.includes("--debug") ? "./debug/aduankonten" : null);

  console.log("[warmup-aduankonten] browser:", headless ? "headless" : "headed");
  console.log("[warmup-aduankonten] wait ms:", waitMs);
  if (debugDir) console.log("[warmup-aduankonten] debug dir:", debugDir);
  console.log("[warmup-aduankonten] Selesaikan Cloudflare secara manual jika muncul. Script lanjut otomatis setelah form search terlihat.");

  const result = await warmupAduanKontenSession({
    headless,
    waitMs,
    debugDir: debugDir || undefined,
  });

  console.log("\n--- WARMUP RESULT ---");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[warmup-aduankonten] fatal", err?.message || err);
  if (process.argv.includes("--stack") && err?.stack) {
    console.error(err.stack);
  }
  process.exitCode = 2;
});
