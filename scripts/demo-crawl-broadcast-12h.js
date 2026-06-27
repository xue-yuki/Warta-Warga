// Demo runner: crawl/ingest bansos data, broadcast it with poster images, then repeat
// every 12 hours by default.
//
// Default behavior is safe for demos:
// - uses an isolated SQLite DB: ./data/_demo_crawl_broadcast.db
// - sends to the console, not WhatsApp
// - uses the real image generator when IMAGE_API_KEY/OPENAI_API_KEY is set
//
// Run:
//   npm run demo:crawl-broadcast
//
// Useful options:
//   DEMO_ONCE=1 npm run demo:crawl-broadcast
//   DEMO_INTERVAL_HOURS=12 npm run demo:crawl-broadcast
//   DEMO_CRAWL_MODE=live npm run demo:crawl-broadcast
//   DEMO_USER=62812xxxx npm run demo:crawl-broadcast
//   DEMO_TARGETS=62812xxxx@s.whatsapp.net DEMO_TARGET_WILAYAH=nasional npm run demo:crawl-broadcast
//   DEMO_SEND_WA=true DEMO_USER=62812xxxx npm run demo:crawl-broadcast
//   DEMO_IMAGE_MODE=mock npm run demo:crawl-broadcast

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEMO_DB_PATH = process.env.DEMO_DB_PATH || './data/_demo_crawl_broadcast.db';
const INTERVAL_HOURS = Number(process.env.DEMO_INTERVAL_HOURS || process.env.SCRAPE_INTERVAL_HOURS || 12);
const RUN_ONCE = (process.env.DEMO_ONCE ?? 'false') === 'true';
const IMAGE_MODE = process.env.DEMO_IMAGE_MODE || 'real';
const SEND_WA = (process.env.DEMO_SEND_WA ?? 'false') === 'true';

// Set env before importing project modules; config.js reads env at import time.
process.env.SUPABASE_DB_URL = '';
process.env.DB_PATH = DEMO_DB_PATH;
process.env.SCRAPE_AUTO = 'false';
process.env.SCRAPE_ON_BOOT = 'false';
process.env.SCRAPE_INTERVAL_HOURS = String(INTERVAL_HOURS);
process.env.BROADCAST_MIN_MS = process.env.BROADCAST_MIN_MS || '200';
process.env.BROADCAST_MAX_MS = process.env.BROADCAST_MAX_MS || '500';
process.env.EMBEDDINGS_PROVIDER = process.env.EMBEDDINGS_PROVIDER || 'hashing';

const line = (ch = '-') => console.log(ch.repeat(72));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listPosterFiles() {
  const dir = path.join(ROOT, 'data', 'posters');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.png'))
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).size > 1024;
      } catch {
        return false;
      }
    })
    .sort();
}

const posterFiles = listPosterFiles();

function normalizeTargetJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.endsWith('@g.us') || raw.endsWith('@s.whatsapp.net')) return raw;

  const phone = raw.replace(/[^\d]/g, '');
  if (!phone) return raw;
  return `${phone}@s.whatsapp.net`;
}

function installImageMock() {
  if (IMAGE_MODE === 'real') return;
  const firstPoster = posterFiles[0];
  if (!firstPoster) {
    console.warn('[demo] No usable PNG found in data/posters; broadcasts will be text-only unless image generation succeeds.');
    return;
  }

  const realFetch = globalThis.fetch;
  const b64 = fs.readFileSync(firstPoster).toString('base64');
  process.env.IMAGE_API_KEY = process.env.IMAGE_API_KEY || 'demo-mock-image-key';
  console.warn('[demo] DEMO_IMAGE_MODE=mock uses cached poster bytes and is only for plumbing tests, not visual correctness.');

  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes('/images/generations')) {
      return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, options);
  };
}

installImageMock();

