import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SHOTS = 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/tiles\.openfreemap|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function waitReady(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
}

test('loads, runs a preset scenario and shows a comparison', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('./');
  await waitReady(page);
  await expect(page.locator('#map canvas').first()).toBeVisible();

  // baseline view first
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/baseline.png` });

  const select = page.getByTestId('preset-select');
  await expect(select.locator('option[value="closure-lang.json"]')).toHaveCount(1);
  await select.selectOption('closure-lang.json');
  await expect(page.getByTestId('event-list').locator('li.event')).toHaveCount(1);
  await expect(page.getByTestId('event-list')).toContainText('Closure');

  await page.getByTestId('run').click();
  const card = page.getByTestId('result-card');
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('body')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('delay-pct')).toHaveText(/[+−±]\d[\d,.]*% vs baseline/);
  await expect(card).toContainText('sudden');

  // map canvases exist (maplibre + deck overlay)
  expect(await page.locator('#map canvas').count()).toBeGreaterThanOrEqual(2);

  // zoom out a bit around the closure so the colours are visible
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/closure-result.png` });
  expect(errors).toEqual([]);
});

test('storm preset shows flooding and rain', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('./');
  await waitReady(page);
  await page.getByTestId('preset-select').selectOption('storm-2025-09-30.json');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('result-card')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('result-card')).toContainText('Flooded road links');
  // jump to 10:00 when flooding is widespread
  await page.locator('.time-slider').evaluate((el: HTMLInputElement) => {
    el.value = String(10 * 3600_000);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/storm-result.png` });
  expect(errors).toEqual([]);
});

test('scenario survives a URL round trip', async ({ page, context }) => {
  await page.goto('./');
  await waitReady(page);
  await page.getByTestId('preset-select').selectOption('growth-housing-jobs.json');
  await expect(page.getByTestId('event-list').locator('li.event')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#s=[A-Za-z0-9_-]+$/);
  const url = page.url();

  const page2 = await context.newPage();
  await page2.goto(url);
  await waitReady(page2);
  const list = page2.getByTestId('event-list');
  await expect(list.locator('li.event')).toHaveCount(2);
  await expect(list).toContainText('New housing');
  await expect(list).toContainText('New jobs');
  await expect(page2.locator('.override-box')).toContainText('population.scale = 1.1');
});
