#!/usr/bin/env node
import "dotenv/config";
import { handleLaporKonten } from "../src/agent2/lapor-konten.js";
import { ADUANKONTEN_CATEGORIES, probeAduanKontenSearch, submitAduanKonten } from "../src/portal/aduankonten.js";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv.length > idx + 1) return process.argv[idx + 1];
  return fallback;
}

function parseArgs() {
  const categoryKey = argValue("category", "perjudian");
  const category = ADUANKONTEN_CATEGORIES[categoryKey] || ADUANKONTEN_CATEGORIES.perjudian;
  const url = argValue("url", "https://example.com");
  const reason = argValue("reason", `URL ${url} diduga memuat konten negatif yang perlu diverifikasi oleh Aduan Konten.`);
  const text = argValue("text", `tolong laporkan situs judi ${url}`);
  const debugDir = argValue("debug-dir", process.argv.includes("--debug") ? "./debug/aduankonten" : null);
  const headless = !process.argv.includes("--headed") && argValue("headless", "true") !== "false";
  const challengeWaitMs = Number(argValue("challenge-wait-ms", headless ? 30000 : 180000));
  return {
    submit: process.argv.includes("--submit"),
    probe: process.argv.includes("--probe"),
    url,
    reason,
    text,
    categoryKey,
    category,
    attachment: argValue("attachment", null),
    debugDir,
    headless,
    challengeWaitMs,
  };
}

async function main() {
  const argv = parseArgs();

  console.log("[demo-aduankonten] mode:", argv.probe ? "search probe" : argv.submit ? "LIVE SUBMIT" : "dry-run");
  console.log("[demo-aduankonten] category:", argv.categoryKey, `(${argv.category.id})`);
  console.log("[demo-aduankonten] url:", argv.url);
  if (argv.debugDir) console.log("[demo-aduankonten] debug dir:", argv.debugDir);
  if (!argv.headless) console.log("[demo-aduankonten] browser: headed");
  console.log("[demo-aduankonten] challenge wait ms:", argv.challengeWaitMs);

  if (argv.probe) {
    const result = await probeAduanKontenSearch({
      url: argv.url,
      headless: argv.headless,
      debugDir: argv.debugDir || undefined,
      challengeWaitMs: argv.challengeWaitMs,
    });
    console.log("\n--- SEARCH PROBE RESULT ---");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!argv.submit) {
    const sessionId = "demo-aduankonten@s.whatsapp.net";
    const first = await handleLaporKonten({ text: argv.text, sessionId, messageId: "demo-1" });
    console.log("\n--- BOT REPLY 1 ---");
    console.log(first?.reply || "(tidak terdeteksi sebagai laporan AduanKonten)");

    const cancel = await handleLaporKonten({ text: "tidak", sessionId, messageId: "demo-2" });
    console.log("\n--- BOT REPLY 2 (cancel) ---");
    console.log(cancel?.reply || "(tidak ada pending flow)");
    console.log("\nGunakan --submit untuk benar-benar mengirim ke aduankonten.id.");
    return;
  }

  const result = await submitAduanKonten({
    url: argv.url,
    categoryId: argv.category.id,
    reason: argv.reason,
    attachmentPath: argv.attachment,
    headless: argv.headless,
    debugDir: argv.debugDir || undefined,
    challengeWaitMs: argv.challengeWaitMs,
  });
  console.log("\n--- SUBMIT RESULT ---");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[demo-aduankonten] fatal", err?.message || err);
  if (process.argv.includes("--stack") && err?.stack) {
    console.error(err.stack);
  }
  process.exitCode = 2;
});
