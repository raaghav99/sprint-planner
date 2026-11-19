import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = fs.readFileSync(new URL('../test/fixtures/nov26-sheet.tsv', import.meta.url), 'utf8');

// Pin "today" so the current sprint is predictable: 18 Nov 2026 is inside Sprint 14 (9 to 22 Nov).
const APP = '/?today=2026-11-18';

/** Wipe the shared room from inside the page, so the Origin header is the allowed localhost:8080. */
async function resetRoom(page) {
  await page.goto(APP);
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
const tab = (page, n) => page.locator('#overview').getByRole('button', { name: `Sprint ${n}`, exact: true });
const fixedHas = (page, name) => page.locator(`#fixed-list input[data-prop="label"][value="${name}"]`);

async function setAnchor(page, { number = 14, start = '2026-11-09', end = '2026-11-20' } = {}) {
  await page.fill('#anchorNumber', String(number));
  await page.fill('#anchorStart', start);
  await page.fill('#anchorEnd', end);
  await expect(page.locator('#overview')).toBeVisible();
}
async function addPerson(page, name) {
  await page.fill('#member-name', name);
  await page.getByRole('button', { name: 'Add person' }).click();
}
async function addFixed(page, label, points) {
  await page.fill('#fixed-label', label);
  await page.fill('#fixed-points', String(points));
  await page.getByRole('button', { name: 'Add fixed points' }).click();
}
const row = (page, name) => page.locator('#team-list tr.person', { hasText: name });

test.beforeEach(async ({ page }) => { await resetRoom(page); });

// ------------------------------------------------------------------ sprints
test('asks for the current sprint first, but the team can already be added', async ({ page }) => {
  await expect(page.locator('#setup-note')).toBeVisible();
  await expect(page.locator('#sprint-area')).toBeHidden();
  await addPerson(page, 'Asha');
  await expect(row(page, 'Asha')).toBeVisible();
});

test('one anchor sprint gives the last three, the current and the next three', async ({ page }) => {
  await setAnchor(page);
  await expect(page.locator('#overview tbody tr')).toHaveCount(7);
  for (const n of [11, 12, 13, 14, 15, 16, 17]) await expect(tab(page, n)).toBeVisible();
  const row = (n) => page.locator('#overview tbody tr', { hasText: `Sprint ${n}` });
  await expect(row(14)).toContainText('Current');
  await expect(row(14)).toHaveClass(/sel/);
  await expect(page.locator('#sprint-dates')).toContainText('Mon 9 Nov 2026 to Fri 20 Nov 2026');
  await expect(row(15)).toContainText('23 Nov – 4 Dec'); // weekend in between, next sprint starts Monday
  await expect(row(13)).toContainText('26 Oct – 6 Nov');
  await expect(page.locator('#anchorEnd')).toHaveValue('2026-11-20');
});

test('the current sprint follows today without any edits', async ({ page }) => {
  await setAnchor(page);
  await expect(page.locator('#sync-status')).toContainText('Saved');
  await page.goto('/?today=2026-11-25');
  await expect(page.locator('#overview tbody tr')).toHaveCount(7);
  await expect(page.locator('#overview tbody tr', { hasText: 'Sprint 15' })).toContainText('Current');
  await expect(tab(page, 12)).toBeVisible();
  await expect(tab(page, 18)).toBeVisible();
  await expect(page.locator('#sprint-heading')).toContainText('Sprint 15 (current)');
});

test('past and upcoming sprints can be opened and edited', async ({ page }) => {
  await setAnchor(page);
  await tab(page, 12).click();
  await expect(page.locator('#sprint-heading')).toContainText('Sprint 12 (past)');
  await expect(page.locator('#sprint-dates')).toContainText('Mon 12 Oct 2026 to Fri 23 Oct 2026');
  await tab(page, 17).click();
  await expect(page.locator('#sprint-heading')).toContainText('Sprint 17 (upcoming)');
  await addFixed(page, 'Release', 6);
  await expect(fixedHas(page, 'Release')).toHaveCount(1);
  await tab(page, 14).click();
  await expect(fixedHas(page, 'Release')).toHaveCount(0); // other sprints untouched
  await expect(page.locator('#sync-status')).toContainText('Saved');
  await page.reload();
  await tab(page, 17).click();
  await expect(fixedHas(page, 'Release')).toHaveCount(1);
});

test('one sprint can have its own start and end dates', async ({ page }) => {
  await setAnchor(page);
  await tab(page, 15).click();
  await page.getByText("Change this sprint's dates").click();
  await page.fill('#sprintEnd', '2026-12-11');
  await expect(page.locator('#sprint-dates')).toContainText('Fri 11 Dec 2026');
  await expect(page.locator('#sprint-dates')).toContainText('19 calendar days');
  await tab(page, 14).click();
  await expect(page.locator('#sprint-dates')).toContainText('Fri 20 Nov 2026'); // others not affected
  await tab(page, 15).click();
  await expect(page.getByText('Dates changed for this sprint')).toBeVisible();
  await page.getByRole('button', { name: 'Use automatic dates' }).click();
  await expect(page.locator('#sprint-dates')).toContainText('Fri 4 Dec 2026');
});

test('overview lists all seven sprints and opens one when selected', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await expect(page.locator('#overview tbody tr')).toHaveCount(7);
  const r14 = page.locator('#overview tbody tr', { hasText: 'Sprint 14' });
  await expect(r14).toContainText('Current');
  await expect(r14.locator('td').nth(1)).toHaveText('1'); // active people
  await page.locator('#overview').getByRole('button', { name: 'Sprint 16' }).click();
  await expect(page.locator('#sprint-heading')).toContainText('Sprint 16');
});

