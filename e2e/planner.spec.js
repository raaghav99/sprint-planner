import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = fs.readFileSync(new URL('../test/fixtures/nov26-sheet.tsv', import.meta.url), 'utf8');

/** Wipe the shared room from inside the page, so the Origin header is the allowed localhost:8080. */
async function resetRoom(page) {
  await page.goto('/');
  await page.evaluate(() => new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:8787/ws/playwright');
    ws.onopen = () => ws.send(JSON.stringify({ type: 'clear' }));
    ws.onmessage = () => { ws.close(); resolve(); };
    ws.onerror = () => reject(new Error('could not reach worker'));
  }));
  await page.reload();
  await expect(page.locator('#sync-status')).toContainText('Saved');
}

const dd = (page, key) => page.locator(`dd[data-k="${key}"]`);

async function setSprint(page, start = '2026-11-02', end = '2026-11-13') {
  await page.fill('#startDate', start);
  await page.fill('#endDate', end);
}
async function addPerson(page, name) {
  await page.fill('#member-name', name);
  await page.getByRole('button', { name: 'Add person' }).click();
}

test.beforeEach(async ({ page }) => { await resetRoom(page); });

test('calculates capacity from dates, people, fixed points and buffer', async ({ page }) => {
  await setSprint(page);
  await addPerson(page, 'Asha');
  await addPerson(page, 'Ben');
  await page.fill('#fixedPoints', '4');
  await page.fill('#bufferPct', '10');
  await expect(dd(page, 'workingDays')).toHaveText('10');
  await expect(dd(page, 'personDays')).toHaveText('20');
  await expect(dd(page, 'gross')).toHaveText('20');
  await expect(page.locator('#net')).toHaveText('14.4');
  await expect(page.locator('#date-summary')).toContainText('12 calendar days, 10 working');
});

test('sprint can be set by number of days instead of end date', async ({ page }) => {
  await page.fill('#startDate', '2026-11-02');
  await page.getByLabel('Number of days', { exact: true }).check();
  await expect(page.locator('#field-end')).toBeHidden();
  await page.fill('#numDays', '14');
  await expect(page.locator('#date-summary')).toContainText('Sun 15 Nov 2026');
  await expect(dd(page, 'workingDays')).toHaveText('10');
});

test('weekend days and holidays change working days', async ({ page }) => {
  await setSprint(page);
  await page.fill('#holiday-input', '2026-11-09');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dd(page, 'workingDays')).toHaveText('9');
  await page.getByRole('button', { name: /Remove holiday/ }).click();
  await expect(dd(page, 'workingDays')).toHaveText('10');
  await page.locator('#weekend-days label', { hasText: 'Sun' }).click(); // Sunday now works
  await expect(dd(page, 'workingDays')).toHaveText('11');
});

test('clicking a grid cell cycles working, off, half day and updates capacity', async ({ page }) => {
  await setSprint(page, '2026-11-02', '2026-11-06');
  await addPerson(page, 'Asha');
  const cell = page.getByRole('button', { name: /Asha, Tue 3 Nov/ });
  await expect(cell).toHaveAttribute('aria-label', /working/);
  await cell.click();
  await expect(cell).toHaveAttribute('aria-label', /off/);
  await expect(dd(page, 'personDays')).toHaveText('4');
  await cell.click();
  await expect(cell).toHaveAttribute('aria-label', /half day/);
  await expect(dd(page, 'personDays')).toHaveText('4.5');
  await cell.click();
  await expect(dd(page, 'personDays')).toHaveText('5');
});

test('grid cells work from the keyboard and keep focus', async ({ page }) => {
  await setSprint(page, '2026-11-02', '2026-11-06');
  await addPerson(page, 'Asha');
  const cell = page.getByRole('button', { name: /Asha, Wed 4 Nov/ });
  await cell.focus();
  await page.keyboard.press('Enter');
  await expect(dd(page, 'personDays')).toHaveText('4');
  await expect(cell).toBeFocused();
});

test('pasting the Excel leave sheet fills people and leave, and offers holidays', async ({ page }) => {
  await setSprint(page, '2026-11-09', '2026-11-20');
  await page.getByRole('button', { name: 'Paste leave from Excel' }).click();
  await page.fill('#paste-text', fixture);
  await expect(page.locator('#paste-preview')).toContainText('8 people and 22 date columns (10 inside this sprint)');
  await expect(page.locator('#paste-preview')).toContainText('Everyone is off on Mon 9 Nov, Tue 10 Nov');
  await expect(page.locator('#paste-hint')).toBeChecked();
  await expect(page.locator('#paste-preview tbody tr')).toHaveCount(8);
  await page.locator('#paste-apply').click();
  await expect(page.locator('#paste-dialog')).not.toBeVisible();
  await expect(dd(page, 'workingDays')).toHaveText('8');
  await expect(dd(page, 'personDays')).toHaveText('43');
  await expect(page.locator('#holiday-list')).toContainText('Mon 9 Nov 2026'); // holiday chip
  await expect(page.locator('tbody tr')).toHaveCount(8);
});

test('paste preview shows problems and blocks apply for unreadable input', async ({ page }) => {
  await page.getByRole('button', { name: 'Paste leave from Excel' }).click();
  await page.fill('#paste-text', 'hello world');
  await expect(page.locator('#paste-preview .err')).toBeVisible();
  await expect(page.locator('#paste-apply')).toBeDisabled();
  await page.fill('#paste-text', '');
  await expect(page.locator('#paste-preview')).toBeEmpty();
});

