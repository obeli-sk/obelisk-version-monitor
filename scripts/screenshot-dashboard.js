// Captures a screenshot of the version-monitor dashboard for the README.
//
// Usage:
//   nix develop .#screenshots -c \
//     node scripts/screenshot-dashboard.js [url] [output.png]
//
// Defaults: http://localhost:9090/  ->  docs/dashboard.png

const fs = require('node:fs');
const path = require('node:path');

const { chromium } = require('playwright-core');

const url = process.argv[2] || 'http://localhost:9090/';
const output = process.argv[3] || path.join(__dirname, '..', 'docs', 'dashboard.png');

(async () => {
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await ctx.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // The dashboard renders its table client-side from /api/status; wait for a
  // populated table (or the "no executions yet" message) before capturing.
  await page.waitForSelector('#dashboard table tbody tr, #meta p', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  await page.screenshot({ path: output, fullPage: true });
  console.log(`Saved ${output}`);

  await browser.close();
})();
