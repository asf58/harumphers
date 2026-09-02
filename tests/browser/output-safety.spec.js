import { expect, test } from '@playwright/test';

const ATTACK = `<img data-fixture-xss src=x onerror="window.fixtureXss=true">`;

test.use({ serviceWorkers: 'block' });

async function login(page, type = 'guest') {
  await page.goto('/index.html');
  await page.evaluate(async value => {
    if (value === 'admin') await window.Harumphers.loginAdmin('fixture-admin-password');
    else if (value === 'member') await window.Harumphers.loginMember(42001);
    else await window.Harumphers.loginGuest('fixture-guest-phrase');
  }, type);
}

async function expectAttackRenderedAsText(page, expectedText = ATTACK) {
  await expect(page.locator('[data-fixture-xss]')).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureXss === true)).toBe(false);
  await expect(page.locator('body')).toContainText(expectedText);
}

test('directory treats Airtable names and image URLs as untrusted display data', async ({ page }) => {
  await page.route('**/api/directory', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ records: [{
      id: 'recFixtureHostile1',
      fields: {
        'FULL NAME': ATTACK,
        'CELL #': '',
        'E-MAIL ADDRESS': '',
        PHOTO: [{ url: 'javascript:window.fixtureXss=true' }]
      }
    }] })
  }));
  await login(page, 'guest');
  await page.goto('/directory.html');

  await expectAttackRenderedAsText(page);
  await expect(page.locator('img[src^="javascript:"]')).toHaveCount(0);
});

test('event cards render hostile event content as text', async ({ page }) => {
  await page.route('**/api/events', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      memberFields: [],
      events: [{
        id: 'recFixtureHostile1',
        fields: {
          'EVENT NAME': ATTACK,
          SPEAKER: ATTACK,
          NOTES: ATTACK,
          Status: 'Suggested',
          'SETUP STATE': 'ready',
          'SPEAKER PHOTO': [{ url: 'data:image/svg+xml,<svg onload=window.fixtureXss=true>' }]
        }
      }],
      members: [], photos: [], attendance: [], votes: []
    })
  }));
  await login(page, 'guest');
  await page.goto('/events.html');

  await expectAttackRenderedAsText(page);
  await expect(page.locator('img[src^="data:image/svg"]')).toHaveCount(0);
});

test('member profile fields do not create executable markup', async ({ page }) => {
  await page.route('**/api/me', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'recFixtureMember1',
      fields: {
        'FULL NAME': ATTACK,
        'CELL #': '412-555-0101',
        'E-MAIL ADDRESS': 'fixture@example.test',
        PHOTO: [{ url: 'javascript:window.fixtureXss=true' }]
      }
    })
  }));
  await login(page, 'member');
  await page.goto('/index.html');

  await expectAttackRenderedAsText(page, '<img');
  await expect(page.locator('img[src^="javascript:"]')).toHaveCount(0);
});

test('administrator member requests and dropdown names stay inert', async ({ page }) => {
  await page.route('**/api/admin/member-requests', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      requests: [{
        id: 'recFixtureReqst01',
        fields: {
          'SUBMITTED NAME': ATTACK,
          'SUBMITTED MEMBER #': 42099,
          STATUS: 'Pending',
          'SUBMITTED DATE': '2026-08-26'
        }
      }],
      members: [{
        id: 'recFixtureMember1',
        fields: { 'FULL NAME': ATTACK, 'MEMBER #': 42001 }
      }]
    })
  }));
  await login(page, 'admin');
  await page.goto('/index.html');
  await expect(page.locator('.request-card')).toBeVisible();
  await page.locator('.member-search-input').focus();

  await expectAttackRenderedAsText(page);
});
