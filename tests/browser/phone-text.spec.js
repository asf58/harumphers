import { expect, test } from '@playwright/test';

for (const width of [320, 390, 844]) {
  test(`main screens and admin controls reflow at ${width}px with 200% text`, async ({ page, request }) => {
    await request.post('/__fixtures/reset');
    await page.setViewportSize({ width, height: width === 844 ? 390 : 844 });
    await page.goto('/index.html');
    await page.evaluate(() => Harumphers.loginMember(42002));
    const check = async () => {
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      expect(await page.locator('header a, #top-bar a').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(28);
      for (const control of await page.locator('.rsvp-btn, .rsvp-chip.clickable').all()) {
        await expect.poll(() => control.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(28);
      }
      const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => {
        const r = el.getBoundingClientRect();
        return r.width && r.height && getComputedStyle(el).visibility !== 'hidden' && (r.left < -1 || r.right > innerWidth + 1);
      }).map(el => ({ tag: el.tagName, cls: el.className, id: el.id })).slice(0, 15));
      expect(overflow).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    };
    await page.reload();
    await expect(page.locator('#member-home')).toBeVisible();
    await check();
    await page.goto('/events.html');
    await page.getByRole('button', { name: /Community Leadership/ }).click();
    await page.getByRole('button', { name: /CHRISTOPHER-JONATHAN MOBILE-REFLOW FIXTURE/ }).click();
    await check();
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await check();
    await page.goto('/directory.html');
    await page.getByText('CHRISTOPHER-JONATHAN MOBILE-REFLOW FIXTURE').first().click();
    await check();
  });
}
