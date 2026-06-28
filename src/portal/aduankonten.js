import ghostCursor from "ghost-cursor";
import { chromium } from "patchright";
import * as cheerio from "cheerio";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { solveCloudflareChallenge } from "../agent2/cloudflare-captcha-solver.js";

const BASE_URL = String(config.aduankonten?.baseUrl || "https://aduankonten.id").replace(/\/+$/, "");
const SESSION_PATH = config.aduankonten?.sessionPath;
const DEBUG_DIR = config.aduankonten?.debugDir || "";
const USER_DATA_DIR = config.aduankonten?.userDataDir || "";
const { path: ghostPath } = ghostCursor;
const humanMouseState = new WeakMap();

export const ADUANKONTEN_CATEGORIES = Object.freeze({
  pornografi: { id: "1", label: "Pornografi" },
  perjudian: { id: "2", label: "Perjudian" },
  pencemaran: { id: "3", label: "Fitnah/Pencemaran Nama Baik" },
  penipuan: { id: "4", label: "Penipuan" },
  sara: { id: "5", label: "SARA" },
  kekerasan: { id: "6", label: "Kekerasan/Kekerasan Pada Anak" },
  produk_khusus: { id: "7", label: "Perdagangan Produk dengan aturan khusus" },
  terorisme: { id: "8", label: "Terorisme/Radikalisme" },
  separatisme: { id: "9", label: "Separatisme/Organisasi Berbahaya" },
  hki: { id: "10", label: "Hak Kekayaan Intelektual" },
  keamanan_informasi: { id: "11", label: "Pelanggaran Keamanan Informasi" },
  rekomendasi_sektor: { id: "12", label: "Konten Negatif yang Direkomendasikan Instansi Sektor" },
  sosial_budaya: { id: "13", label: "Konten yang Melanggar Nilai Sosial dan Budaya" },
  hoaks: { id: "14", label: "Berita Bohong/HOAKS" },
  pemerasan: { id: "15", label: "Pemerasan" },
});

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function tempPngPath(prefix = "aduankonten") {
  const dir = path.join(os.tmpdir(), "warta-warga-aduankonten");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomBetween(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getMouseState(page) {
  let state = humanMouseState.get(page);
  if (!state) {
    state = {
      x: randomBetween(60, 180),
      y: randomBetween(60, 180),
    };
    humanMouseState.set(page, state);
  }
  return state;
}

function pointInBox(box) {
  const padX = Math.min(12, Math.max(2, box.width * 0.2));
  const padY = Math.min(10, Math.max(2, box.height * 0.25));
  return {
    x: clamp(box.x + randomBetween(padX, Math.max(padX, box.width - padX)), box.x + 1, box.x + box.width - 1),
    y: clamp(box.y + randomBetween(padY, Math.max(padY, box.height - padY)), box.y + 1, box.y + box.height - 1),
  };
}

async function pointFromLocator(locator) {
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(async () => {
    await locator.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" })).catch(() => {});
  });
  const box = await locator.boundingBox();
  if (!box) throw new Error("Elemen AduanKonten tidak terlihat untuk interaksi cursor.");
  return pointInBox(box);
}

async function humanPause(min = 80, max = 220) {
  await sleep(randomBetween(min, max));
}

async function humanMove(page, destination, options = {}) {
  const state = getMouseState(page);
  const target = {
    x: Math.round(destination.x),
    y: Math.round(destination.y),
  };
  const route = ghostPath(
    { x: state.x, y: state.y },
    target,
    { moveSpeed: options.moveSpeed || randomBetween(9, 18) },
  );

  for (const point of route) {
    await page.mouse.move(point.x, point.y);
    if (Math.random() < 0.15) await sleep(randomBetween(1, 6));
  }

  state.x = target.x;
  state.y = target.y;
}

async function humanClick(page, target, options = {}) {
  const point = typeof target?.x === "number" && typeof target?.y === "number" ? target : await pointFromLocator(target);
  const button = options.button || "left";
  const clickCount = options.clickCount || 1;

  await humanMove(page, point, options);
  await humanPause(70, 180);
  await page.mouse.down({ button, clickCount });
  await humanPause(35, 120);
  await page.mouse.up({ button, clickCount });
  await humanPause(120, 280);
}

async function humanFill(page, locator, value) {
  const text = String(value);
  await locator.waitFor({ state: "visible", timeout: 30000 });
  await humanClick(page, locator);
  await humanPause(60, 160);

  await locator.evaluate((el) => {
    el.focus();
    if (typeof el.select === "function") el.select();
  }).catch(() => {});

  const focused = await locator.evaluate((el) => document.activeElement === el).catch(() => false);
  if (focused) {
    await page.keyboard.type(text, { delay: randomBetween(25, 75) });
  } else {
    await locator.fill(text);
  }

  const currentValue = await locator.evaluate((el) => el.value ?? el.textContent ?? "").catch(() => "");
  if (String(currentValue) !== text) {
    await locator.fill(text);
  }

  await locator.dispatchEvent("input").catch(() => {});
  await locator.dispatchEvent("change").catch(() => {});
  await humanPause(120, 240);
}

function contextOptions() {
  const options = {
    viewport: { width: 1440, height: 1200 },
    locale: "id-ID",
    timezoneId: "Asia/Jakarta",
  };
  if (config.aduankonten?.userAgent) {
    options.userAgent = config.aduankonten.userAgent;
  }
  return options;
}

function browserLaunchOptions({ headless = true } = {}) {
  const options = { headless };
  if (config.aduankonten?.browserChannel) {
    options.channel = config.aduankonten.browserChannel;
  }
  return options;
}

async function createContext(browser) {
  const options = contextOptions();
  if (SESSION_PATH) {
    ensureDir(SESSION_PATH);
    if (fs.existsSync(SESSION_PATH)) {
      return await browser.newContext({ ...options, storageState: SESSION_PATH });
    }
  }
  return await browser.newContext(options);
}

async function launchBrowserSession({ headless = true } = {}) {
  if (USER_DATA_DIR) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      ...contextOptions(),
      ...browserLaunchOptions({ headless }),
    });
    return {
      context,
      persistent: true,
      close: async () => context.close(),
    };
  }

  const browser = await chromium.launch(browserLaunchOptions({ headless }));
  const context = await createContext(browser);
  return {
    browser,
    context,
    persistent: false,
    close: async () => browser.close(),
  };
}