test('shows how many days are left in the sprint', async ({ page }) => {
  await setAnchor(page); // today is Wed 18 Nov, sprint 14 ends Sun 22 Nov
  await expect(page.locator('#sprint-left')).toContainText('3 working days left');
  await expect(page.locator('#sprint-left')).toContainText('ends in 2 days');
  await tab(page, 15).click();
  await expect(page.locator('#sprint-left')).toHaveText('Starts in 5 days');
  await tab(page, 13).click();
  await expect(page.locator('#sprint-left')).toHaveText('Ended 12 days ago');
  await tab(page, 14).click();
  await page.fill('#holiday-input', '2026-11-19');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#sprint-left')).toContainText('2 working days left');
});

// ------------------------------------------------------------------ capacity
test('calculates capacity from dates, people, fixed points and buffer', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await addPerson(page, 'Ben');
  await addFixed(page, 'Support', 4);
  await page.fill('#bufferPct', '10');
  await expect(dd(page, 'workingDays')).toHaveText('10');
  await expect(dd(page, 'activeMembers')).toHaveText('2');
  await expect(dd(page, 'personDays')).toHaveText('20');
  await expect(dd(page, 'gross')).toHaveText('20');
  await expect(page.locator('#net')).toHaveText('14.4');
});

test('holidays and weekend days change working days', async ({ page }) => {
  await setAnchor(page);
  await page.fill('#holiday-input', '2026-11-12');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dd(page, 'workingDays')).toHaveText('9');
  await page.getByRole('button', { name: /Remove holiday/ }).click();
  await expect(dd(page, 'workingDays')).toHaveText('10');
  await page.locator('#weekend-days label', { hasText: 'Sun' }).click(); // Sunday now works
  await expect(dd(page, 'workingDays')).toHaveText('11');
});

test('warns when fixed points and spillover exceed capacity', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await addFixed(page, 'Big', 50);
  await expect(page.locator('.warning')).toContainText('exceed gross capacity (10)');
  await expect(page.locator('#net')).toHaveText('0');
});