const { initDb, upsertGrup, countInfoBansos } = await import('../src/db/index.js');
const { hasLLM, config } = await import('../src/config.js');
const { initWhitelistCache } = await import('../src/agent1/fetch.js');
const { scrapeAllSources } = await import('../src/agent1/scheduler.js');
const { storeStructured } = await import('../src/agent1/index.js');
const { setBroadcaster, broadcastNewInfos } = await import('../src/agent1/broadcast.js');

function resetDemoDb() {
  if ((process.env.DEMO_KEEP ?? 'false') === 'true') return;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(DEMO_DB_PATH + suffix);
    } catch {
      // File may not exist on the first run.
    }
  }
}

function parseTargets() {
  const userTargets = [
    process.env.DEMO_USER,
    process.env.DEMO_USERS,
  ]
    .filter(Boolean)
    .flatMap((x) => x.split(','));
  const rawTargets = [
    ...userTargets,
    ...(process.env.DEMO_TARGETS || '').split(','),
  ]
    .map((x) => normalizeTargetJid(x))
    .filter(Boolean);

  if (!rawTargets.length) {
    return [
      {
        idGrup: 'DEMO_BANYUMAS@g.us',
        daerah: 'Kab. Banyumas',
        wilayahTag: 'kabupaten:banyumas',
        provinsiTag: 'provinsi:jawa_tengah',
      },
      {
        idGrup: 'DEMO_BOGOR@g.us',
        daerah: 'Kab. Bogor',
        wilayahTag: 'kabupaten:bogor',
        provinsiTag: 'provinsi:jawa_barat',
      },
    ];
  }

  return rawTargets.map((jid, i) => ({
    idGrup: jid,
    daerah: process.env.DEMO_TARGET_DAERAH || (jid.endsWith('@s.whatsapp.net') ? `Demo User ${i + 1}` : `Demo Target ${i + 1}`),
    wilayahTag: process.env.DEMO_TARGET_WILAYAH || 'nasional',
    provinsiTag: process.env.DEMO_TARGET_PROVINSI || null,
  }));
}

async function seedTargets() {
  const targets = parseTargets();
  for (const target of targets) await upsertGrup(target);

  console.log(`[demo] Registered ${targets.length} broadcast target(s):`);
  for (const target of targets) {
    console.log(`  - ${target.idGrup} | ${target.daerah} | ${target.wilayahTag}`);
  }
}

function installConsoleBroadcaster() {
  let sent = 0;
  setBroadcaster(async (jid, text, imagePath = null) => {
    sent += 1;
    const attachedImage = imagePath && fs.existsSync(imagePath) ? imagePath : null;

    line('.');
    console.log(`[demo] BROADCAST #${sent} -> ${jid}`);
    console.log(`[demo] image: ${attachedImage || '(none)'}`);
    line('.');
    console.log(text);
    console.log('');
  });
}

