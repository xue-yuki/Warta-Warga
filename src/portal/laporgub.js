import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { config, hasLaporGub, hasVision } from "../config.js";
import { solveCaptchaImage } from "../agent2/captcha.js";

const BASE_URL = config.laporgub.baseUrl;
const SESSION_PATH = config.laporgub.sessionPath;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export async function solveCaptcha(page) {
  const visibleSelector = "#img-captcha-desktop:visible, #img-captcha:visible";
  const plainSelector = "#img-captcha-desktop, #img-captcha";

  if ((await page.locator(visibleSelector).count()) === 0) {
    await page.waitForSelector(plainSelector, { state: "attached", timeout: 15000 });
  }

  if (!hasVision()) {
    throw new Error("Vision API not configured, cannot solve captcha automatically.");
  }
  // Simpler approach (like the Python script): screenshot current visible captcha and OCR it.
  // Retry a few times if the vision call fails or returns empty.
  for (let attempt = 0; attempt < 3; attempt++) {
    const img = page.locator(visibleSelector).first();
    await img.waitFor({ state: "visible", timeout: 15000 });

    // wait until the image element reports as loaded and has naturalWidth
    try {
      await page.waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          return !!(el && el.complete && el.naturalWidth && el.naturalWidth > 0);
        },
        visibleSelector,
        { timeout: 5000 },
      );
    } catch (e) {
      // ignore, continue to screenshot anyway
    }

    // small stabilization delay to avoid transient image swaps
    await page.waitForTimeout(1500);

    const screenshot = await img.screenshot();

    try {
      const text = await solveCaptchaImage(screenshot, "image/png");
      if (text && text.trim()) return text.replace(/\s+/g, "");
    } catch (err) {
      // ignore and retry
    }

    // short pause before next attempt
    await page.waitForTimeout(500);
  }

  throw new Error("Failed to solve captcha reliably after multiple attempts");
}

async function createContext(browser) {
  const storage = SESSION_PATH;
  ensureDir(storage);
  const contextOptions = {
    viewport: { width: 1440, height: 1200 },
  };
  if (fs.existsSync(storage)) {
    return await browser.newContext({ ...contextOptions, storageState: storage });
  }
  return await browser.newContext(contextOptions);
}

async function loginIfNeeded(context) {
  const storage = SESSION_PATH;
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });

  if (!page.url().includes("/login")) {
    await page.close();
    return true;
  }

  if (!hasLaporGub()) {
    await page.close();
    throw new Error("LAPORGUB_EMAIL and LAPORGUB_PASSWORD must be set in environment variables");
  }

  const emailInput = page.locator('input[name="phonemail"], #phonemail, input[type="tel"], input[type="email"]');
  await emailInput.waitFor({ state: "visible", timeout: 15000 });
  await emailInput.fill(config.laporgub.email);

  const passwordInput = page.locator('input[name="password"]');
  await passwordInput.waitFor({ state: "visible", timeout: 15000 });
  await passwordInput.fill(config.laporgub.password);

  const captchaImg = page.locator('#img-captcha, #img-captcha-desktop, img[src*="/captcha/"]');
  if ((await captchaImg.count()) > 0) {
    await captchaImg.first().waitFor({ state: "visible", timeout: 10000 });
    const captchaText = await solveCaptcha(page);
    const captchaInput = page.locator('input[name="captcha"], #captcha');
    await captchaInput.waitFor({ state: "visible", timeout: 10000 });
    await captchaInput.fill(captchaText);
  }

  await page.waitForTimeout(1000);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);
  await page.waitForLoadState("networkidle");

  if (page.url().includes("/login")) {
    await page.close();
    throw new Error("Login failed or captcha required");
  }

  await context.storageState({ path: storage });
  await page.close();
  return true;
}

function detailUrl(ticket) {
  const base = String(BASE_URL || "").replace(/\/+$|$/, "");
  return `${base}/detail/${encodeURIComponent(String(ticket || "").trim())}.html`;
}