// ------------------------------------------------------------------ fixed points
test('fixed story points can be added one after another and removed', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await addFixed(page, 'Support', 3);
  await addFixed(page, 'Bug bash', 2.5);
  await expect(page.locator('#fixed-list li')).toHaveCount(3); // two items plus the total line
  await expect(page.locator('#fixed-list .item-total')).toContainText('5.5');
  await expect(dd(page, 'fixed')).toHaveText('5.5');
  await page.getByRole('button', { name: 'Remove Support' }).click();
  await expect(dd(page, 'fixed')).toHaveText('2.5');
  await expect(fixedHas(page, 'Support')).toHaveCount(0);
});

test('a fixed item can be renamed and its points changed, and it updates everywhere', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await addPerson(page, 'Ben'); // 20 person-days
  await addFixed(page, 'Fixed points', 4);
  await expect(page.locator('#bar-legend')).toContainText('Fixed points');
  await page.getByLabel('Name of fixed points').fill('RCA');
  await expect(page.locator('#bar-legend')).toContainText('RCA');
  await expect(page.locator('#bar-legend')).not.toContainText('Fixed points');
  await page.getByLabel('Points for RCA').fill('6');
  await expect(dd(page, 'fixed')).toHaveText('6');
  await expect(page.locator('#fixed-list .item-total')).toContainText('6');
  await expect(page.locator('#net')).toHaveText('14');
  await expect(page.locator('#sync-status')).toContainText('Saved');
  await page.reload();
  await expect(fixedHas(page, 'RCA')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Remove RCA' })).toBeVisible(); // button follows the new name
  const row14 = page.locator('#overview tbody tr', { hasText: 'Sprint 14' });
  await expect(row14).toContainText('6'); // overview fixed column
});

test('the fixed points section can be renamed, and the new name shows everywhere', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await expect(page.locator('#fixedLabel')).toHaveValue('');
  await expect(page.locator('#fixedLabel')).toHaveAttribute('placeholder', 'alias');
  await expect(page.locator('dt', { hasText: 'Fixed story points' })).toBeVisible(); // default name
  await page.locator('#fixedLabel').fill('RCA');
  await expect(page.locator('dt', { hasText: 'Fixed story points (RCA)' })).toBeVisible();
  await expect(page.locator('#overview thead')).toContainText('Fixed story points (RCA)');
  await addFixed(page, 'Login bug', 3);
  await expect(page.locator('#bar-legend')).toContainText('Login bug'); // item names still show per item
  await expect(page.locator('#sync-status')).toContainText('Saved');
  await page.reload();
  await expect(page.locator('#fixedLabel')).toHaveValue('RCA');
  await page.locator('#fixedLabel').fill('');
  await expect(page.locator('dt', { hasText: 'Fixed story points' })).toBeVisible(); // back to the default
});

test('typing in a fixed item name keeps the cursor in the box', async ({ page }) => {
  await setAnchor(page);
  await addFixed(page, 'A', 1);
  const box = page.getByLabel('Name of A');
  await box.click();
  await page.keyboard.type('BCD');
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('ABCD');
});

test('there is no row of sprint tabs; sprints are picked in the All sprints table', async ({ page }) => {
  await setAnchor(page);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.locator('#overview tbody tr', { hasText: 'Sprint 16' }).locator('td').first().click(); // whole row selects
  await expect(page.locator('#sprint-heading')).toContainText('Sprint 16');
});

test('sprint end date sets the length, and later sprints start on the next working day', async ({ page }) => {
  await setAnchor(page, { start: '2026-11-09', end: '2026-11-13' }); // one week, Mon to Fri
  await expect(dd(page, 'workingDays')).toHaveText('5');
  await expect(page.locator('#overview tbody tr', { hasText: 'Sprint 15' })).toContainText('16 Nov – 20 Nov');
  await page.fill('#anchorEnd', '2026-11-20');
  await expect(dd(page, 'workingDays')).toHaveText('10');
  await expect(page.locator('#overview tbody tr', { hasText: 'Sprint 15' })).toContainText('23 Nov – 4 Dec');
});

