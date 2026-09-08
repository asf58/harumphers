import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page, request }) => {
  await request.post('/__fixtures/reset');
  await page.goto('/index.html');
  await page.evaluate(() => Harumphers.loginMember(42002));
  await page.goto('/events.html');
});

test('admin can save, display and clear event location', async ({ page }) => {
  await page.getByRole('button', { name: '+ Add New Event' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Location acceptance event');
  await page.getByLabel('Location', { exact: true }).fill('Duquesne Club, 325 Sixth Avenue');
  await page.getByRole('button', { name: 'Create Event', exact: true }).click();
  const card = page.locator('.event-card').filter({ hasText: 'Location acceptance event' });
  await expect(card).toContainText('Duquesne Club, 325 Sixth Avenue');
  await card.getByRole('button', { name: /Location acceptance event/ }).click();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await card.getByLabel('Location', { exact: true }).fill('Another venue');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card).toContainText('Another venue');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await card.getByLabel('Location', { exact: true }).fill('');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card).not.toContainText('Another venue');
  await page.reload();
  await expect(card).not.toContainText('Duquesne Club');
});

test('admin can add and clear RSVP after event completion', async ({ page }) => {
  await page.evaluate(async () => {
    await Harumphers.api('/api/admin/events/recFixtureEvent01', { method: 'PATCH', body: JSON.stringify({ name: 'Completed RSVP fixture', date: '2026-09-12', speaker: '', time: '', room: '', notes: '', status: 'Completed' }) });
  });
  await page.reload();
  await page.getByRole('button', { name: /Completed RSVP fixture/ }).click();
  await page.getByRole('button', { name: /CHRISTOPHER-JONATHAN MOBILE-REFLOW FIXTURE/ }).click();
  await page.locator('.inline-edit').getByRole('button', { name: 'YES', exact: true }).click();
  await expect(page.locator('.rsvp-chip.yes').filter({ hasText: 'CHRISTOPHER-JONATHAN' })).toBeVisible();
  await page.locator('.inline-edit').getByRole('button', { name: 'CLEAR', exact: true }).click();
  await expect(page.locator('.rsvp-chip.pending').filter({ hasText: 'CHRISTOPHER-JONATHAN' })).toBeVisible();
});

test('an unmapped legacy column cannot duplicate an explicitly mapped event', async ({ page }) => {
  await page.route('**/api/events', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.memberFields.push({ id: 'fldLegacyRsvp', name: 'SEP12-COMMUNITY RSVP', type: 'singleSelect' });
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await expect(page.locator('.event-card').filter({ hasText: 'Community Leadership with a Very Long Fixture Speaker Name' })).toHaveCount(1);
});
