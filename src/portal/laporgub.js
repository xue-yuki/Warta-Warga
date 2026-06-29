import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { config, hasLaporGub } from "../config.js";
import { solveCaptchaImage } from "../agent2/captcha.js";

const BASE_URL = config.laporgub.baseUrl;
const SESSION_PATH = config.laporgub.sessionPath;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export async function solveCaptcha(page, debugSavePath = null) {
  const selectors = ["img#img-captcha", "img[src*='/captcha/']", "#img-captcha-desktop", "#img-captcha"];

  for (let attempt = 0; attempt < 3; attempt++) {
    const targetSelector = await page.evaluate((candidateSelectors) => {
      for (const selector of candidateSelectors) {
        const elements = Array.from(document.querySelectorAll(selector));
        for (const element of elements) {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          if (rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0") {
            return selector;
          }
        }
      }
      return null;
    }, selectors);

    if (!targetSelector) {
      await page.waitForTimeout(1000);
      continue;
    }

    const img = page.locator(targetSelector).first();
    try {
      await img.scrollIntoViewIfNeeded();
    } catch {
      // continue with screenshot attempt
    }

    const box = await img.boundingBox().catch(() => null);
    let screenshot;
    if (box && box.width > 0 && box.height > 0) {
      screenshot = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    } else {
      screenshot = await page.screenshot();
    }

    try {
      const text = await solveCaptchaImage(screenshot, "image/png");
      if (text && text.trim()) {
        // Simpan screenshot captcha bila debug path disediakan
        if (debugSavePath) {
          try { fs.writeFileSync(debugSavePath, screenshot); } catch { /* abaikan */ }
          console.log(`[laporgub] captcha screenshot saved: ${debugSavePath}, ocr result: "${text.replace(/\s+/g, "")}"`);
        }
        return text.replace(/\s+/g, "");
      }
    } catch (err) {
      console.warn(`[laporgub] solveCaptchaImage attempt ${attempt + 1} failed: ${err.message}`);
      // retry if OCR fails
    }

    if (attempt < 2) {
      await page.waitForTimeout(1000);
    }
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

    // Buka halaman baru setelah loginIfNeeded selesai sepenuhnya
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/buat-aduan`, { waitUntil: "networkidle" });

    if (page.url().includes("/login")) {
      await page.close();
      throw new Error("Session expired and login failed");
    }

    if (lampiranPath) {
      // hidden-input adalah input file tersembunyi di balik area drag-drop.
      // setInputFiles langsung bekerja tanpa perlu klik trigger-nya.
      const input = page.locator("#hidden-input");
      await input.setInputFiles(lampiranPath);
      // Tunggu preview muncul di gallery (indikasi file berhasil di-attach)
      await page.waitForSelector("#gallery .hasImage, #gallery li:not(#empty)", { timeout: 5000 }).catch(() => {
        // Tidak fatal kalau preview tidak muncul — file tetap bisa ter-attach
      });
      await page.waitForTimeout(300);
    }

    // Tunggu Quill editor benar-benar diinisialisasi (bukan hanya DOM visible)
    // Quill init async — .ql-editor ada di DOM tapi belum siap menerima input
    const quill = page.locator("#aduan-editor .ql-editor");
    await quill.waitFor({ state: "visible", timeout: 30000 });
    // Pastikan Quill instance sudah ready (quillEditor variable diset oleh DOMContentLoaded)
    await page.waitForFunction(() => {
      return typeof window.quillEditor !== "undefined" && window.quillEditor !== null;
    }, { timeout: 15000 }).catch(() => {
      // Quill variable mungkin bernama lain — lanjut saja, sudah visible
    });
    await quill.click();
    // Isi via Quill API langsung (lebih reliable dari .fill pada contenteditable)
    await page.evaluate((text) => {
      if (window.quillEditor) {
        window.quillEditor.setText(text);
        // Trigger text-change agar hidden textarea #aduan ikut terupdate
        window.quillEditor.update();
      }
      // Sinkronkan hidden textarea secara eksplisit
      const el = document.getElementById("aduan");
      if (el) {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, isiAduan);
    // Verifikasi hidden textarea terisi
    const aduanValue = await page.evaluate(() => document.getElementById("aduan")?.value || "");
    if (!aduanValue || aduanValue.trim().length < 10) {
      // Fallback: fill langsung ke contenteditable
      await quill.fill(isiAduan);
      await page.evaluate((text) => {
        const el = document.getElementById("aduan");
        if (el) el.value = text;
      }, isiAduan);
    }

    await page.click(".select2-container--tailwind, .select2-selection, [aria-labelledby*=lokasi]");
    await page.waitForTimeout(500);
    const search = page.locator(".select2-search__field, input.select2-search__field");
    await search.waitFor({ state: "visible", timeout: 15000 });
    await search.fill(lokasiAduan);
    await page.waitForSelector(".select2-results__option:not(.select2-results__option--disabled)", { timeout: 15000 });
    await page.locator(".select2-results__option").first().click();

    const jenisValue = jenisAduan.toLowerCase() === "public" ? "1" : "0";
    await page.selectOption("#jenis", jenisValue);

    // Intercept response AJAX step-1 sebelum klik — tangkap error server sebelum timeout
    const step1ResponsePromise = page.waitForResponse(
      (r) => r.url().includes("/complaint/create-step-1") && r.request().method() === "POST",
      { timeout: 30000 }
    ).catch(() => null);

    await page.locator("#btn-step1").click();

    const step1Response = await step1ResponsePromise;
    if (step1Response) {
      const status = step1Response.status();
      if (status >= 400) {
        const body = await step1Response.text().catch(() => "");
        throw new Error(`Step 1 AJAX gagal (HTTP ${status}): ${body.slice(0, 200)}`);
      }
    }

    // Tunggu step2-content visible (class 'hidden' dihapus oleh nextStep() setelah AJAX sukses)
    try {
      await page.locator("#step2-content").waitFor({ state: "visible", timeout: 20000 });
    } catch {
      // Step 2 tidak muncul — cek apakah ada SweetAlert error dari server
      const swalText = await page.evaluate(() => {
        const el = document.querySelector(".swal2-html-container, .swal2-content, .sweet-alert p");
        return el ? el.textContent?.trim() : null;
      });
      if (swalText) throw new Error(`Step 1 gagal: ${swalText}`);
      // Cek validation error inline
      const inlineError = await page.evaluate(() => {
        const el = document.querySelector(".invalid-feedback:not([style*='display: none']), .is-invalid + .invalid-feedback");
        return el ? el.textContent?.trim() : null;
      });
      if (inlineError) throw new Error(`Validasi step 1 gagal: ${inlineError}`);
      throw new Error("Step 2 tidak muncul setelah submit step 1 — kemungkinan validasi server gagal");
    }

    // Intercept response AJAX step-2
    const step2ResponsePromise = page.waitForResponse(
      (r) => r.url().includes("/complaint/create-step-2") && r.request().method() === "POST",
      { timeout: 30000 }
    ).catch(() => null);

    await page.locator("#form-step2").waitFor({ state: "visible", timeout: 10000 });
    await page.locator('#form-step2 button[type="submit"]').click();

    const step2Response = await step2ResponsePromise;
    if (step2Response && step2Response.status() >= 400) {
      const body = await step2Response.text().catch(() => "");
      throw new Error(`Step 2 AJAX gagal (HTTP ${step2Response.status()}): ${body.slice(0, 200)}`);
    }

    try {
      await page.locator("#step3-content").waitFor({ state: "visible", timeout: 20000 });
    } catch {
      const swalText = await page.evaluate(() => {
        const el = document.querySelector(".swal2-html-container, .swal2-content, .sweet-alert p");
        return el ? el.textContent?.trim() : null;
      });
      if (swalText) throw new Error(`Step 2 gagal: ${swalText}`);
      throw new Error("Step 3 tidak muncul setelah submit step 2");
    }

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

      // DEBUG: simpan screenshot captcha ke disk untuk verifikasi hasil OCR
      const debugDir = process.env.LAPORGUB_DEBUG_DIR || "";
      let captchaScreenshotPath = null;
      if (debugDir) {
        const ts = Date.now();
        captchaScreenshotPath = path.join(debugDir, `captcha_attempt${attempt}_${ts}.png`);
        fs.mkdirSync(debugDir, { recursive: true });
      }

      const captchaText = await solveCaptcha(page, captchaScreenshotPath);
      console.log(`[laporgub] attempt ${attempt + 1}: captcha solved = "${captchaText}"`);

      // Set nilai captcha ke KEDUA field via jQuery val() agar form submit handler bisa membacanya.
      await page.evaluate((text) => {
        if (typeof $ !== "undefined") {
          $("#captcha").val(text).trigger("input").trigger("change");
          $("#captcha-desktop").val(text).trigger("input").trigger("change");
        }
        // Fallback native setter untuk memastikan .value property juga terupdate
        ["captcha", "captcha-desktop"].forEach((id) => {
          const el = document.getElementById(id);
          if (!el) return;
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (nativeSetter) nativeSetter.call(el, text);
          else el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }, captchaText);

      // Verifikasi nilai benar-benar terset di field
      const verifyDesktop = await page.evaluate(() => document.getElementById("captcha-desktop")?.value || "");
      const verifyMobile = await page.evaluate(() => document.getElementById("captcha")?.value || "");
      console.log(`[laporgub] field values after set — desktop="${verifyDesktop}" mobile="${verifyMobile}"`);

      // Beri waktu agar nilai captcha benar-benar terset sebelum btn-step3 diklik
      await page.waitForTimeout(300);
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