test('an item with no points is not added, and a blank label gets a default name', async ({ page }) => {
  await setAnchor(page);
  await page.fill('#fixed-label', 'Zzz');
  await page.getByRole('button', { name: 'Add fixed points' }).click();
  await expect(fixedHas(page, 'Zzz')).toHaveCount(0);
  await page.fill('#fixed-label', '');
  await page.fill('#fixed-points', '4');
  await page.getByRole('button', { name: 'Add fixed points' }).click();
  await expect(fixedHas(page, 'Fixed points')).toHaveCount(1);
});

// ------------------------------------------------------------------ spillover
test('spillover out becomes spillover in on the next sprint, and can be overridden', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await page.fill('#spillOut', '5');
  await tab(page, 15).click();
  await expect(page.locator('#spillIn')).toHaveValue('5');
  await expect(page.locator('#spillIn-hint')).toContainText("From Sprint 14's spillover out");
  await expect(dd(page, 'spill')).toHaveText('5');
  await expect(page.locator('#spill-auto')).toBeHidden();

  await page.fill('#spillIn', '1');
  await expect(dd(page, 'spill')).toHaveText('1');
  await expect(page.locator('#spillIn-hint')).toContainText('Typed in');
  await expect(page.locator('#spill-auto')).toBeVisible();

  await page.locator('#spill-auto').click();
  await expect(dd(page, 'spill')).toHaveText('5');
  await expect(page.locator('#spill-auto')).toBeHidden();
});

test('spillover comes off capacity before the buffer', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await addPerson(page, 'Ben'); // 20 gross in a 10 day sprint
  await page.fill('#spillOut', '6');
  await page.fill('#bufferPct', '10');
  await tab(page, 15).click(); // 23 Nov to 6 Dec: 10 working days
  await expect(dd(page, 'gross')).toHaveText('20');
  await addFixed(page, 'Support', 4);
  await expect(page.locator('#net')).toHaveText('9'); // (20 - 4 - 6) x 0.9
});

// ------------------------------------------------------------------ team
test('people who joined or left only count in the sprints they were on the team', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await addPerson(page, 'Ben');
  await row(page, 'Ben').getByRole('button', { name: /Edit dates for Ben/ }).click();
  await page.getByLabel('Last day of Ben').fill('2026-11-08');
  await expect(dd(page, 'activeMembers')).toHaveText('1'); // sprint 14: Ben has left
  await expect(page.locator('#team-count')).toContainText('1 active in Sprint 14');
  await expect(row(page, 'Ben')).toContainText('Not on the team this sprint');
  await tab(page, 13).click();
  await expect(dd(page, 'activeMembers')).toHaveText('2'); // sprint 13 (26 Oct to 8 Nov): both there
  const r14 = page.locator('#overview tbody tr', { hasText: 'Sprint 14' });
  await expect(r14.locator('td').nth(1)).toHaveText('1');
  const r13 = page.locator('#overview tbody tr', { hasText: 'Sprint 13' });
  await expect(r13.locator('td').nth(1)).toHaveText('2');
});

test('a person who joins later is not counted before their first day', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await addPerson(page, 'Cy');
  await row(page, 'Cy').getByRole('button', { name: /Edit dates for Cy/ }).click();
  await page.getByLabel('Joined Cy').fill('2026-11-23');
  await expect(dd(page, 'activeMembers')).toHaveText('1'); // sprint 14
  await tab(page, 15).click();
  await expect(dd(page, 'activeMembers')).toHaveText('2'); // sprint 15 starts 23 Nov
});

test('the calendar shows each working day, holidays too, with Saturday and Sunday as one weekend column', async ({ page }) => {
  await setAnchor(page);
  await page.fill('#holiday-input', '2026-11-12');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await addPerson(page, 'Asha');
  await expect(page.locator('#team-list thead th.dh')).toHaveCount(11); // 5 days, one weekend column, 5 days
  await expect(page.locator('#team-list thead th.weekend')).toHaveCount(1);
  await expect(page.locator('#team-list thead th.weekend')).toContainText('14–15'); // Saturday and Sunday together
  await expect(page.locator('#team-list thead th.holiday')).toHaveCount(1);
  await expect(row(page, 'Asha').locator('button.cell')).toHaveCount(10);
  await expect(row(page, 'Asha').locator('.psum')).toContainText('9');
});

