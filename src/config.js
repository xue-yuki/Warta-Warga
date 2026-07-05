import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p));

for (const envPath of [path.resolve(ROOT, ".env"), path.resolve(ROOT, "..", "web-warta-warga", "warta-warga-web", ".env"), path.resolve(ROOT, "..", "warta-warga-web", ".env")]) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

export const config = {
  // LLM (OpenAI-compatible). Default OpenRouter; bisa diarahkan ke DeepSeek langsung
  // (LLM_BASE_URL=https://api.deepseek.com) atau provider OpenAI-compatible lain.
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || "",
    baseUrl: process.env.LLM_BASE_URL || process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    fastModel: process.env.OPENROUTER_FAST_MODEL || "openai/gpt-4o-mini",
    deepModel: process.env.OPENROUTER_DEEP_MODEL || "anthropic/claude-3.5-sonnet",
    appUrl: process.env.OPENROUTER_APP_URL || "https://github.com/wartawarga",
    appName: process.env.OPENROUTER_APP_NAME || "Warta Warga",
  },

  embeddings: {
    provider: process.env.EMBEDDINGS_PROVIDER || "local",
    model: process.env.EMBEDDINGS_MODEL || "Xenova/all-MiniLM-L6-v2",
  },

  dbPath: abs(process.env.DB_PATH || "./data/warta.db"),

  laporgub: {
    baseUrl: process.env.LAPORGUB_BASE_URL || "https://laporgub.jatengprov.go.id",
    email: process.env.LAPORGUB_EMAIL || "",
    password: process.env.LAPORGUB_PASSWORD || "",
    sessionPath: abs(process.env.LAPORGUB_SESSION_PATH || "./.laporgub_session.json"),
    checkIntervalHours: Number(process.env.LAPORGUB_CHECK_INTERVAL_HOURS || 6),
  },

  aduankonten: {
    // Saklar alur percakapan (bukan checker berkala di bawah): default MATI — matikan intercept
    // otomatis "isAduanKontenIntent" & penawaran follow-up "mau saya laporkan ke aduankonten.id?"
    // di lapor-konten.js, supaya warga yang tanya "ini penipuan bukan ya?" langsung dapat jawaban
    // verifikasi (via cek_url di brain.js), bukan disodori form aduan yang tidak mereka minta.
    // Set ADUANKONTEN_CHAT_ENABLED=true untuk mengaktifkan lagi.
    chatEnabled: (process.env.ADUANKONTEN_CHAT_ENABLED ?? "false") === "true",
    baseUrl: process.env.ADUANKONTEN_BASE_URL || "https://aduankonten.id",
    sessionPath: abs(process.env.ADUANKONTEN_SESSION_PATH || "./.aduankonten_session.json"),
    userDataDir: abs(process.env.ADUANKONTEN_USER_DATA_DIR || "./.aduankonten_profile"),
    debugDir: process.env.ADUANKONTEN_DEBUG_DIR ? abs(process.env.ADUANKONTEN_DEBUG_DIR) : "",
    userAgent: process.env.ADUANKONTEN_USER_AGENT || "",
    pythonPath: process.env.ADUANKONTEN_PYTHON || process.env.PYTHON || "python",
    seleniumBaseScript: abs(process.env.ADUANKONTEN_SELENIUMBASE_SCRIPT || "./scripts/aduankonten_seleniumbase.py"),
    checkIntervalHours: Number(process.env.ADUANKONTEN_CHECK_INTERVAL_HOURS || 6),
    checkOnBoot: (process.env.ADUANKONTEN_CHECK_ON_BOOT ?? "false") === "true",
  },

  // Persistensi: bila SUPABASE_DB_URL diset → backend Postgres (Supabase, deploy); kosong → SQLite lokal.
  // Ambil connection string dari Supabase Dashboard → Settings → Database → Connection string (pooler).
  supabase: {
    dbUrl: process.env.SUPABASE_DB_URL || "",
  },

  // Agent 1 auto-scrape: pindai data/sources.json secara berkala.
  scrape: {
    enabled: (process.env.SCRAPE_AUTO ?? "true") !== "false", // default nyala
    onBoot: (process.env.SCRAPE_ON_BOOT ?? "false") === "true", // default mati agar bot start tidak scrape/spam
    intervalHours: Number(process.env.SCRAPE_INTERVAL_HOURS || 12),
    sourcesPath: abs(process.env.SCRAPE_SOURCES || "./data/sources.json"),
  },

  // Broadcast info bansos baru dari hasil scrape/on-demand default mati.
  // Ini mencegah seed/synthetic/fresh scrape langsung generate poster dan spam grup.
  newInfoBroadcast: {
    auto: (process.env.NEW_INFO_BROADCAST_AUTO ?? "false") === "true",
  },

  onDemandDiscovery: {
    enabled: (process.env.ON_DEMAND_DISCOVERY ?? "false") === "true",
  },

  // Auto-polling broadcast pending sengaja default mati. Gunakan tombol dashboard
  // untuk sebar manual agar laporan approved dari Supabase tidak memicu loop.
  pendingBroadcast: {
    autoPolling: (process.env.PENDING_BROADCAST_AUTO ?? "false") === "true",
    intervalMinutes: Number(process.env.PENDING_BROADCAST_INTERVAL_MINUTES || 5),
  },

  // Web search untuk on-demand discovery sumber daerah baru.
  // Default GRATIS tanpa key: DuckDuckGo. Provider lain: brightdata/google/searxng/serper/brave.
  search: {
    provider:
      process.env.SEARCH_PROVIDER ||
      (process.env.BRIGHTDATA_API_TOKEN || process.env.BRIGHTDATA_BROWSER_WSS
        ? "brightdata"
        : process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID
          ? "google"
          : process.env.SERPER_API_KEY
            ? "serper"
            : process.env.BRAVE_API_KEY
              ? "brave"
              : process.env.SEARXNG_URL
                ? "searxng"
                : "duckduckgo"),
    serperKey: process.env.SERPER_API_KEY || "",
    braveKey: process.env.BRAVE_API_KEY || "",
    searxngUrl: process.env.SEARXNG_URL || "",
    googleKey: process.env.GOOGLE_API_KEY || "",
    googleCx: process.env.GOOGLE_CSE_ID || "",
  },

  // Bright Data. Dua mode (pilih salah satu):
  //  - Browser mode  : Scraping Browser via Playwright (BRIGHTDATA_BROWSER_WSS). Browser remote
  //                    buka Google & render halaman JS sendiri. (yang dipakai sekarang)
  //  - REST mode      : SERP API + Web Unlocker via api.brightdata.com/request (token + 2 zone).
  brightdata: {
    token: process.env.BRIGHTDATA_API_TOKEN || "",
    serpZone: process.env.BRIGHTDATA_SERP_ZONE || "serp_api",
    unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE || "web_unlocker",
    browserWss: process.env.BRIGHTDATA_BROWSER_WSS || "",
  },

  // Vision (gambar→teks): model TEKS tetap DeepSeek; vision dipanggil terpisah saat ada gambar.
  // Default endpoint OpenAI-compatible Google Gemini. Set VISION_API_KEY untuk mengaktifkan.
  vision: {
    apiKey: process.env.VISION_API_KEY || process.env.VISION_API || "",
    baseUrl: process.env.VISION_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
    model: process.env.VISION_MODEL || "gemini-flash-lite-latest",
  },

  images: {
    apiKey: process.env.IMAGE_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || "",
    baseUrl: process.env.IMAGE_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: process.env.IMAGE_MODEL || "gpt-image-2",
  },

  wa: {
    authDir: abs(process.env.WA_AUTH_DIR || "./auth_state"),
    botJid: process.env.BOT_JID || "",
  },

  // Transport WhatsApp aktif: 'kirimi' (default, hosted gateway) atau 'baileys' (fallback,
  // koneksi langsung + scan QR). Lihat src/index.js untuk pencabangan startup-nya.
  waTransport: (process.env.WA_TRANSPORT || "kirimi").toLowerCase(),

  // kirimi.id: REST API untuk kirim pesan (send-message/broadcast-message) + webhook untuk
  // terima pesan masuk. user_code/secret didaftarkan lewat dashboard kirimi.id.
  kirimi: {
    baseUrl: process.env.KIRIMI_API_BASE_URL || "https://api.kirimi.id",
    userCode: process.env.USER_CODE || "",
    secretKey: process.env.KIRIMI_SECRET_KEY || "",
    deviceId: process.env.KIRIMI_DEVICE_ID || "",
    botNumber: (process.env.KIRIMI_BOT_NUMBER || "").replace(/\D/g, ""),
    webhookToken: process.env.KIRIMI_WEBHOOK_TOKEN || "",
    webhookPort: Number(process.env.KIRIMI_WEBHOOK_PORT || 3220),
    webhookDebug: (process.env.KIRIMI_WEBHOOK_DEBUG ?? "false") === "true",
  },

  // Origin publik dipakai untuk membangun URL media (poster) yang dikirim ke kirimi.id,
  // karena kirimi mengirim media lewat media_url, bukan upload buffer.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),

  defaultWilayahTag: process.env.DEFAULT_WILAYAH_TAG || "nasional",
};

