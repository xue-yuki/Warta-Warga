#!/usr/bin/env node
import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "node:crypto";
import { config, hasLLM, hasLaporGub } from "../src/config.js";
import { listSubmittedLaporanLayanan, getLaporanLayanan, updateLaporanLayananStatus } from "../src/db/index.js";
import { chatJson, chat } from "../src/llm/openrouter.js";
import { fetchLaporGubDetail } from "../src/portal/laporgub.js";

const USER_AGENT = "WartaWargaBot/0.1 (+https://github.com/wartawarga)";

function ticketRaw(ticket) {
  if (!ticket) return "";
  const cleaned = String(ticket).trim();
  return /^LGWP/i.test(cleaned) ? cleaned : `LGWP${cleaned}`;
}

function normalizeTicketForFilter(ticket) {
  if (!ticket) return "";
  return ticketRaw(ticket).toUpperCase();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    debug: args.includes("--debug"),
    ticket: null,
    ticketFilter: null,
  };
  const ticketIndex = args.indexOf("--ticket");
  if (ticketIndex >= 0 && args.length > ticketIndex + 1) {
    result.ticket = ticketRaw(String(args[ticketIndex + 1]));
  }
  const filterIndex = args.indexOf("--ticket-filter");
  if (filterIndex >= 0 && args.length > filterIndex + 1) {
    result.ticketFilter = normalizeTicketForFilter(String(args[filterIndex + 1]));
  }
  return result;
}

function sha1(str) {
  return crypto
    .createHash("sha1")
    .update(String(str || ""))
    .digest("hex");
}

function cleanText(s) {
  if (!s) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

function ticketUrl(ticket) {
  return `${String(config.laporgub.baseUrl || "https://laporgub.jatengprov.go.id").replace(/\/+$/, "")}/detail/${encodeURIComponent(String(ticket).trim())}.html`;
}

async function fetchDetail(ticket) {
  if (hasLaporGub()) {
    return await fetchLaporGubDetail(ticket);
  }
  const url = ticketUrl(ticket);
  const res = await axios.get(url, { headers: { "User-Agent": USER_AGENT }, timeout: 20000 });
  return res.data;
}

function parseTimeline(html) {
  const $ = cheerio.load(html);
  let nodes = $(".timeline-content");
  if (!nodes.length) {
    nodes = $(".timeline-item .timeline-content");
  }

  const items = [];
  nodes.each((i, el) => {
    const $el = $(el);
    const title = cleanText($el.find(".timeline-title").text());
    const date = cleanText($el.find(".timeline-date").text());
    const user = cleanText($el.find(".timeline-user").text());
    // Keep inner HTML then normalize spacing (preserve line breaks minimally)
    let descHtml = $el.find(".timeline-description").html() || "";
    // Replace multiple <br> / p with newlines then strip tags
    descHtml = descHtml
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<p[^>]*>/gi, "\n")
      .replace(/<\/p>/gi, "\n");
    const description = cleanText(cheerio.load(descHtml).text());
    if (title || date || user || description) {
      items.push({ title, date, user, description });
    }
  });

  return items;
}

async function formatWithLLM(items) {
  // Ask LLM to return a JSON with `items` and `summary`. Keep content faithful.
  const payload = [];
  payload.push({
    role: "system",
    content: `You are a concise assistant that formats timeline updates into a strict JSON object. Given timeline entries extracted from an official site, you MUST NOT add new facts, invent dates, or change the meaning. Return a JSON object with keys:\n- items: array of {title, date, responder, description} (strings)\n- conclusion: one short paragraph (Indonesian) summarizing the current status, based ONLY on the provided entries.\nDo NOT include any markup or explanation outside the JSON.`,
  });
  const body = ["Here are the timeline entries (preserve exact text):", ""];
  items.forEach((it, idx) => {
    body.push(`${idx + 1}. TITLE: ${it.title}`);
    body.push(`   DATE: ${it.date}`);
    body.push(`   RESPONDER: ${it.user}`);
    body.push(`   DESCRIPTION: ${it.description}`);
    body.push("");
  });
  payload.push({ role: "user", content: body.join("\n") });

  try {
    const parsed = await chatJson({ tier: "fast", messages: payload });
    if (!parsed) return null;
    // Normalize keys
    if (Array.isArray(parsed.items)) {
      parsed.items = parsed.items.map((it) => ({
        title: it.title || it.timeline_title || it["Timeline Title"] || "",
        date: it.date || it.timeline_date || "",
        responder: it.responder || it.user || it["Responder"] || "",
        description: it.description || it.timeline_description || "",
      }));
    }
    return parsed;
  } catch (e) {
    console.warn("[LLM] formatting failed:", e?.message || e);
    return null;
  }
}

