import { expect, test } from '@playwright/test';

test('the installed app shell works offline from the GitHub Pages subpath', async ({ page, context, browserName }) => {
  await page.goto('/harumphers/index.html');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  const cachedPages = await page.evaluate(async () => Promise.all(
    ['./index.html', './directory.html', './events.html'].map(async path => {
      const response = await caches.match(path);
      return response?.text();
    })
  ));

  expect(cachedPages[0]).toContain('<title>HARUMPHERS Directory</title>');
  expect(cachedPages[1]).toContain('<title>HARUMPHERS Directory</title>');
  expect(cachedPages[2]).toContain('<title>HARUMPHERS Events</title>');

  // Playwright's WebKit offline mode blocks page fetches before Safari's service worker
  // sees them. Chromium can additionally exercise the end-to-end offline fetch path.
  if (browserName === 'chromium') {
    const offlinePage = await page.evaluate(() => fetch('./directory.html').then(response => response.text()));
    expect(offlinePage).toContain('<title>HARUMPHERS Directory</title>');
  }
});
