#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { config } from "../src/config.js";
import { getCaptchaSolverProviders, solveCaptchaImage } from "../src/agent2/captcha.js";
import { solveCaptcha } from "../src/portal/laporgub.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.join(__dirname, "screenshots");
const STATE_FILE = path.join(__dirname, ".laporgub_test_state.json");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const args = process.argv.slice(2);
const stepArg = args.find((arg) => arg.startsWith("--step="));
const step = stepArg ? stepArg.split("=")[1] : null;
const allowed = new Set(["login", "captcha", "form"]);

if (!step || !allowed.has(step)) {
  console.error("Usage: node scripts/test-laporgub.js --step=login|captcha|form");
  process.exit(1);
}

const LAPORGUB_EMAIL = config.laporgub.email;
const LAPORGUB_PASSWORD = config.laporgub.password;

function requireCredentials() {
  if (!LAPORGUB_EMAIL || !LAPORGUB_PASSWORD) {
    console.error("ERROR: Set LAPORGUB_EMAIL and LAPORGUB_PASSWORD in .env");
    return false;
  }
  return true;
}

async function launchBrowser() {
  return chromium.launch({ headless: false });
}

async function loginTest() {
  if (!requireCredentials()) return;

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${config.laporgub.baseUrl}/login`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01_login_page.png") });
    console.log("Saved: 01_login_page.png");

    const emailInput = page.locator('input[name="phonemail"], #phonemail, input[type="tel"], input[type="email"]');
    await emailInput.waitFor({ state: "visible", timeout: 15000 });
    await emailInput.fill(LAPORGUB_EMAIL);

    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.waitFor({ state: "visible", timeout: 15000 });
    await passwordInput.fill(LAPORGUB_PASSWORD);

    const captchaImg = page.locator('img#img-captcha, img[src*="/captcha/"], #img-captcha-desktop');
    if ((await captchaImg.count()) > 0) {
      await captchaImg.first().waitFor({ state: "visible", timeout: 15000 });
      const captchaPath = path.join(SCREENSHOT_DIR, "02_login_captcha.png");
      await captchaImg.first().screenshot({ path: captchaPath });
      console.log(`Captcha detected. Screenshot saved: ${captchaPath}`);

      const captchaInput = page.locator('input[name="captcha"], #captcha');
      await captchaInput.waitFor({ state: "visible", timeout: 15000 });

      const captchaProviders = getCaptchaSolverProviders();
      if (captchaProviders.length) {
        console.log(
          `Captcha OCR enabled: ${captchaProviders.map((provider) => `${provider.name}:${provider.model}`).join(", ")}`,
        );
        try {
          const screenshot = await captchaImg.first().screenshot();
          const solved = await solveCaptchaImage(screenshot, "image/png");
          const text = (solved || "").replace(/\s+/g, "");
          if (text) {
            console.log(`Auto-solved captcha: ${text}`);
            await captchaInput.fill(text);
          } else {
            console.warn("Captcha OCR returned empty text. Please fill captcha manually.");
            console.log("Waiting 30 seconds for manual captcha entry...");
            await page.waitForTimeout(30000);
          }
        } catch (err) {
          console.error("Captcha auto-solve failed:", err.message);
          console.log("Waiting 30 seconds for manual captcha entry...");
          await page.waitForTimeout(30000);
        }
      } else {
        console.log("Please enter captcha text manually in the browser before continuing.");
        console.log("Waiting 30 seconds for manual captcha entry...");
        await page.waitForTimeout(30000);
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02_login_filled.png") });
    console.log("Saved: 02_login_filled.png");

    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03_after_login.png") });
    console.log("Saved: 03_after_login.png");

    if (page.url().includes("/login")) {
      console.error("Login result: FAILED");
      console.error(`Current URL: ${page.url()}`);
    } else {
      console.log("Login result: SUCCESS");
      console.log(`Current URL: ${page.url()}`);
      await context.storageState({ path: STATE_FILE });
      console.log(`Session state saved: ${STATE_FILE}`);
    }
  } finally {
    await browser.close();
  }
}

async function captchaTest() {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${config.laporgub.baseUrl}/login`, { waitUntil: "networkidle" });
    const captcha = page.locator('img#img-captcha, img[src*="/captcha/"]');
    await captcha.waitFor({ state: "visible", timeout: 15000 });
    const screenshotPath = path.join(SCREENSHOT_DIR, "captcha.png");
    await captcha.screenshot({ path: screenshotPath });
    console.log(`Captcha screenshot saved: ${screenshotPath}`);
    if (!getCaptchaSolverProviders().length) {
      console.log("No captcha OCR provider set; this script only captures the captcha image.");
    }
  } finally {
    await browser.close();
  }
}

async function formTest() {
  if (!fs.existsSync(STATE_FILE)) {
    console.error("ERROR: No session state found. Run --step=login first.");
    return;
  }

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ storageState: STATE_FILE });
    const page = await context.newPage();
    await page.goto(`${config.laporgub.baseUrl}/buat-aduan`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04_form_page.png") });
    console.log(`Saved: 04_form_page.png | URL: ${page.url()}`);

    if (page.url().includes("/login")) {
      console.error("ERROR: Session expired or login required. Run --step=login first.");
      return;
    }

    const testText = "Jalan berlubang di jalan arah ke Pekaja/Karangdadap";
    const quill = page.locator("#aduan-editor .ql-editor");
    await quill.waitFor({ state: "visible", timeout: 15000 });
    await quill.click();
    await quill.fill(testText);
    await page.evaluate((text) => {
      const el = document.getElementById("aduan");
      if (el) el.value = text;
    }, testText);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "05_text_filled.png") });
    console.log("Saved: 05_text_filled.png");

    await page.click(".select2-container--tailwind, .select2-selection, [aria-labelledby*=lokasi]");
    await page.waitForTimeout(500);
    const search = page.locator(".select2-search__field, input.select2-search__field");
    await search.waitFor({ state: "visible", timeout: 15000 });
    await search.fill("Sokaraja");
    await page.waitForSelector(".select2-results__option:not(.select2-results__option--disabled)", { timeout: 15000 });
    await page.locator(".select2-results__option").first().click();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "06_location_filled.png") });
    console.log("Saved: 06_location_filled.png");

    await page.selectOption("#jenis", "1");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "07_type_selected.png") });
    console.log("Saved: 07_type_selected.png");

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
          console.log("Already redirected to success page");
          return { success: true, ticketNumber: cur.split("/aduan-berhasil/").pop() };
        }
        if (cur.includes("/login")) {
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
        await page.waitForURL(`${config.laporgub.baseUrl}/aduan-berhasil/**`, { timeout: 15000 });
        const ticket = page.url().split("/aduan-berhasil/").pop();
        await page.close();
        await context.storageState({ path: STATE_FILE });
        console.log("Form test completed. Inspect screenshots to verify selectors.");
        return { success: true, ticketNumber: ticket || null };
      } catch {
        // Not redirected - check for SweetAlert or remain on form
        await page.waitForTimeout(1000);
        if (attempt === 2) {
          return { success: false, error: "Captcha failed after 3 attempts" };
        }
      }
    }

    // await page.close();
    return { success: false, error: "Failed to submit aduan" };
  } finally {
    // await browser.close();
  }
}

const run = async () => {
  if (step === "login") await loginTest();
  else if (step === "captcha") await captchaTest();
  else if (step === "form") await formTest();
};

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
