import { expect, test } from '@playwright/test';

import { createFixtureServer } from '../fixtures/app-server.mjs';
import { D1_FIXTURE } from '../fixtures/d1-seed.mjs';

// These run against the real D1 store on SQLite rather than the Airtable-shaped fixture.
let model;
test.beforeAll(async () => { model = await createFixtureServer({ port: 0, store: 'd1' }); });
test.afterAll(async () => { await model.close(); });

async function signIn(page, memberNumber, pin) {
  await page.goto(`${model.origin}/index.html`);
  await page.getByLabel('Password or Member number').fill(String(memberNumber));
  await page.getByLabel('Password or Member number').press('Enter');
  if (pin) {
    await page.getByLabel('Admin PIN').fill(pin);
    await page.getByRole('button', { name: 'Sign In' }).click();
  }
}

async function signInFully(page, memberNumber, pin) {
  await signIn(page, memberNumber, pin);
  await expect(page.locator('#member-home')).toBeVisible();
}

test('a super admin signs in with a PIN and edits private notes that stay out of the directory', async ({ page }) => {
  await signIn(page, D1_FIXTURE.superAdmin.memberNumber, D1_FIXTURE.superAdmin.pin);
  await page.getByRole('link', { name: 'Admin Console' }).click();
  await expect(page.getByRole('button', { name: 'Admins' })).toBeVisible();

  await page.getByRole('cell', { name: 'MAX MEMBER' }).click();
  await page.getByLabel('Notes').fill('Private test note');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#editor-msg')).toHaveText('Saved.');

  const directory = await page.evaluate(() => window.Harumphers.api('/api/directory'));
  expect(JSON.stringify(directory)).not.toContain('Private test note');
});

test('an admin sees event lists but not super admin controls', async ({ page }) => {
  await signInFully(page, D1_FIXTURE.admin.memberNumber, D1_FIXTURE.admin.pin);
  await page.goto(`${model.origin}/admin.html`);
  await expect(page.getByRole('button', { name: 'Admins' })).toBeHidden();
  await page.getByRole('button', { name: 'Lists & Export' }).click();
  await expect(page.locator('#list-title')).toHaveText('October Speaker: Going');
  await expect(page.locator('#list-table tbody tr')).toHaveCount(1);
});

test('a wrong PIN is refused and a regular member cannot open the console', async ({ page }) => {
  await signIn(page, D1_FIXTURE.admin.memberNumber, '0000');
  await expect(page.locator('#gate-error')).toHaveText('That PIN is not correct.');

  await signInFully(page, D1_FIXTURE.member.memberNumber);
  await page.goto(`${model.origin}/admin.html`);
  await expect(page.getByRole('heading', { name: 'Admins only' })).toBeVisible();
});

test('on a computer the member editor docks beside a sortable list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInFully(page, D1_FIXTURE.superAdmin.memberNumber, D1_FIXTURE.superAdmin.pin);
  await page.goto(`${model.origin}/admin.html`);

  await expect(page.locator('.detail-empty')).toBeVisible();
  await page.getByRole('cell', { name: 'NATE NORESPONSE' }).click();
  await expect(page.locator('#editor.docked')).toBeVisible();
  await expect(page.getByLabel('Full name')).toHaveValue('NATE NORESPONSE');
  // The list stays usable while the editor is open: pick another member directly.
  await page.getByRole('cell', { name: 'ANN ORGANIZER' }).click();
  await expect(page.getByLabel('Full name')).toHaveValue('ANN ORGANIZER');
  await expect(page.locator('#member-table tr.selected')).toContainText('ANN ORGANIZER');

  const firstNumber = () => page.locator('#member-table tbody tr').first().locator('td').nth(1);
  await page.getByRole('button', { name: 'Member #' }).click();
  await expect(firstNumber()).toHaveText('90001');
  await expect(page.locator('th[data-sort="number"]')).toHaveAttribute('aria-sort', 'ascending');
  await page.getByRole('button', { name: 'Member #' }).click();
  await expect(firstNumber()).toHaveText('90004');

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('#editor')).toBeHidden();
  await expect(page.locator('#member-table tr.selected')).toHaveCount(0);
});

test('upcoming event counts open the matching list', async ({ page }) => {
  await signInFully(page, D1_FIXTURE.admin.memberNumber, D1_FIXTURE.admin.pin);
  await page.goto(`${model.origin}/admin.html`);
  const card = page.locator('#upcoming .card', { hasText: 'October Speaker' });
  await expect(card).toContainText('2 guests coming with members');
  await expect(card.getByRole('button', { name: /Going/ })).toContainText('1');
  await card.getByRole('button', { name: /No reply/ }).click();
  await expect(page.locator('#list-title')).toHaveText("October Speaker: Haven't responded");
  await expect(page.locator('#list-table tbody tr')).toHaveCount(2);
});

test('on a phone the member editor opens full screen and closes after saving', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInFully(page, D1_FIXTURE.superAdmin.memberNumber, D1_FIXTURE.superAdmin.pin);
  await page.goto(`${model.origin}/admin.html`);
  await expect(page.locator('.detail-empty')).toBeHidden();
  await page.locator('#member-table tr', { hasText: 'NATE NORESPONSE' }).click();
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#editor')).not.toHaveClass(/docked/);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#editor')).toBeHidden();
});