export const hasLLM = () => Boolean(config.openrouter.apiKey);
export const hasKirimi = () => Boolean(config.kirimi.userCode && config.kirimi.secretKey && config.kirimi.deviceId);
export const hasVision = () => Boolean(config.vision.apiKey);
export const hasLaporGub = () => Boolean(config.laporgub.email && config.laporgub.password);
export const hasAduanKonten = () => Boolean(config.aduankonten.baseUrl);
export const hasSupabase = () => Boolean(config.supabase.dbUrl);
export const hasSearch = () => {
  const s = config.search;
  if (s.provider === "serper") return Boolean(s.serperKey);
  if (s.provider === "brave") return Boolean(s.braveKey);
  if (s.provider === "searxng") return Boolean(s.searxngUrl);
  if (s.provider === "google") return Boolean(s.googleKey && s.googleCx);
  if (s.provider === "brightdata") {
    const b = config.brightdata;
    return Boolean(b.browserWss || (b.token && b.serpZone));
  }
  return true; // duckduckgo: gratis, tanpa key
};

// Scraping Browser (Playwright) untuk render halaman JS + buka Google sendiri.
export const hasBrightDataBrowser = () => Boolean(config.brightdata.browserWss);
// Render halaman JS (cekbansos dll) saat scrape biasa gagal — via browser ATAU Web Unlocker REST.
export const hasBrightDataUnlocker = () => Boolean(config.brightdata.browserWss || (config.brightdata.token && config.brightdata.unlockerZone));