test('marking days off works from the calendar and updates the totals', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await expect(row(page, 'Asha').locator('.psum b')).toHaveText('10');
  await page.getByRole('button', { name: /Asha, Tue 10 Nov/ }).click();
  await expect(row(page, 'Asha').locator('.psum b')).toHaveText('9');
  await expect(page.getByRole('button', { name: /Asha, Tue 10 Nov/ })).toHaveClass(/off/);
  await page.getByRole('button', { name: /Asha, Wed 11 Nov/ }).click();
  await page.getByRole('button', { name: /Asha, Wed 11 Nov/ }).click(); // working -> off -> half
  await expect(row(page, 'Asha').locator('.psum b')).toHaveText('8.5');
  await expect(page.getByRole('button', { name: /Asha, Wed 11 Nov/ })).toHaveClass(/half/);
  await page.getByRole('button', { name: /Asha, Wed 11 Nov/ }).click(); // back to working
  await expect(row(page, 'Asha').locator('.psum b')).toHaveText('9');
});

test('a day off on a holiday stays visible and does not change capacity', async ({ page }) => {
  await setAnchor(page);
  await page.fill('#holiday-input', '2026-11-12');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await addPerson(page, 'Asha');
  await page.getByRole('button', { name: /Asha, Thu 12 Nov/ }).click(); // the holiday
  await expect(page.getByRole('button', { name: /Asha, Thu 12 Nov/ })).toHaveClass(/off/);
  await expect(page.getByRole('button', { name: /Asha, Sat 14 Nov/ })).toHaveCount(0); // weekend is one shaded column
  await expect(dd(page, 'personDays')).toHaveText('9'); // not taken off twice
});

test('grid cells work from the keyboard and keep focus', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  const cell = page.getByRole('button', { name: /Asha, Wed 11 Nov/ });
  await cell.focus();
  await page.keyboard.press('Enter');
  await expect(dd(page, 'personDays')).toHaveText('9');
  await expect(cell).toBeFocused();
});

test('a person can be removed', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await page.getByRole('button', { name: 'Remove Asha' }).click();
  await expect(row(page, 'Asha')).toHaveCount(0);
  await expect(dd(page, 'activeMembers')).toHaveText('0');
});

test('the calendar follows the selected sprint', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await tab(page, 15).click();
  await expect(page.getByRole('button', { name: /Asha, Mon 23 Nov/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Asha, Mon 9 Nov/ })).toHaveCount(0);
});

// ------------------------------------------------------------------ today
test('the today card shows who can work today and who is on leave', async ({ page }) => {
  await setAnchor(page); // today is pinned to Wed 18 Nov
  await expect(page.locator('#today')).toBeVisible();
  await addPerson(page, 'Asha');
  await addPerson(page, 'Ben');
  await addPerson(page, 'Cy');
  await expect(page.locator('#today-line')).toContainText('3 of 3');
  await expect(page.locator('#today-leave')).toContainText('Nobody is on leave');
  await page.getByRole('button', { name: /Ben, Wed 18 Nov/ }).click(); // off
  await page.getByRole('button', { name: /Cy, Wed 18 Nov/ }).click();
  await page.getByRole('button', { name: /Cy, Wed 18 Nov/ }).click(); // half
  await expect(page.locator('#today-line')).toContainText('1.5 of 3');
  await expect(page.locator('#today-leave')).toContainText('Ben');
  await expect(page.locator('#today-leave')).toContainText('Cy (half day)');
  await expect(page.locator('#today-people .sq')).toHaveCount(3);
  await expect(page.locator('#today-people .sq.off')).toHaveCount(1);
});