function formatTemplate(items) {
  const lines = [];
  lines.push(`📌 Pembaruan Laporan — ${items.length} entri terbaru`);
  lines.push("");
  items.forEach((it) => {
    lines.push(`• *${it.title || "-"}*`);
    if (it.date) lines.push(`  Tanggal: ${it.date}`);
    if (it.user) lines.push(`  Oleh: ${it.user}`);
    if (it.description) lines.push(`  Isi: ${it.description}`);
    lines.push("");
  });
  // Simple heuristic summary
  const titles = items.map((i) => (i.title || "").toLowerCase()).join(" ");
  let conclusion = `Ada ${items.length} pembaruan pada laporan Anda.`;
  if (titles.includes("verifikasi")) {
    conclusion = "Status: laporan sedang proses verifikasi oleh instansi terkait.";
  } else if (titles.includes("ditolak") || titles.includes("tidak layak")) {
    conclusion = "Status: laporan ditolak atau tidak layak menurut peninjau.";
  }
  lines.push(`Kesimpulan: ${conclusion}`);
  return { items, conclusion, text: lines.join("\n") };
}

async function main() {
  const argv = parseArgs();
  console.log("[check-laporgub] start", argv.debug ? "(debug)" : "");
  try {
    if (argv.ticket) {
      const rawTicket = argv.ticket;
      console.log(`[check-laporgub] manual ticket fetch ${rawTicket}`);
      const html = await fetchDetail(rawTicket);
      const items = parseTimeline(html);
      if (!items.length) {
        console.log(`[no-timeline] ${rawTicket}`);
      } else {
        console.log(`[parsed] ${rawTicket} items=${items.length}`);
        items.forEach((item, index) => {
          console.log(`[item ${index}]`, item);
        });
      }
      console.log("[check-laporgub] done");
      return;
    }

    const reports = await listSubmittedLaporanLayanan({ portalTarget: "laporgub" });
    console.log(`[check-laporgub] ${reports.length} submitted laporan_layanan to check`);
    for (const lap of reports) {
      const rawTicket = String(lap.nomor_ticket || "").trim();
      const normalizedTicket = normalizeTicketForFilter(rawTicket);
      if (!normalizedTicket) {
        console.log(`[skip] laporan id=${lap.id} no ticket`);
        continue;
      }
      if (argv.ticketFilter && argv.ticketFilter !== normalizedTicket) {
        debugLog(`[skip] ticket filter mismatch`, { requested: argv.ticketFilter, rawTicket, normalizedTicket });
        continue;
      }
      try {
        console.log(`[fetch] ${rawTicket}`);
        const html = await fetchDetail(rawTicket);
        const items = parseTimeline(html);
        if (!items.length) {
          console.log(`[no-timeline] ${rawTicket}`);
          continue;
        }
        // fingerprint latest item(s)
        const fpSource = JSON.stringify(items.map((it) => ({ t: it.title, d: it.date, u: it.user }))).slice(0, 3000);
        const fp = sha1(fpSource);
        const prev = await getLaporanLayanan(lap.id);
        if (prev && prev.last_status_check === fp) {
          console.log(`[no-change] ${rawTicket}`);
          // still update timestamp
          await updateLaporanLayananStatus(lap.id, lap.status, { last_status_check: prev.last_status_check });
          continue;
        }

        // Format message
        let formatted = null;
        if (hasLLM()) {
          const llmOut = await formatWithLLM(items);
          if (llmOut && (llmOut.items || llmOut.conclusion)) {
            // build simple text from llm json
            const lines = [];
            (llmOut.items || items).forEach((it) => {
              lines.push(`• *${it.title || "-"}*`);
              if (it.date) lines.push(`  Tanggal: ${it.date}`);
              if (it.responder) lines.push(`  Oleh: ${it.responder}`);
              if (it.description) lines.push(`  Isi: ${it.description}`);
              lines.push("");
            });
            if (llmOut.conclusion) lines.push(`Kesimpulan: ${llmOut.conclusion}`);
            formatted = { text: lines.join("\n"), raw: llmOut };
          }
        }
        if (!formatted) {
          const tpl = formatTemplate(items);
          formatted = { text: tpl.text, raw: { items: tpl.items, conclusion: tpl.conclusion } };
        }

        // Log and update DB
        console.log(`[update] laporan.id=${lap.id} ticket=${rawTicket} — new fingerprint ${fp}`);
        console.log("--- MESSAGE START ---");
        console.log(formatted.text);
        console.log("--- MESSAGE END ---");

        await updateLaporanLayananStatus(lap.id, lap.status, { last_status_check: fp });

        // TODO: integrate with WA broadcaster (call sender) — left to integration step.
      } catch (e) {
        console.warn(`[error] laporan id=${lap.id} : ${e?.message || e}`);
      }
    }
  } catch (e) {
    console.error("[check-laporgub] fatal", e);
    process.exitCode = 2;
  }
  console.log("[check-laporgub] done");
}

if (process.argv.includes("--run")) {
  main();
} else if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith("check-laporgub.js")) {
  main();
}

export default { main };
