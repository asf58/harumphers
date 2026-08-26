import { expect, test } from '@playwright/test';

async function login(page, role) {
  await page.goto('/index.html');
  await page.evaluate(async value => {
    if (value === 'admin') await window.Harumphers.loginAdmin('fixture-admin-password');
    else await window.Harumphers.loginMember(42001);
  }, role);
}

test('directory cards and detail dialog work from a keyboard', async ({ page }) => {
  await login(page, 'member');
  await page.goto('/directory.html');

  const firstCard = page.locator('.card').first();
  await firstCard.focus();
  await expect(firstCard).toBeFocused();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByRole('button', { name: 'Close member details' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(firstCard).toBeFocused();
});

test('event disclosure controls expose expanded state and keyboard operation', async ({ page }) => {
  await login(page, 'member');
  await page.goto('/events.html');

  const disclosure = page.getByRole('button', { name: /Community Leadership/ });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await disclosure.focus();
  await page.keyboard.press(' ');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
});

test('Add Event fields have programmatic labels and primary controls meet touch size', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/events.html');
  await page.getByRole('button', { name: '+ Add New Event' }).click();

  for (const label of ['Name', 'Date', 'Speaker', 'Time', 'Room', 'Speaker Photo', 'Notes', 'Status']) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }

  const undersized = await page.evaluate(() => [...document.querySelectorAll(
    'header a, .new-event-actions button, .detail-close, .view-toggle-bar button'
  )].map(element => {
    const rect = element.getBoundingClientRect();
    return { text: element.textContent.trim(), width: rect.width, height: rect.height };
  }).filter(item => item.width < 44 || item.height < 44));
  expect(undersized).toEqual([]);
});
