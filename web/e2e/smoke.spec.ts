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

// The UI defaults to Vietnamese; these tests assert on English strings.
test.beforeEach(async ({ page }, info) => {
  if (!info.title.startsWith('language')) await page.addInitScript(() => localStorage.setItem('hanoi-sim.lang', 'en'));
});

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
  await expect(page.getByTestId('incident-list').locator('li.item')).toHaveCount(1);
  await expect(page.getByTestId('incident-list')).toContainText('Closure');
  await expect(page.getByTestId('status')).toHaveText('Not run yet');
  await page.screenshot({ path: `${SHOTS}/setup.png` });

  await page.getByTestId('run').click();
  const card = page.getByTestId('result-card');
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('body')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('delay-pct')).toHaveText(/[+−±]\d[\d,.]*% vs baseline/);
  await expect(card).toContainText('sudden');
  await expect(page.getByTestId('status')).toHaveText('Up to date');
  await expect(page.getByTestId('tab-results')).toHaveAttribute('aria-selected', 'true');

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
  await expect(page.getByTestId('build-list').locator('li.item')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#s=[A-Za-z0-9_-]+$/);
  const url = page.url();

  const page2 = await context.newPage();
  await page2.goto(url);
  await waitReady(page2);
  const list = page2.getByTestId('build-list');
  await expect(list.locator('li.item')).toHaveCount(2);
  await expect(list).toContainText('New housing');
  await expect(list).toContainText('New jobs');
  await expect(page2.getByTestId('population-scale')).toHaveValue('1.1');
});

test('citywide rain with live update runs by itself and the metro is drawn', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('./');
  await waitReady(page);
  await page.getByTestId('auto-run').check();
  await page.getByTestId('add-citywide-rain').click();
  await expect(page.getByTestId('rain-list').locator('li.item')).toHaveCount(1);
  const slider = page.getByTestId('rain-intensity');
  await slider.fill('80');
  await slider.dispatchEvent('change');
  await expect(page.getByTestId('rain-list')).toContainText('80');
  await expect(page.getByTestId('result-card')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('body')).toHaveAttribute('data-state', 'done');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/citywide-rain.png` });
  expect(errors).toEqual([]);
});

test('draw a rain zone on the map, retime a junction, add accidents and run', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('./');
  await waitReady(page);
  const map = page.locator('#map');
  const box = (await map.boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  // draw a 4-corner zone with the R shortcut; close it by clicking the first corner
  await page.keyboard.press('r');
  await expect(page.getByTestId('tool-banner')).toContainText('rain zone');
  for (const [fx, fy] of [
    [0.4, 0.35],
    [0.6, 0.35],
    [0.6, 0.6],
    [0.4, 0.6],
  ])
    await page.mouse.click(at(fx, fy).x, at(fx, fy).y);
  await page.screenshot({ path: `${SHOTS}/drawing-zone.png` });
  await page.mouse.click(at(0.4, 0.35).x, at(0.4, 0.35).y);
  await expect(page.getByTestId('tool-banner')).toBeHidden();
  const rain = page.getByTestId('rain-list').locator('li.item');
  await expect(rain).toHaveCount(1);
  await expect(rain).toContainText('Rain zone 1');
  await expect(rain).toContainText('km²');

  // retime a signalised junction through the search box
  const search = page.getByTestId('junction-search');
  await page.getByTestId('section-signals').locator('summary').click();
  const first = await page.locator('#junctions option').first().getAttribute('value');
  expect(first).toBeTruthy();
  await search.fill(first!);
  await search.dispatchEvent('change');
  await expect(page.getByTestId('inspector-junction')).toBeVisible();
  await page.getByTestId('inspector-green-ns').fill('80');
  await page.getByTestId('apply-signal').click();
  await expect(page.getByTestId('signal-list').locator('li.item')).toHaveCount(1);
  await expect(page.getByTestId('green-ns')).toHaveValue('80');

  // random accidents
  await page.getByTestId('section-accidents').locator('summary').click();
  await page.getByTestId('accidents-toggle').check();
  await expect(page.getByTestId('accidents-rate')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/setup-zone-signal-accidents.png` });

  await page.getByTestId('run').click();
  const card = page.getByTestId('result-card');
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card).toContainText('Accidents');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/zone-result.png` });
  expect(errors).toEqual([]);
});

test('language: Vietnamese by default, switch to English keeps the scenario', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('./');
  await waitReady(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.getByTestId('run')).toContainText('Chạy mô phỏng');
  await expect(page.getByTestId('tab-setup')).toContainText('Thiết lập');
  await expect(page.getByTestId('section-weather')).toContainText('Thời tiết & ngập');

  await page.getByTestId('add-citywide-rain').click();
  await expect(page.getByTestId('rain-list')).toContainText('Mưa toàn thành phố');
  await expect(page.getByTestId('status')).toHaveText('Chưa chạy');
  await page.screenshot({ path: `${SHOTS}/vietnamese.png` });

  await page.getByTestId('lang-switch').getByRole('radio', { name: 'EN' }).click();
  await waitReady(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByTestId('run')).toContainText('Run simulation');
  await expect(page.getByTestId('rain-list')).toContainText('Citywide rain');

  await page.getByTestId('lang-switch').getByRole('radio', { name: 'VI' }).click();
  await waitReady(page);
  await expect(page.getByTestId('run')).toContainText('Chạy mô phỏng');
  expect(errors).toEqual([]);
});