test('the blue current panel shows points left, days left, active members and who is out today', async ({ page }) => {
  await setAnchor(page); // today Wed 18 Nov, sprint 14 ends Sun 22 Nov
  await addPerson(page, 'Asha');
  await addPerson(page, 'Ben');
  await addFixed(page, 'Support', 4);
  await page.getByRole('button', { name: /Ben, Wed 18 Nov/ }).click();
  await expect(page.locator('#cur-n')).toHaveText('14');
  await expect(page.locator('#cur-points')).toHaveText('15'); // 20 person-days - 1 day off - 4 fixed
  await expect(page.locator('#cur-days')).toHaveText('3');
  await expect(page.locator('#cur-active')).toHaveText('2');
  await expect(page.locator('#cur-leave-count')).toHaveText('1');
  await expect(page.locator('#today-leave')).toContainText('On leave today: Ben');
  await tab(page, 16).click(); // looking at another sprint does not change the current panel
  await expect(page.locator('#cur-n')).toHaveText('14');
  await expect(page.locator('#cur-points')).toHaveText('15');
});

test('fixed points and spillover sit in the left column, below Points', async ({ page }) => {
  await setAnchor(page);
  const rail = page.locator('.rail');
  await expect(rail.locator('#fixed-form')).toBeVisible();
  await expect(rail.locator('#spillIn')).toBeVisible();
  const points = await page.locator('#bufferPct').boundingBox();
  const fixed = await page.locator('#fixed-label').boundingBox();
  const main = await page.locator('.main').boundingBox();
  expect(fixed.y).toBeGreaterThan(points.y);
  expect(fixed.x).toBeLessThan(main.x);
  await expect(page.locator('#rail-sprint-name')).toHaveText('Sprint 14');
  await tab(page, 15).click();
  await expect(page.locator('#rail-sprint-name')).toHaveText('Sprint 15');
});

test('the today card always shows today, whichever sprint is open', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await tab(page, 16).click();
  await expect(page.locator('#today-line')).toContainText('Wed 18 Nov');
});

test('the today card says so on a weekend', async ({ page }) => {
  await setAnchor(page);
  await expect(page.locator('#sync-status')).toContainText('Saved');
  await page.goto('/?today=2026-11-14');
  await expect(page.locator('#today-line')).toContainText('weekend');
});

// ------------------------------------------------------------------ paste
test('pasting the Excel leave sheet fills people and leave, and offers holidays', async ({ page }) => {
  await setAnchor(page);
  await page.getByRole('button', { name: 'Paste leave from Excel' }).click();
  await page.fill('#paste-text', fixture);
  await expect(page.locator('#paste-preview')).toContainText('8 people and 22 date columns');
  await expect(page.locator('#paste-preview')).toContainText('Everyone is off on Mon 9 Nov, Tue 10 Nov');
  await expect(page.locator('#paste-hint')).not.toBeChecked(); // opt in
  await page.locator('#paste-apply').click();
  await expect(page.locator('#paste-dialog')).not.toBeVisible();
  await expect(page.locator('#holiday-list')).toBeEmpty();
  await expect(dd(page, 'workingDays')).toHaveText('10');
  await expect(page.getByRole('button', { name: /Mina Rao, Mon 9 Nov/ })).toHaveClass(/off/); // off days are kept
  await expect(dd(page, 'personDays')).toHaveText('43');
  await expect(dd(page, 'activeMembers')).toHaveText('7'); // one person is off the whole sprint
  await expect(page.locator('#team-list tr.person')).toHaveCount(8);
});

test('pasting keeps people who are not in the sheet, off for the pasted dates', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Zed');
  await page.getByRole('button', { name: 'Paste leave from Excel' }).click();
  await page.fill('#paste-text', fixture);
  await expect(page.locator('#paste-preview')).toContainText('Zed');
  await expect(page.locator('#paste-preview')).toContainText('keep their history and are off on these dates');
  await page.locator('#paste-apply').click();
  await expect(row(page, 'Zed')).toHaveCount(1);
  await expect(row(page, 'Zed')).toContainText('Off the whole sprint');
  await expect(page.locator('#team-list tr.person')).toHaveCount(9);
});

