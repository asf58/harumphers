import { expect, test } from '@playwright/test';

async function openAdminEventForm(page) {
  await page.goto('/index.html');
  await page.evaluate(async () => {
    await window.Harumphers.loginAdmin('fixture-admin-password');
  });
  await page.goto('/events.html');
  await page.getByRole('button', { name: '+ Add New Event' }).click();
  await expect(page.getByRole('heading', { name: 'Add New Event' })).toBeVisible();
}

for (const width of [320, 375, 390, 414]) {
  for (const textScale of [1, 1.5, 2]) {
    test(`Add Event form stays in ${width}px at ${textScale * 100}% text`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      await openAdminEventForm(page);
      await page.evaluate(scale => {
        document.documentElement.style.webkitTextSizeAdjust = `${scale * 100}%`;
        document.documentElement.style.textSizeAdjust = `${scale * 100}%`;
      }, textScale);

      const result = await page.evaluate(() => {
        const form = document.querySelector('.new-event-form');
        const controls = [...form.querySelectorAll('input, select, button, .new-event-label, .new-event-hint, .new-event-checkbox')];
        const formRect = form.getBoundingClientRect();
        return {
          documentOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          offenders: controls.map(element => {
            const rect = element.getBoundingClientRect();
            return { id: element.id || element.className, left: rect.left, right: rect.right };
          }).filter(item => item.left < formRect.left - 1 || item.right > formRect.right + 1 || item.left < -1 || item.right > innerWidth + 1)
        };
      });
      expect(result).toEqual({ documentOverflows: false, offenders: [] });
      await expect(page.locator('.new-event-form')).toContainText('Create Event');
    });
  }
}
