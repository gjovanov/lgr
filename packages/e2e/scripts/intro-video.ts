/**
 * LGR Intro Video — Playwright Recording Script
 *
 * Standalone script (not a test) that records a walkthrough of the LGR app.
 * Produces a .webm video in ./videos/ ready for subtitle burning with ffmpeg.
 *
 * Usage:
 *   BASE_URL=https://lgrai.app bunx playwright test --config=playwright.config.mjs scripts/intro-video.ts
 *   # Or run directly:
 *   cd /home/gjovanov/lgr/packages/e2e
 *   npx tsx scripts/intro-video.ts
 */

import { chromium, type Page } from "@playwright/test";

const BASE_URL = process.env.BASE_URL || "https://lgrai.app";
const SCENE_PAUSE = 3000; // ms between scenes
const SHORT_PAUSE = 1500;

async function showCaption(page: Page, text: string) {
  await page.evaluate((t) => {
    const existing = document.getElementById("lgr-caption");
    if (existing) existing.remove();

    const el = document.createElement("div");
    el.id = "lgr-caption";
    el.textContent = t;
    Object.assign(el.style, {
      position: "fixed",
      bottom: "40px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "rgba(0,0,0,0.8)",
      color: "#fff",
      padding: "16px 32px",
      borderRadius: "8px",
      fontSize: "22px",
      fontFamily: "sans-serif",
      zIndex: "99999",
      textAlign: "center",
      maxWidth: "80%",
    });
    document.body.appendChild(el);
  }, text);
}

async function hideCaption(page: Page) {
  await page.evaluate(() => {
    document.getElementById("lgr-caption")?.remove();
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: "./videos",
      size: { width: 1920, height: 1080 },
    },
  });
  const page = await context.newPage();

  try {
    // Scene 1: Landing page
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await showCaption(page, "Welcome to LGR — the ERP that doesn't make you cry... much.");
    await page.waitForTimeout(SCENE_PAUSE);
    await hideCaption(page);

    // Scene 2: Login
    await showCaption(page, "Logging in. Password is test123. Very secure. Fort Knox called — they're jealous.");
    await page.waitForTimeout(SHORT_PAUSE);

    await page.getByRole("textbox", { name: /organization/i }).fill("acme-corp");
    await page.waitForTimeout(500);
    await page.getByRole("textbox", { name: /username/i }).fill("admin");
    await page.waitForTimeout(500);
    await page.getByRole("textbox", { name: /password/i }).fill("test123");
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Wait for dashboard to load
    await page.waitForURL("**/dashboard**", { timeout: 15000 });
    await page.waitForTimeout(SHORT_PAUSE);
    await hideCaption(page);

    // Scene 3: Dashboard
    await showCaption(page, "The Dashboard. Four KPI cards. Show me the money!");
    await page.waitForTimeout(SCENE_PAUSE);
    await hideCaption(page);

    // Scene 4: App Hub
    await page.click('text=App Hub', { timeout: 5000 }).catch(() => {
      // Try navigation drawer
      return page.locator('.v-navigation-drawer').locator('text=App Hub').click();
    });
    await page.waitForTimeout(SHORT_PAUSE);
    await showCaption(page, "App Hub. Eight apps. One subscription. Zero regrets.");
    await page.waitForTimeout(SCENE_PAUSE);
    await hideCaption(page);

    // Scene 5: Accounting
    await page.click('text=Accounting', { timeout: 5000 }).catch(() => {
      return page.goto(`${BASE_URL}/accounting/`, { waitUntil: "networkidle" });
    });
    await page.waitForTimeout(SHORT_PAUSE);
    await showCaption(page, "Accounting. Where dreams of profit meet the reality of expenses.");
    await page.waitForTimeout(SCENE_PAUSE);
    await hideCaption(page);

    // Scene 6: Invoicing
    await page.goto(`${BASE_URL}/invoicing/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(SHORT_PAUSE);
    await showCaption(page, "Invoicing. Because asking for money shouldn't feel awkward.");
    await page.waitForTimeout(SCENE_PAUSE);
    await hideCaption(page);

    // Scene 7: Warehouse
    await page.goto(`${BASE_URL}/warehouse/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(SHORT_PAUSE);
    await showCaption(page, "Warehouse. We know where your stuff is. Unlike your keys.");
    await page.waitForTimeout(SCENE_PAUSE);
    await hideCaption(page);

    // Scene 8: Settings
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(SHORT_PAUSE);
    await page.click('text=Settings', { timeout: 5000 }).catch(() => {
      return page.locator('.v-navigation-drawer').locator('text=Settings').click();
    });
    await page.waitForTimeout(SHORT_PAUSE);
    await showCaption(page, "Settings. Customize everything. Even the things you shouldn't.");
    await page.waitForTimeout(SCENE_PAUSE);
    await hideCaption(page);

    // Scene 9: Outro
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await showCaption(page, "LGR. Ledger. Your business, organized.");
    await page.waitForTimeout(SCENE_PAUSE);
    await hideCaption(page);
    await page.waitForTimeout(1000);

  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  console.log("Recording saved to ./videos/");
  console.log("Post-production:");
  console.log('  ffmpeg -i videos/*.webm -vf "subtitles=scripts/intro-subtitles.srt:force_style=\'FontSize=24\'" -c:v libx264 -crf 18 lgr-intro.mp4');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
