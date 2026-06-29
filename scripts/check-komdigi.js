#!/usr/bin/env node
import "dotenv/config";
import { initDb, countInfoBansos } from "../src/db/index.js";
import { hasLLM } from "../src/config.js";
import { ingestKomdigiHoaks, buildPdfUrl, resolveKomdigiPdfUrl } from "../src/agent1/komdigi.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const dateIndex = args.indexOf("--date");
  return {
    date: dateIndex >= 0 ? args[dateIndex + 1] : null,
    json: args.includes("--json"),
    help: args.includes("--help") || args.includes("-h"),
  };
}

function usage() {
  return `Pemakaian:
  node scripts/check-komdigi.js [--date YYYY-MM-DD] [--json]

Contoh:
  npm run check:komdigi
  npm run check:komdigi -- --date 2026-06-29
  npm run check:komdigi -- --date 2026-06-29 --json`;
}

function parseDate(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("--date harus format YYYY-MM-DD");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error("--date tidak valid");
  }
  return date;
}

async function main() {
  const argv = parseArgs();
  if (argv.help) {
    console.log(usage());
    return;
  }

  const date = parseDate(argv.date);
  const label = argv.date || new Date().toISOString().slice(0, 10);
  console.log(`[check-komdigi] start date=${label}`);
  console.log(`[check-komdigi] candidate=${buildPdfUrl(date || new Date())}`);

  try {
    const resolvedUrl = await resolveKomdigiPdfUrl(date || new Date());
    console.log(`[check-komdigi] resolved=${resolvedUrl || "tidak ada di listing, akan coba fallback kemarin"}`);
  } catch (err) {
    console.warn(`[check-komdigi] gagal resolve listing: ${err.message}`);
  }

  await initDb();

  if (!hasLLM()) {
    const result = { ok: false, error: "OPENROUTER_API_KEY belum diset" };
    if (argv.json) console.log(JSON.stringify(result, null, 2));
    console.error("[check-komdigi] gagal: OPENROUTER_API_KEY belum diset");
    process.exitCode = 1;
    return;
  }

  const before = await countInfoBansos();
  const result = await ingestKomdigiHoaks(date ? { date } : {});
  const after = await countInfoBansos();

  const summary = {
    ...result,
    requestedDate: label,
    totalInfoBefore: before,
    totalInfoAfter: after,
  };

  if (argv.json) {
    console.log(JSON.stringify(summary, null, 2));
  }

  if (result.ok) {
    console.log(`[check-komdigi] done ok count=${result.count ?? 0} total=${before}->${after}`);
    return;
  }

  if (result.skip) {
    console.log(`[check-komdigi] done skip total=${before}->${after}`);
    return;
  }

  console.error(`[check-komdigi] gagal: ${result.error || "unknown_error"}`);
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-komdigi.js")) {
  main().catch((err) => {
    console.error("[check-komdigi] fatal", err);
    process.exitCode = 2;
  });
}