test('info icons explain each field on hover, focus and tap', async ({ page }) => {
  const icon = page.getByRole('button', { name: 'About fixed points', exact: true });
  await icon.hover();
  await expect(page.locator('#tooltip')).toBeVisible();
  await expect(page.locator('#tooltip')).toContainText('already spoken for');
  await page.mouse.move(5, 5);
  await expect(page.locator('#tooltip')).toBeHidden();

  await page.getByRole('button', { name: 'About buffer', exact: true }).focus();
  await expect(page.locator('#tooltip')).toContainText('A 20% buffer');
  await page.keyboard.press('Escape');
  await expect(page.locator('#tooltip')).toBeHidden();

  await page.getByRole('button', { name: 'About points for new stories' }).click();
  await expect(page.locator('#tooltip')).toContainText('gross capacity');
});

test('every input has an info icon next to it', async ({ page }) => {
  for (const name of ['sprint name', 'start date', 'sprint length', 'end date', 'weekends', 'holidays', 'points per person-day', 'fixed points', 'buffer', 'team and leave']) {
    await expect(page.getByRole('button', { name: `About ${name}`, exact: true })).toBeVisible();
  }
});

test('edits autosave and survive a reload', async ({ page }) => {
  await page.fill('#sprintName', 'Sprint 14');
  await page.fill('#fixedPoints', '12');
  await expect(page.locator('#sync-status')).toContainText('Saved');
  await page.reload();
  await expect(page.locator('#sprintName')).toHaveValue('Sprint 14');
  await expect(page.locator('#fixedPoints')).toHaveValue('12');
});

test('two people see each other\'s edits live, without overwriting each other', async ({ page, browser }) => {
  const other = await (await browser.newContext()).newPage();
  await other.goto('/');
  await expect(other.locator('#sync-status')).toContainText('Saved');

  await page.fill('#fixedPoints', '7');
  await expect(other.locator('#fixedPoints')).toHaveValue('7');
  await other.fill('#bufferPct', '25');
  await expect(page.locator('#bufferPct')).toHaveValue('25');
  await expect(page.locator('#fixedPoints')).toHaveValue('7');

  await addPerson(page, 'Asha');
  await expect(other.getByText('Asha', { exact: true })).toBeVisible();
  await other.context().close();
});

test('shows offline, keeps editing, and saves after the connection returns', async ({ page }) => {
  let blocked = false;
  await page.routeWebSocket(/\/ws\/playwright/, (ws) => {
    if (blocked) ws.close();
    else ws.connectToServer();
  });
  await page.reload();
  await expect(page.locator('#sync-status')).toContainText('Saved');

  blocked = true;
  await page.evaluate(() => { /* force the current socket to drop by reloading the connection */ });
  await page.reload();
  await expect(page.locator('#sync-status')).toContainText('Offline');
  await page.fill('#fixedPoints', '9'); // edit while offline
  await expect(page.locator('#fixedPoints')).toHaveValue('9');

  blocked = false; // next retry connects
  await expect(page.locator('#sync-status')).toContainText('Saved', { timeout: 20_000 });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.reload();
  await expect(page.locator('#fixedPoints')).toHaveValue('9');
});

test('backup downloads and restores', async ({ page }) => {
  await page.fill('#sprintName', 'Backup me');
  await setSprint(page);
  await addPerson(page, 'Asha');
  await expect(page.locator('#sync-status')).toContainText('Saved');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]);
  const file = await download.path();
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(json.fields.sprintName).toBe('Backup me');
  expect(json.fields.members[0].name).toBe('Asha');

  await page.getByRole('button', { name: 'Delete all data' }).first().click();
  await page.locator('#delete-confirm').click();
  await expect(page.locator('#sprintName')).toHaveValue('');

  await page.setInputFiles('#import-file', file);
  await expect(page.locator('#sprintName')).toHaveValue('Backup me');
  await expect(page.getByText('Asha', { exact: true })).toBeVisible();
});

test('restoring a file that is not a backup shows an error and changes nothing', async ({ page }) => {
  await page.fill('#sprintName', 'Keep');
  await page.setInputFiles('#import-file', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await expect(page.locator('#notice')).toContainText('not a Sprint Planner backup');
  await expect(page.locator('#sprintName')).toHaveValue('Keep');
});

test('delete all data asks first, and empties the room for everyone', async ({ page, browser }) => {
  const other = await (await browser.newContext()).newPage();
  await other.goto('/');
  await page.fill('#sprintName', 'Temporary');
  await expect(other.locator('#sprintName')).toHaveValue('Temporary');

  await page.locator('#delete-open').click();
  await page.locator('#delete-cancel').click();
  await expect(page.locator('#sprintName')).toHaveValue('Temporary'); // cancelled

  await page.locator('#delete-open').click();
  await page.locator('#delete-confirm').click();
  await expect(page.locator('#sprintName')).toHaveValue('');
  await expect(other.locator('#sprintName')).toHaveValue('');
  await other.context().close();
});

test('warns when fixed points exceed capacity', async ({ page }) => {
  await setSprint(page, '2026-11-02', '2026-11-06');
  await addPerson(page, 'Asha');
  await page.fill('#fixedPoints', '50');
  await expect(page.locator('.warning')).toContainText('Fixed points (50) exceed gross capacity (5)');
  await expect(page.locator('#net')).toHaveText('0');
});

test('retention note shows the next automatic deletion date after an edit', async ({ page }) => {
  await page.fill('#sprintName', 'x');
  await expect(page.locator('#retention')).toContainText('Next automatic deletion');
});

test('fits a phone screen without sideways page scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await setSprint(page, '2026-11-02', '2026-11-27');
  await addPerson(page, 'Asha Longname Example');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