async function installWhatsAppBroadcaster() {
  if (!process.env.DEMO_USER && !process.env.DEMO_USERS && !process.env.DEMO_TARGETS) {
    throw new Error('DEMO_SEND_WA=true requires DEMO_USER, DEMO_USERS, or DEMO_TARGETS. Example: DEMO_USER=62812xxxx');
  }

  const [
    pino,
    qrcode,
    {
      default: makeWASocket,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      jidNormalizedUser,
    },
  ] = await Promise.all([
    import('pino'),
    import('qrcode-terminal'),
    import('@whiskeysockets/baileys'),
  ]);

  const { state, saveCreds } = await useMultiFileAuthState(config.wa.authDir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino.default({ level: 'silent' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for WhatsApp connection.')), 120_000);
    sock.ev.on('connection.update', (update) => {
      if (update.qr) {
        console.log('\nScan this QR in WhatsApp -> Linked devices:\n');
        qrcode.default.generate(update.qr, { small: true });
      }
      if (update.connection === 'open') {
        clearTimeout(timeout);
        console.log(`[demo] WhatsApp connected as ${jidNormalizedUser(sock.user?.id)}`);
        resolve();
      }
      if (update.connection === 'close') {
        clearTimeout(timeout);
        reject(new Error('WhatsApp connection closed before it became ready.'));
      }
    });
  });

  setBroadcaster(async (jid, text, imagePath = null) => {
    const attachedImage = imagePath && fs.existsSync(imagePath) ? imagePath : null;
    if (attachedImage) {
      await sock.sendMessage(jid, { image: { url: attachedImage }, caption: text });
    } else {
      await sock.sendMessage(jid, { text });
    }
    console.log(`[demo] WA sent -> ${jid} | image=${attachedImage || '(none)'}`);
  });
}

async function syntheticCrawlCycle(reason) {
  const syntheticFile = path.join(ROOT, 'data', 'synthetic', 'info_bansos.json');
  const items = JSON.parse(fs.readFileSync(syntheticFile, 'utf8'));
  const records = [];

  console.log(`[demo] Synthetic crawl (${reason}): ${items.length} prepared item(s).`);
  for (const item of items) {
    const result = await storeStructured(item);
    if (result.ok && result.record) records.push(result.record);
    else console.warn(`[demo] skip ${item.program || item.sumber_url}: ${result.error}`);
  }

  const broadcast = await broadcastNewInfos(records);
  return { total: items.length, ok: records.length, skip: items.length - records.length, sent: broadcast.sent };
}

async function liveCrawlCycle(reason) {
  await initWhitelistCache();
  const result = await scrapeAllSources({ reason });
  return { ...result, sent: null };
}

async function runCycle(cycleNo) {
  const mode = process.env.DEMO_CRAWL_MODE || (hasLLM() ? 'live' : 'synthetic');
  const reason = cycleNo === 1 ? 'demo-startup' : 'demo-12h';
  const started = Date.now();

  line();
  console.log(`[demo] Cycle ${cycleNo} started | mode=${mode} | interval=${INTERVAL_HOURS}h`);

  const result = mode === 'live' ? await liveCrawlCycle(reason) : await syntheticCrawlCycle(reason);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`[demo] Cycle ${cycleNo} done in ${seconds}s.`);
  console.log(`[demo] scanned=${result.total} stored=${result.ok} skipped=${result.skip} kb=${await countInfoBansos()}`);
  if (result.sent !== null) console.log(`[demo] sent=${result.sent}`);
  line();
}

async function main() {
  resetDemoDb();
  await initDb();
  await seedTargets();
  if (SEND_WA) await installWhatsAppBroadcaster();
  else installConsoleBroadcaster();

  console.log('');
  line();
  console.log('[demo] Warta Warga crawl -> broadcast scheduler');
  console.log(`[demo] DB: ${DEMO_DB_PATH}`);
  console.log(`[demo] LLM: ${hasLLM() ? 'available' : 'not set'} | model: ${config.openrouter.fastModel}`);
  console.log(`[demo] Image mode: ${IMAGE_MODE}${IMAGE_MODE === 'mock' ? ` (${posterFiles.length} cached poster(s))` : ''}`);
  console.log(`[demo] Sender: ${SEND_WA ? 'WhatsApp' : 'console'}`);
  console.log(`[demo] Next cycles repeat every ${INTERVAL_HOURS} hour(s).`);
  line();

  let cycleNo = 1;
  await runCycle(cycleNo);

  if (RUN_ONCE) {
    console.log('[demo] DEMO_ONCE=true, exiting after first cycle.');
    return;
  }

  while (true) {
    await delay(Math.max(1, INTERVAL_HOURS) * 60 * 60 * 1000);
    cycleNo += 1;
    await runCycle(cycleNo).catch((err) => {
      console.error(`[demo] Cycle ${cycleNo} failed:`, err?.message || err);
    });
  }
}

process.on('SIGINT', () => {
  console.log('\n[demo] Stopped.');
  process.exit(0);
});

main().catch((err) => {
  console.error('[demo] Fatal:', err);
  process.exit(1);
});
