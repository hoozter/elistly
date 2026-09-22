import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../worker/node_modules/playwright/index.mjs';

const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setContent('<html><body><button class="btn btn-secondary">Reference</button><input type="file" multiple><input type="file" disabled></body></html>');
  await page.addStyleTag({ content: css });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      const styles = await page.evaluate(() => {
        const button = getComputedStyle(document.querySelector('button'));
        const input = document.querySelector('input');
        const picker = getComputedStyle(input, '::file-selector-button');
        const disabled = getComputedStyle(document.querySelector('input:disabled'), '::file-selector-button');
        input.focus();
        return { button: [button.backgroundColor, button.color, button.borderRadius, button.minHeight], picker: [picker.backgroundColor, picker.color, picker.borderRadius, picker.minHeight], disabled: disabled.cursor, focus: getComputedStyle(input).outlineStyle, fits: input.getBoundingClientRect().right <= innerWidth };
      });
      assert.deepEqual(styles.picker, styles.button, `${theme}/${width}: picker matches ordinary secondary button`);
      assert.equal(styles.disabled, 'not-allowed');
      assert.equal(styles.focus, 'solid');
      assert.ok(styles.fits);
    }
  }
  console.log('PASS: shared file picker styling, light/dark, desktop/mobile, focus and disabled states');
} finally { await browser.close(); }
