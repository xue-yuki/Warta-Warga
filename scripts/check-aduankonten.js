#!/usr/bin/env node
import "dotenv/config";
import { runAduanKontenCheckerForTicket, runAduanKontenCheckerOnce } from "../src/agent2/aduankonten-checker.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const ticketIndex = args.indexOf("--ticket");
  return {
    ticket: ticketIndex >= 0 ? args[ticketIndex + 1] : null,
    run: args.includes("--run") || ticketIndex < 0,
    json: args.includes("--json"),
  };
}

async function main() {
  const argv = parseArgs();
  console.log("[check-aduankonten] start");

  if (argv.ticket) {
    const parsed = await runAduanKontenCheckerForTicket(argv.ticket);
    if (argv.json) {
      console.log(JSON.stringify(parsed, null, 2));
    }
    console.log("[check-aduankonten] done");
    return;
  }

  if (argv.run) {
    await runAduanKontenCheckerOnce();
  }
  console.log("[check-aduankonten] done");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-aduankonten.js")) {
  main().catch((err) => {
    console.error("[check-aduankonten] fatal", err);
    process.exitCode = 2;
  });
}