async function persistContext(context) {
  if (SESSION_PATH) {
    ensureDir(SESSION_PATH);
    await context.storageState({ path: SESSION_PATH });
  }
}

async function hasCloudflareClearance(context) {
  const cookies = await context.cookies(BASE_URL).catch(() => []);
  return cookies.some((cookie) => cookie.name === "cf_clearance");
}

function normalizeUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function absoluteUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, BASE_URL).toString();
  } catch {
    return href;
  }
}

function cleanText(value) {
  if (!value) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function supportOutcomeFromHref(href, message = "Konten sudah pernah dilaporkan.") {
  const supportUrl = absoluteUrl(href);
  const id = supportUrl?.match(/\/auth\/redirect\/([^/?#]+)/)?.[1] || null;
  return {
    kind: "duplicate",
    existingSubmissionId: id,
    supportUrl,
    message: cleanText(message),
  };
}

function supportOutcomeFromHtml(html, message = "Konten sudah pernah dilaporkan.") {
  if (!html) return null;
  const $ = cheerio.load(html);
  const href = $('a[href*="/auth/redirect/"]').first().attr("href");
  if (!href) return null;
  return supportOutcomeFromHref(href, message);
}

function outcomeFromLivewireJson(payload) {
  const components = Array.isArray(payload?.components) ? payload.components : [];
  for (const component of components) {
    const effects = component?.effects || {};
    if (typeof effects.redirect === "string" && /\/submission\/submit-form\b/i.test(effects.redirect)) {
      return { kind: "submit_form", redirectUrl: absoluteUrl(effects.redirect) };
    }

    const htmlOutcome = supportOutcomeFromHtml(effects.html);
    if (htmlOutcome) return htmlOutcome;

    const dispatches = Array.isArray(effects.dispatches) ? effects.dispatches : [];
    for (const dispatch of dispatches) {
      const name = String(dispatch?.name || "");
      const params = dispatch?.params || {};
      if (name === "dispatch-search-site-modal") {
        const id = params.id || params.submissionId || null;
        if (id) {
          return supportOutcomeFromHref(
            `/auth/redirect/${id}`,
            "Konten sudah pernah dilaporkan. Portal menawarkan dukungan laporan dengan akun Google.",
          );
        }
      }
    }
  }
  return null;
}

async function saveDebugSnapshot(page, debugDir, stage) {
  if (!debugDir) return null;
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeStage = String(stage || "aduankonten").replace(/[^a-z0-9_-]+/gi, "-");
    const base = path.join(debugDir, `${stamp}-${safeStage}`);
    const htmlPath = `${base}.html`;
    const screenshotPath = `${base}.png`;
    fs.writeFileSync(htmlPath, await page.content(), "utf8");
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    return { htmlPath, screenshotPath };
  } catch {
    return null;
  }
}

function formatDebugSnapshot(snapshot) {
  if (!snapshot) return "";
  return ` Debug artifacts: ${snapshot.htmlPath}, ${snapshot.screenshotPath}`;
}

function debugLog(debugDir, message) {
  if (debugDir) console.log(`[aduankonten] ${message}`);
}

async function attachDebugToError(page, debugDir, stage, err) {
  if (err?.message?.includes("Debug artifacts:")) return err;
  const snapshot = await saveDebugSnapshot(page, debugDir, stage);
  if (snapshot && err?.message) {
    const wrapped = new Error(`${err.message}${formatDebugSnapshot(snapshot)}`);
    wrapped.cause = err;
    return wrapped;
  }
  return err;
}

function uniqueItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function detectSearchOutcome(page, timeoutMs = 90000, { trigger = null, debugDir = "" } = {}) {
  const livewireOutcomes = [];
  const livewireNotes = [];
  const livewireErrors = [];

  const onResponse = (response) => {
    if (!response.url().includes("/livewire/update")) return;
    void (async () => {
      const status = response.status();
      const text = await response.text().catch(() => "");
      if (status >= 400) {
        const note = `HTTP ${status}: ${cleanText(text).slice(0, 220)}`;
        livewireNotes.push(note);
        if (/Just a moment|Checking your browser|Cloudflare/i.test(text || "")) {
          const err = new Error(
            `AduanKonten Livewire diblokir Cloudflare (${note}). Tunggu challenge selesai lalu retry search.`,
          );
          err.code = "ADUANKONTEN_CLOUDFLARE_LIVEWIRE";
          livewireErrors.push(err);
        }
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        livewireNotes.push(`Non-JSON Livewire response: ${cleanText(text).slice(0, 220)}`);
        return;
      }
      const outcome = outcomeFromLivewireJson(payload);
      if (outcome) {
        livewireOutcomes.push(outcome);
      } else {
        livewireNotes.push(`Livewire response without known outcome: ${cleanText(text).slice(0, 220)}`);
      }
    })();
  };

  page.on("response", onResponse);
  const deadline = Date.now() + timeoutMs;
  try {
    if (trigger) await trigger();

    while (Date.now() < deadline) {
      const livewireError = livewireErrors.shift();
      if (livewireError) {
        throw livewireError;
      }

      const livewireOutcome = livewireOutcomes.shift();
      if (livewireOutcome) {
        if (livewireOutcome.kind === "submit_form" && livewireOutcome.redirectUrl && !/\/submission\/submit-form\b/i.test(page.url())) {
          await page.goto(livewireOutcome.redirectUrl, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState("networkidle").catch(() => {});
        }
        return livewireOutcome.kind === "submit_form" ? { kind: "submit_form" } : livewireOutcome;
      }

      const current = page.url();
      if (/\/submission\/submit-form\b/i.test(current)) {
        return { kind: "submit_form" };
      }

      const support = page.locator('a[href*="/auth/redirect/"]').first();
      if ((await support.count().catch(() => 0)) > 0) {
        const href = await support.getAttribute("href").catch(() => null);
        const text = await page.locator("#searchSiteExistModal").textContent().catch(() => "");
        return supportOutcomeFromHref(href, text || "Konten sudah pernah dilaporkan.");
      }

      const body = await page.locator("body").textContent().catch(() => "");
      if (/Just a moment|Checking your browser|Cloudflare/i.test(body || "") && !(await page.locator("#search_url").count().catch(() => 0))) {
        throw new Error("AduanKonten masih menampilkan proteksi Cloudflare; coba ulangi setelah session browser lolos challenge.");
      }

      await page.waitForTimeout(500);
    }

    const note = livewireNotes.length ? ` Last Livewire note: ${livewireNotes.at(-1)}` : "";
    const snapshot = await saveDebugSnapshot(page, debugDir, "search-timeout");
    throw new Error(`Timeout menunggu hasil pencarian URL di AduanKonten.${note}${formatDebugSnapshot(snapshot)}`);
  } finally {
    page.off("response", onResponse);
  }
}

async function isSearchButtonInteractable(page) {
  const disabled = await page.locator("#btn-search-submit").isDisabled().catch(() => true);
  if (disabled) return false;
  return await page.evaluate(() => {
    const button = document.querySelector("#btn-search-submit");
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return !!top && (top === button || button.contains(top) || top.closest?.("#btn-search-submit"));
  }).catch(() => false);
}

async function fillSearchUrl(page, normalizedUrl, { debugDir = "", challengeWaitMs = 30000 } = {}) {
  await waitForSearchForm(page, { debugDir, challengeWaitMs });
  const input = page.locator("#search_url");
  await humanFill(page, input, normalizedUrl);
  await input.dispatchEvent("input").catch(() => {});
  await input.dispatchEvent("keyup").catch(() => {});
  await page.waitForTimeout(250);

  const button = page.locator("#btn-search-submit");
  const disabled = await button.isDisabled().catch(() => false);
  const errorVisible = await page.locator("#urlError").isVisible().catch(() => false);
  if (disabled || errorVisible) {
    const errorText = await page.locator("#urlError").textContent().catch(() => "");
    throw new Error(`AduanKonten menolak format URL "${normalizedUrl}". ${cleanText(errorText) || "Tombol submit nonaktif."}`);
  }
}

async function recoverFromLivewireCloudflare(page, { debugDir = "", challengeWaitMs = 30000 } = {}) {
  await page.waitForTimeout(5000);

  try {
      if (await solveCloudflareChallenge(page)) {
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle").catch(() => {});
        await waitForSearchForm(page, { debugDir, challengeWaitMs });
        return;
      }
  } catch(solveErr) {
      const snapshot = await saveDebugSnapshot(page, debugDir, "livewire-cloudflare");
      throw new Error(
        `Cloudflare challenge setelah request Livewire gagal diselesaikan oleh solver: ${solveErr.message}. Jalankan dengan --headed --debug, selesaikan verifikasi di browser, lalu ulangi.${formatDebugSnapshot(snapshot)}`,
      );
  }


  const snapshot = await saveDebugSnapshot(page, debugDir, "livewire-cloudflare");
  throw new Error(
    `Cloudflare challenge setelah request Livewire belum menghasilkan cf_clearance. Jalankan dengan --headed --debug, selesaikan verifikasi di browser, lalu ulangi.${formatDebugSnapshot(snapshot)}`,
  );
}

async function runSearchFlow(page, normalizedUrl, { debugDir = "", challengeWaitMs = 30000 } = {}) {
  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await fillSearchUrl(page, normalizedUrl, { debugDir, challengeWaitMs });
    await persistContext(page.context()).catch(() => {});

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await recoverFromLivewireCloudflare(page, { debugDir, challengeWaitMs });
        await fillSearchUrl(page, normalizedUrl, { debugDir, challengeWaitMs });
      }

      try {
        return await detectSearchOutcome(page, 90000, {
          debugDir,
          trigger: async () => {
            await humanClick(page, page.locator("#btn-search-submit"));
          },
        });
      } catch (err) {
        if (err?.code === "ADUANKONTEN_CLOUDFLARE_LIVEWIRE" && attempt < 2) {
          continue;
        }
        if (err?.code === "ADUANKONTEN_CLOUDFLARE_LIVEWIRE") {
          const snapshot = await saveDebugSnapshot(page, debugDir, "livewire-cloudflare");
          err.message =
            "AduanKonten Livewire masih diblokir Cloudflare setelah retry. Jalankan dengan --headed --debug, selesaikan verifikasi di browser, lalu ulangi." +
            formatDebugSnapshot(snapshot);
        }
        throw err;
      }
    }

    throw new Error("AduanKonten search tidak menghasilkan outcome setelah retry.");
  } catch (err) {
    throw await attachDebugToError(page, debugDir, "search-error", err);
  }
}

async function waitForSearchForm(page, { debugDir = "", challengeWaitMs = 30000 } = {}) {
    const deadline = Date.now() + Math.max(90000, challengeWaitMs + 5000);
    let reloadedAfterClearance = false;
    let reloadedAfterSolve = false;
    let solverAttempts = 0;
    while (Date.now() < deadline) {
        const inputVisible = await page.locator("#search_url").isVisible().catch(() => false);
        const buttonReady = inputVisible && (await isSearchButtonInteractable(page));
        if (inputVisible && buttonReady) {
            console.log("[AduanKonten] Search form is ready.");
            return;
        }

        const hasClearance = await hasCloudflareClearance(page.context());
        if (hasClearance && !reloadedAfterClearance) {
            console.log("[AduanKonten] Has clearance, persisting session and reloading page once.");
            await persistContext(page.context()).catch(() => {});
            await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
            await page.waitForLoadState("networkidle").catch(() => {});
            reloadedAfterClearance = true;
            continue;
        }

        const body = await page.locator("body").textContent().catch(() => "");
        if (/Tunggu sebentar|Verifikasi keamanan|Just a moment|Checking your browser|Cloudflare/i.test(body || "")) {
            try {
                console.log("[AduanKonten] Cloudflare challenge detected. Invoking solver.");
                solverAttempts += 1;
                if (solverAttempts > 2) {
                    const snapshot = await saveDebugSnapshot(page, debugDir, "home-cloudflare-loop");
                    throw new Error(`Cloudflare challenge berulang setelah solver sukses.${formatDebugSnapshot(snapshot)}`);
                }
                if (await solveCloudflareChallenge(page)) {
                    console.log("[AduanKonten] Solver reported success. Persisting session.");
                    await persistContext(page.context()).catch(() => {});
                    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
                    const solvedInputVisible = await page.locator("#search_url").isVisible().catch(() => false);
                    const solvedButtonReady = solvedInputVisible && (await isSearchButtonInteractable(page));
                    if (solvedInputVisible && solvedButtonReady) {
                        console.log("[AduanKonten] Search form is ready after solver.");
                        return;
                    }

                    if (!reloadedAfterSolve) {
                        console.log("[AduanKonten] Reloading once after solver to use persisted clearance.");
                        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
                        await page.waitForLoadState("networkidle").catch(() => {});
                        reloadedAfterSolve = true;
                        reloadedAfterClearance = true;
                    }
                    continue;
                }
            } catch (solveErr) {
                const snapshot = await saveDebugSnapshot(page, debugDir, "home-cloudflare");
                throw new Error(
                    `AduanKonten menampilkan Cloudflare challenge sebelum form search. Solver gagal: ${solveErr.message}.${formatDebugSnapshot(snapshot)}`,
                );
            }
        }
        await page.waitForTimeout(1000);
    }
    const snapshot = await saveDebugSnapshot(page, debugDir, "search-form-timeout");
    throw new Error(`Timeout menunggu form pencarian AduanKonten (#search_url).${formatDebugSnapshot(snapshot)}`);
}

export async function warmupAduanKontenSession({ headless = false, debugDir = DEBUG_DIR, waitMs = 300000 } = {}) {
  const session = await launchBrowserSession({ headless });
  try {
    const { context } = session;
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await waitForSearchForm(page, { debugDir, challengeWaitMs: waitMs });
    await persistContext(context);

    const cookies = await context.cookies(BASE_URL).catch(() => []);
    const clearance = cookies.find((cookie) => cookie.name === "cf_clearance");
    const result = {
      success: true,
      baseUrl: BASE_URL,
      sessionPath: SESSION_PATH || null,
      userDataDir: USER_DATA_DIR || null,
      persistentProfile: session.persistent,
      hasCloudflareClearance: Boolean(clearance),
      clearanceExpires: clearance?.expires || null,
    };
    await page.close();
    return result;
  } finally {
    await session.close();
  }
}

async function waitForPreview(page) {
  await page.locator("#category_id").waitFor({ state: "visible", timeout: 60000 });
  await page.waitForSelector("#webpreview_id, input[name='title_preview'], input[name='image_preview']", {
    state: "attached",
    timeout: 120000,
  });
  await page.waitForFunction(
    () => {
      const webPreviewId = document.querySelector("#webpreview_id")?.value;
      const titlePreview = document.querySelector('input[name="title_preview"]')?.value;
      const imagePreview = document.querySelector('input[name="image_preview"]')?.value;
      return Boolean(webPreviewId || titlePreview || imagePreview);
    },
    undefined,
    { timeout: 120000 },
  );
}

async function capturePreviewAttachment(page) {
  const previewImage = page.locator(".form-preview img, img.img-blur").first();
  if ((await previewImage.count().catch(() => 0)) > 0) {
    try {
      await previewImage.waitFor({ state: "visible", timeout: 10000 });
      const out = tempPngPath("preview");
      await previewImage.screenshot({ path: out });
      return out;
    } catch {
      // Preview image can be present but hidden/blurred. Use page screenshot instead.
    }
  }

  const out = tempPngPath("page");
  await page.screenshot({ path: out, fullPage: false });
  return out;
}

async function waitForSubmitButton(page) {
  const button = page.locator("#btn-submission");
  await button.waitFor({ state: "visible", timeout: 60000 });
  await page.waitForFunction(
    () => {
      const button = document.querySelector("#btn-submission");
      if (!button || button.disabled) return false;
      const rect = button.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const style = window.getComputedStyle(button);
      return style.visibility !== "hidden" && style.display !== "none";
    },
    undefined,
    { timeout: 60000 },
  );
  return button;
}

function submitResponseInfo(response) {
  if (!response) return null;
  return {
    status: response.status(),
    location: response.headers()?.location || "",
    url: response.url(),
  };
}

async function extractTicket(page) {
  await page.waitForSelector("#kodeLaporan, #submissionSuccessModal, body", { timeout: 60000 }).catch(() => {});
  const textTicket = await page.locator("#kodeLaporan").textContent().catch(() => "");
  const direct = String(textTicket || "").trim();
  if (direct) return direct;

  const html = await page.content().catch(() => "");
  const scriptMatch = html.match(/submissionNumber\.innerText\s*=\s*['"]([^'"]+)['"]/i);
  if (scriptMatch?.[1]) return scriptMatch[1].trim();

  const body = await page.locator("body").textContent().catch(() => "");
  const bodyMatch = String(body || "").match(/\b[A-Z0-9]{6,12}\b/);
  return bodyMatch?.[0] || null;
}

export function parseAduanKontenStatus(html, ticket = null) {
  const $ = cheerio.load(html || "");
  $("script, style, noscript, svg").remove();

  const items = [];
  $(".timeline-content, .timeline-item, .timeline, .history, .riwayat, .tracking, .card, .alert").each((_, el) => {
    const $el = $(el);
    const text = cleanText($el.text());
    if (!text || text.length < 8) return;
    if (/Aduan Konten|Kementerian Komunikasi|Privacy|Standard Pelayanan|Lacak Aduan/i.test(text) && text.length > 600) return;
    const title =
      cleanText($el.find(".timeline-title, .card-title, h1, h2, h3, h4, h5, strong").first().text()) ||
      text.slice(0, 80);
    const date = cleanText($el.find(".timeline-date, time, .date, .tanggal").first().text());
    const status = cleanText($el.find(".status, .badge, .label").first().text());
    items.push({ title, date, status, description: text });
  });

  $("tr").each((_, tr) => {
    const cells = $(tr)
      .find("th,td")
      .map((__, cell) => cleanText($(cell).text()))
      .get()
      .filter(Boolean);
    if (cells.length >= 2) {
      items.push({ title: cells[0], date: "", status: "", description: cells.slice(1).join(" | ") });
    }
  });

  const bodyText = cleanText($("body").text());
  const statusMatch = bodyText.match(/\b(diterima|diproses|proses|verifikasi|selesai|ditolak|diblokir|tidak\s+valid|valid)\b/i);
  const ticketMatch = bodyText.match(/\b[A-Z0-9]{6,12}\b/);

  const filtered = uniqueItems(items)
    .filter((item) => {
      const text = `${item.title} ${item.description}`;
      if (!text.trim()) return false;
      if (ticket && text.includes(ticket) && text.length < 20) return false;
      return true;
    })
    .slice(0, 20);

  return {
    ticket: ticket || ticketMatch?.[0] || null,
    statusText: statusMatch?.[0] || null,
    items: filtered,
    text: bodyText.slice(0, 4000),
  };
}

export async function fetchAduanKontenStatus(ticket, { headless = true } = {}) {
  const rawTicket = String(ticket || "").trim();
  if (!rawTicket) throw new Error("Kode laporan AduanKonten wajib diisi");

  const session = await launchBrowserSession({ headless });
  try {
    const { context } = session;
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForSelector('form[action*="/submission/check"], #submission_number, body', { timeout: 90000 });

    const hasForm = (await page.locator('form[action*="/submission/check"]').count().catch(() => 0)) > 0;
    if (hasForm) {
      const input = page.locator("#submission_number");
      if (!(await input.isVisible().catch(() => false)) && (await page.locator("#search_tiket").count().catch(() => 0)) > 0) {
        await humanClick(page, page.locator("#search_tiket")).catch(() => {});
        await input.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      }

      if (await input.isVisible().catch(() => false)) {
        await humanFill(page, input, rawTicket);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null),
          humanClick(page, page.locator("#button_submission_number")),
        ]);
      } else {
        await page.evaluate((value) => {
          const form = document.querySelector('form[action*="/submission/check"]');
          const el = document.querySelector("#submission_number");
          if (el) el.value = value;
          if (form) form.submit();
        }, rawTicket);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
      await page.waitForLoadState("networkidle").catch(() => {});
    } else {
      throw new Error("Form lacak AduanKonten tidak ditemukan");
    }

    const html = await page.content();
    const parsed = parseAduanKontenStatus(html, rawTicket);
    await persistContext(context);
    await page.close();
    return { html, ...parsed };
  } finally {
    await session.close();
  }
}

