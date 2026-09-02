import { expect, test } from '@playwright/test';

async function loginAsMember(page) {
  await page.goto('/index.html');
  await page.evaluate(async () => {
    await window.Harumphers.loginMember(42001);
  });
}

for (const width of [320, 375, 390, 414]) {
  for (const textScale of [1, 1.5, 2]) {
    test(`directory detail reflows at ${width}px and ${textScale * 100}% text`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      await loginAsMember(page);
      await page.goto('/directory.html');
      await page.evaluate(scale => {
        document.documentElement.style.webkitTextSizeAdjust = `${scale * 100}%`;
        document.documentElement.style.textSizeAdjust = `${scale * 100}%`;
      }, textScale);

      await expect(page.getByText('CHRISTOPHER-JONATHAN MOBILE-REFLOW FIXTURE')).toBeVisible();
      await page.getByText('CHRISTOPHER-JONATHAN MOBILE-REFLOW FIXTURE').first().click();
      await expect(page.locator('#overlay')).toHaveClass(/open/);

      const overflow = await page.evaluate(() => {
        const selectors = ['html', 'body', '#overlay', '#detail', '.detail-name', '.detail-actions', '.detail-btn'];
        return selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => ({
          selector,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          left: element.getBoundingClientRect().left,
          right: element.getBoundingClientRect().right
        }))).filter(item => item.scrollWidth > item.clientWidth + 1 || item.left < -1 || item.right > innerWidth + 1);
      });
      expect(overflow).toEqual([]);
      await expect(page.locator('.detail-close')).toBeVisible();
      await expect(page.locator('.detail-btn-label')).toHaveCount(textScale ? 4 : 4);
    });
  }
}
