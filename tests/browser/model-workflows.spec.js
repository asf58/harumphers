import path from 'node:path';
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ request }) => {
  const response = await request.post('/__fixtures/reset');
  expect(response.ok()).toBe(true);
});

async function login(page, role) {
  await page.goto('/index.html');
  await page.evaluate(async value => {
    if (value === 'admin') await window.Harumphers.loginAdmin('fixture-admin-password');
    else if (value === 'member') await window.Harumphers.loginMember(42001);
    else await window.Harumphers.loginGuest('fixture-guest-phrase');
  }, role);
}

test('member profile, RSVP, and suggested-event vote persist in the working model', async ({ page, browserName }) => {
  await login(page, 'member');
  await page.goto('/index.html');
  await expect(page.locator('.ws-name')).toContainText('Alex');

  await page.getByText('Edit info', { exact: true }).click();
  const updatedEmail = `alex.updated.${browserName}@example.test`;
  await page.getByLabel('Email', { exact: true }).fill(updatedEmail);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.locator('#profile-card')).toBeHidden();
  await page.getByText('Edit info', { exact: true }).click();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(updatedEmail);

  const scheduled = page.locator('.qe-card').filter({ hasText: 'Community Leadership' });
  await scheduled.getByRole('button', { name: 'MAYBE' }).click();
  await expect(scheduled.locator('.rsvp-pill')).toHaveText('MAYBE');

  const suggested = page.locator('.qe-card').filter({ hasText: 'Suggested Fixture Speaker' });
  await suggested.getByRole('button', { name: 'Interested', exact: true }).click();
  await expect(suggested.locator('.rsvp-pill')).toHaveText('INTERESTED');

  await page.reload();
  const persistedSuggested = page.locator('.qe-card').filter({ hasText: 'Suggested Fixture Speaker' });
  await expect(persistedSuggested.locator('.rsvp-pill')).toHaveText('INTERESTED');

  await page.evaluate(async () => window.Harumphers.loginGuest('fixture-guest-phrase'));
  await page.goto('/index.html');
  await expect(page.locator('.qe-card').filter({ hasText: 'Suggested Fixture Speaker' })).toContainText('1 up / 0 down');
});

test('a member marked as administrator keeps his identity and sees administrator event controls', async ({ page }) => {
  await page.goto('/index.html');
  await page.getByLabel('Password or Member number').fill('42002');
  await page.getByRole('button', { name: 'Enter' }).click();

  await expect(page.locator('.ws-name')).toContainText(/Christopher-Jonathan/i);
  await expect(page.getByText('You have admin access.')).toBeVisible();

  await page.goto('/events.html');
  await expect(page.getByRole('button', { name: '+ Add New Event' })).toBeVisible();
});

test('administrator can create, promote, complete, record attendance, and add a photo', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/events.html');

  await page.getByRole('button', { name: '+ Add New Event' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Working Model Dinner');
  await page.getByLabel('Date', { exact: true }).fill('2026-11-14');
  await page.getByLabel('Speaker', { exact: true }).fill('Casey Fixture');
  await page.getByLabel('Time', { exact: true }).fill('6:30 PM');
  await page.getByLabel('Room', { exact: true }).fill('Fixture Dining Room');
  await page.getByLabel('Notes', { exact: true }).fill('Created and exercised entirely in local fixture mode.');
  await page.getByLabel('Status', { exact: true }).selectOption('Scheduled');
  await page.getByRole('button', { name: 'Create Event' }).click();
  await expect(page.getByText('Working Model Dinner', { exact: true })).toBeVisible();

  const suggestedDisclosure = page.getByRole('button', { name: /Suggested Fixture Speaker/ });
  await suggestedDisclosure.click();
  const suggestedCard = page.locator('.event-card').filter({ hasText: 'Suggested Fixture Speaker' });
  await suggestedCard.getByRole('button', { name: 'Edit', exact: true }).click();
  await suggestedCard.locator('[id^="edit-date-"]').fill('2026-10-17');
  await suggestedCard.locator('[id^="edit-status-"]').selectOption('Scheduled');
  await suggestedCard.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(suggestedCard.locator('.event-status')).toHaveText('Scheduled');
  await expect(suggestedCard).toContainText('Not Responded');

  let dinnerCard = page.locator('.event-card').filter({ hasText: 'Working Model Dinner' });
  await dinnerCard.getByRole('button', { name: /Working Model Dinner/ }).click();
  await dinnerCard.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(dinnerCard.getByPlaceholder('Paste image URL')).toHaveCount(0);
  await dinnerCard.locator('[id^="edit-status-"]').selectOption('Completed');
  await dinnerCard.getByRole('button', { name: 'Save', exact: true }).click();
  dinnerCard = page.locator('.event-card').filter({ hasText: 'Working Model Dinner' });
  await expect(dinnerCard.locator('.event-status')).toHaveText('Completed');

  await dinnerCard.getByRole('button', { name: 'Record Attendance' }).click();
  await dinnerCard.locator('.attendance-row input[type="checkbox"]').first().check();
  await dinnerCard.getByRole('button', { name: 'Save Attendance' }).click();
  await expect(dinnerCard).toContainText('1 attended');

  const galleryUpload = dinnerCard.locator('.gallery-upload input[type="file"]');
  await galleryUpload.setInputFiles(path.resolve('icons/icon-192.png'));
  await expect(dinnerCard).toContainText('Photo Gallery (1)');

  await page.evaluate(async () => window.Harumphers.loginMember(42001));
  await page.goto('/events.html');
  dinnerCard = page.locator('.event-card').filter({ hasText: 'Working Model Dinner' });
  await dinnerCard.getByRole('button', { name: /Working Model Dinner/ }).click();
  await expect(dinnerCard).toContainText('1 attended');
});

test('missing member number request can be submitted and explicitly approved by an administrator', async ({ page }) => {
  await page.goto('/index.html');
  await page.getByLabel('Password or Member number').fill('42999');
  await page.getByRole('button', { name: 'Enter' }).click();
  await expect(page.getByRole('heading', { name: 'Member # Not Found' })).toBeVisible();
  await page.getByLabel('Your Full Name').fill('REQUEST FIXTURE');
  await page.getByRole('button', { name: 'Submit for Approval' }).click();
  await expect(page.getByRole('heading', { name: 'Request Submitted!' })).toBeVisible();

  await page.evaluate(async () => window.Harumphers.loginAdmin('fixture-admin-password'));
  await page.goto('/index.html');
  const requestCard = page.locator('.request-card').filter({ hasText: 'REQUEST FIXTURE' });
  await expect(requestCard).toBeVisible();
  await requestCard.locator('.member-search-input').focus();
  await requestCard.getByText('MORGAN ACCESSIBILITY FIXTURE').click();
  await requestCard.getByRole('button', { name: 'Approve & Link' }).click();
  await expect(requestCard).toHaveCount(0);
});