export async function probeAduanKontenSearch({ url, headless = true, debugDir = DEBUG_DIR, challengeWaitMs = 30000 }) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) throw new Error("URL konten wajib diisi");

  const session = await launchBrowserSession({ headless });
  try {
    const { context } = session;
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const outcome = await runSearchFlow(page, normalizedUrl, { debugDir, challengeWaitMs });
    await persistContext(context);
    await page.close();
    return { success: true, url: normalizedUrl, ...outcome };
  } finally {
    await session.close();
  }
}

export async function submitAduanKonten({
  url,
  categoryId,
  reason,
  attachmentPath = null,
  headless = true,
  debugDir = DEBUG_DIR,
  challengeWaitMs = 30000,
}) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) throw new Error("URL konten wajib diisi");
  if (!categoryId) throw new Error("Kategori AduanKonten wajib diisi");
  if (!reason || String(reason).trim().length < 20) {
    throw new Error("Alasan AduanKonten minimal 20 karakter");
  }

  const session = await launchBrowserSession({ headless });
  try {
    const { context } = session;
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    const outcome = await runSearchFlow(page, normalizedUrl, { debugDir, challengeWaitMs });
    if (outcome.kind === "duplicate") {
      await persistContext(context);
      await page.close();
      return {
        success: true,
        duplicate: true,
        existingSubmissionId: outcome.existingSubmissionId,
        supportUrl: outcome.supportUrl,
        message: outcome.message,
      };
    }

    debugLog(debugDir, "menunggu form submit siap");
    await waitForPreview(page);
    debugLog(debugDir, "memilih kategori");
    await humanClick(page, page.locator("#category_id")).catch(() => {});
    await page.selectOption("#category_id", String(categoryId));
    await humanPause(100, 240);
    debugLog(debugDir, "mengisi kandungan konten");
    await humanFill(page, page.locator("#reason"), String(reason).trim());

    debugLog(debugDir, "menyiapkan lampiran");
    const uploadPath = attachmentPath || (await capturePreviewAttachment(page));
    await page.locator("#multiplefileupload").setInputFiles(uploadPath);
    debugLog(debugDir, `lampiran terpasang: ${uploadPath}`);

    debugLog(debugDir, "mengklik submit");
    const submitButton = await waitForSubmitButton(page);
    const submitResponsePromise = page.waitForResponse(
      (response) => response.request().method() === "POST" && /\/submission\/submit\b/i.test(response.url()),
      { timeout: 90000 },
    ).catch(() => null);
    await humanClick(page, submitButton);
    const submitResponse = await submitResponsePromise;
    const responseInfo = submitResponseInfo(submitResponse);
    if (responseInfo) {
      debugLog(
        debugDir,
        `response submit: HTTP ${responseInfo.status}${responseInfo.location ? ` -> ${responseInfo.location}` : ""}`,
      );
      if (responseInfo.status >= 400) {
        throw new Error(`AduanKonten submit gagal. Response POST /submission/submit: HTTP ${responseInfo.status}`);
      }
      if (responseInfo.status >= 300 && responseInfo.status < 400 && !/\/page\/success\b/i.test(responseInfo.location)) {
        throw new Error(
          `AduanKonten submit redirect tidak menuju halaman sukses. HTTP ${responseInfo.status}, Location: ${responseInfo.location || "(kosong)"}`,
        );
      }
    }

    debugLog(debugDir, "menunggu halaman sukses");
    try {
      await page.waitForURL(/\/page\/success\b/i, { timeout: 90000 });
    } catch {
      const body = await page.locator("body").textContent().catch(() => "");
      if (!/Laporan Diterima|Kode Laporan/i.test(body || "")) {
        const responseNote = responseInfo
          ? ` Response submit: HTTP ${responseInfo.status}${responseInfo.location ? `, Location: ${responseInfo.location}` : ""}.`
          : " Response submit tidak tertangkap.";
        throw new Error(`AduanKonten tidak menampilkan halaman sukses. URL terakhir: ${page.url()}.${responseNote}`);
      }
    }

    const ticketNumber = await extractTicket(page);
    if (!ticketNumber) {
      throw new Error(`AduanKonten menampilkan halaman sukses tetapi kode laporan tidak ditemukan. URL terakhir: ${page.url()}`);
    }
    await persistContext(context);
    await page.close();
    return { success: true, duplicate: false, ticketNumber, url: normalizedUrl };
  } finally {
    await session.close();
  }
}