test('pasting can leave people who are not in the sheet untouched', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Zed');
  await page.getByRole('button', { name: 'Paste leave from Excel' }).click();
  await page.fill('#paste-text', fixture);
  await page.locator('#paste-others').uncheck();
  await expect(page.locator('#paste-preview')).toContainText('keep their leave as it is');
  await page.locator('#paste-apply').click();
  await expect(row(page, 'Zed').locator('.psum b')).toHaveText('10'); // not turned off
  await expect(row(page, 'Zed')).not.toContainText('Off the whole sprint');
});

test('pasting works before the current sprint is set, and the leave is kept', async ({ page }) => {
  await page.getByRole('button', { name: 'Paste leave from Excel' }).click();
  await page.fill('#paste-text', fixture);
  await expect(page.locator('#paste-preview')).toContainText('Set the current sprint first');
  await page.locator('#paste-apply').click();
  await expect(page.locator('#team-list tr.person')).toHaveCount(8);
  await setAnchor(page);
  await expect(dd(page, 'personDays')).toHaveText('43'); // pasted leave and holidays were kept
});

test('paste preview shows problems and blocks apply for unreadable input', async ({ page }) => {
  await page.getByRole('button', { name: 'Paste leave from Excel' }).click();
  await page.fill('#paste-text', 'hello world');
  await expect(page.locator('#paste-preview .err')).toBeVisible();
  await expect(page.locator('#paste-apply')).toBeDisabled();
  await page.fill('#paste-text', '');
  await expect(page.locator('#paste-preview')).toBeEmpty();
});

// ------------------------------------------------------------------ info icons
test('info icons explain each field on hover, focus and tap', async ({ page }) => {
  await setAnchor(page);
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
  await setAnchor(page);
  for (const name of [
    'sprint number', 'start date', 'end date', 'weekends', 'holidays', 'points per person-day', 'buffer',
    'fixed points', 'spillover', 'spillover in', 'spillover out', 'team and leave', 'all sprints',
  ]) {
    await expect(page.getByRole('button', { name: `About ${name}`, exact: true })).toBeVisible();
  }
});

// ------------------------------------------------------------------ saving and sync
test('edits autosave and survive a reload', async ({ page }) => {
  await setAnchor(page);
  await page.fill('#bufferPct', '12');
  await addFixed(page, 'Support', 3);
  await expect(page.locator('#sync-status')).toContainText('Saved');
  await page.reload();
  await expect(page.locator('#anchorNumber')).toHaveValue('14');
  await expect(page.locator('#bufferPct')).toHaveValue('12');
  await expect(fixedHas(page, 'Support')).toHaveCount(1);
});

test('two people see each other\'s edits live, without overwriting each other', async ({ page, browser }) => {
  await setAnchor(page);
  const other = await (await browser.newContext()).newPage();
  await other.goto(APP);
  await expect(other.locator('#overview')).toBeVisible();

  await page.fill('#bufferPct', '7');
  await expect(other.locator('#bufferPct')).toHaveValue('7');

  // both edit at the same time, in different sprints
  await addFixed(page, 'From A', 3);
  await tab(other, 15).click();
  await other.fill('#spillOut', '4');
  await expect(fixedHas(page, 'From A')).toHaveCount(1);

  await tab(page, 15).click();
  await expect(page.locator('#spillOut')).toHaveValue('4');
  await tab(other, 14).click();
  await expect(fixedHas(other, 'From A')).toHaveCount(1);

  await addPerson(page, 'Asha');
  await expect(other.locator('#team-list')).toContainText('Asha');
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
  await page.reload();
  await expect(page.locator('#sync-status')).toContainText('Offline');
  await page.fill('#bufferPct', '9'); // edit while offline
  await expect(page.locator('#bufferPct')).toHaveValue('9');

  blocked = false; // next retry connects
  await expect(page.locator('#sync-status')).toContainText('Saved', { timeout: 20_000 });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.reload();
  await expect(page.locator('#bufferPct')).toHaveValue('9');
});