export async function fetchLaporGubDetail(ticket) {
  if (!ticket) {
    throw new Error("Ticket ID is required to fetch LaporGub detail");
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await createContext(browser);
    await loginIfNeeded(context);
    const page = await context.newPage();
    const url = detailUrl(ticket);
    await page.goto(url, { waitUntil: "networkidle" });

    if (page.url().includes("/login")) {
      await page.close();
      throw new Error("Authenticated session could not access LaporGub detail page");
    }

    try {
      await page.waitForSelector(".timeline-content, .timeline-item, body", { timeout: 15000 });
    } catch {
      // proceed anyway if the page has no timeline entries or the selector is absent
    }

    const html = await page.content();
    await page.close();
    await context.storageState({ path: SESSION_PATH });
    return html;
  } finally {
    await browser.close();
  }
}

export async function submitLaporGub({ isiAduan, lokasiAduan, jenisAduan = "Public", lampiranPath = null }) {
  if (!hasLaporGub()) {
    throw new Error("LaporGub credentials are not configured");
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await createContext(browser);
    await loginIfNeeded(context);
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/buat-aduan`, { waitUntil: "networkidle" });

    if (page.url().includes("/login")) {
      await page.close();
      throw new Error("Session expired and login failed");
    }

    if (lampiranPath) {
      const input = page.locator("#hidden-input");
      await input.setInputFiles(lampiranPath);
      await page.waitForTimeout(500);
    }

    const quill = page.locator("#aduan-editor .ql-editor");
    await quill.waitFor({ state: "visible", timeout: 15000 });
    await quill.click();
    await quill.fill(isiAduan);
    await page.evaluate((text) => {
      const el = document.getElementById("aduan");
      if (el) el.value = text;
    }, isiAduan);

    await page.click(".select2-container--tailwind, .select2-selection, [aria-labelledby*=lokasi]");
    await page.waitForTimeout(500);
    const search = page.locator(".select2-search__field, input.select2-search__field");
    await search.waitFor({ state: "visible", timeout: 15000 });
    await search.fill(lokasiAduan);
    await page.waitForSelector(".select2-results__option:not(.select2-results__option--disabled)", { timeout: 15000 });
    await page.locator(".select2-results__option").first().click();

    const jenisValue = jenisAduan.toLowerCase() === "public" ? "1" : "0";
    await page.selectOption("#jenis", jenisValue);
    await page.locator("#btn-step1").click();
    await page.locator("#step2-content").waitFor({ state: "visible", timeout: 15000 });

    await page.locator("#form-step2").waitFor({ state: "visible", timeout: 10000 });
    await page.locator('#form-step2 button[type="submit"]').click();
    await page.locator("#step3-content").waitFor({ state: "visible", timeout: 15000 });

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.waitForSelector("#form-step3", { state: "visible", timeout: 20000 });
      } catch (err) {
        const cur = page.url();
        if (cur.includes("/aduan-berhasil")) {
          const ticket = cur.split("/aduan-berhasil/").pop();
          await page.close();
          await context.storageState({ path: SESSION_PATH });
          return { success: true, ticketNumber: ticket || null };
        }
        if (cur.includes("/login")) {
          await page.close();
          throw new Error("Session expired - login required");
        }
        throw err;
      }

      await page.waitForSelector("#img-captcha-desktop", { state: "visible", timeout: 15000 });
      const captchaText = await solveCaptcha(page);
      await page.evaluate((text) => {
        ["captcha", "captcha-desktop"].forEach((id) => {
          const el = document.getElementById(id);
          if (el) {
            el.value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
      }, captchaText);
      await page.locator("#btn-step3").click();

      try {
        await page.waitForURL(`${BASE_URL}/aduan-berhasil/**`, { timeout: 15000 });
        const ticket = page.url().split("/aduan-berhasil/").pop();
        await page.close();
        await context.storageState({ path: SESSION_PATH });
        return { success: true, ticketNumber: ticket || null };
      } catch {
        await page.waitForTimeout(1000);
        if (attempt === 2) {
          await page.close();
          return { success: false, error: "Captcha failed after 3 attempts" };
        }
      }
    }

    await page.close();
    return { success: false, error: "Failed to submit aduan" };
  } finally {
    await browser.close();
  }
}