// ------------------------------------------------------------------ backup, delete, misc
test('backup downloads and restores everything, including every sprint', async ({ page }) => {
  await setAnchor(page);
  await addPerson(page, 'Asha');
  await addFixed(page, 'Support', 3);
  await page.fill('#spillOut', '2');
  await tab(page, 16).click();
  await addFixed(page, 'Later', 1);
  await expect(page.locator('#sync-status')).toContainText('Saved');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]);
  const file = await download.path();
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(json.version).toBe(2);
  expect(json.fields.members[0].name).toBe('Asha');
  expect(Object.keys(json.fields.sprints).sort()).toEqual(['14', '16']);

  await page.locator('#delete-open').click();
  await page.locator('#delete-confirm').click();
  await expect(page.locator('#setup-note')).toBeVisible();

  await page.setInputFiles('#import-file', file);
  await expect(page.locator('#overview')).toBeVisible();
  await expect(page.locator('#team-list')).toContainText('Asha');
  await tab(page, 16).click();
  await expect(fixedHas(page, 'Later')).toHaveCount(1);
});

test('restoring a backup replaces what is there, instead of mixing the two', async ({ page }) => {
  await setAnchor(page);
  await addFixed(page, 'Old item', 3);
  await tab(page, 12).click();
  await addFixed(page, 'Old past item', 1);
  const backup = {
    version: 2,
    fields: { sprintBase: { number: 14, startDate: '2026-11-09', length: 14 }, sprints: { 14: { fixedItems: [{ id: 'n', label: 'New item', points: 2 }], spillOut: 0 } } },
  };
  await page.setInputFiles('#import-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.locator('#sync-status')).toContainText('Saved');
  await tab(page, 14).click();
  await expect(fixedHas(page, 'New item')).toHaveCount(1);
  await expect(fixedHas(page, 'Old item')).toHaveCount(0);
  await tab(page, 12).click();
  await expect(fixedHas(page, 'Old past item')).toHaveCount(0); // sprints not in the backup are gone
});

test('an old single sprint backup is converted when restored', async ({ page }) => {
  const old = {
    version: 1,
    fields: {
      sprintName: 'Sprint 9', dateMode: 'range', startDate: '2026-11-09', endDate: '2026-11-22', numDays: 14,
      weekendDays: [0, 6], holidays: [], members: [{ id: 'a', name: 'Asha', leave: [] }],
      pointsPerPersonDay: 1, fixedPoints: 5, bufferPct: 10,
    },
  };
  await page.setInputFiles('#import-file', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await expect(page.locator('#anchorNumber')).toHaveValue('9');
  await expect(page.locator('#bufferPct')).toHaveValue('10');
  await expect(fixedHas(page, 'Fixed points')).toHaveCount(1);
  await expect(dd(page, 'fixed')).toHaveText('5');
});

test('restoring a file that is not a backup shows an error and changes nothing', async ({ page }) => {
  await page.fill('#bufferPct', '3');
  await page.setInputFiles('#import-file', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await expect(page.locator('#notice')).toContainText('not a Sprint Planner backup');
  await expect(page.locator('#bufferPct')).toHaveValue('3');
});

test('delete all data asks first, and empties the room for everyone', async ({ page, browser }) => {
  await setAnchor(page);
  const other = await (await browser.newContext()).newPage();
  await other.goto(APP);
  await expect(other.locator('#overview')).toBeVisible();

  await page.locator('#delete-open').click();
  await page.locator('#delete-cancel').click();
  await expect(page.locator('#overview')).toBeVisible(); // cancelled

  await page.locator('#delete-open').click();
  await page.locator('#delete-confirm').click();
  await expect(page.locator('#setup-note')).toBeVisible();
  await expect(other.locator('#setup-note')).toBeVisible();
  await other.context().close();
});

test('retention note shows the next automatic deletion date after an edit', async ({ page }) => {
  await page.fill('#bufferPct', '1');
  await expect(page.locator('#retention')).toContainText('Next automatic deletion');
});

test('fits a phone screen without sideways page scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await setAnchor(page);
  await addPerson(page, 'Asha Longname Example');
  await addFixed(page, 'A rather long description of fixed work', 3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
