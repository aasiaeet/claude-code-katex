// Browser check of vendor/links.js. Run: node test/links-harness.mjs
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n     ' + detail));
  if (!ok) failures++;
}

const browser = await chromium.launch();
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
page.on('pageerror', (e) => { console.log('PAGE ERROR', e.message); failures++; });
await page.goto('file://' + path.join(here, 'harness', 'links.html'));

await page.hover('#abs');
check('hover shows the full, decoded path', (await page.getAttribute('#abs', 'title')) === '/home/amir/repo/paper v2/main.pdf',
  await page.getAttribute('#abs', 'title'));
await page.hover('#rel');
check('hover keeps the line number', (await page.getAttribute('#rel', 'title')) === 'code/fit.R:12', await page.getAttribute('#rel', 'title'));
await page.hover('#web');
check('web links get no path tooltip', (await page.getAttribute('#web', 'title')) === null, 'titled');

await page.click('#abs', { button: 'right' });
const m = await page.evaluate(() => ({
  items: [...document.querySelectorAll('.ccl-item')].map((a) => [a.textContent, a.getAttribute('href')]),
  claude: window.claudeMenus.slice(),
}));
const base = 'vscode://aasiaeet.claude-code-annotate/link?action=';
const p = encodeURIComponent('/home/amir/repo/paper v2/main.pdf');
check('right-click on a file link opens our menu, not Claude\'s', m.items.length === 6 && m.claude.length === 0, JSON.stringify(m));
check('menu actions are vscode:// links to the handler',
  JSON.stringify(m.items.slice(0, 4)) === JSON.stringify([
    ['Open', base + 'open&path=' + p], ['Open with system app', base + 'system&path=' + p],
    ['Reveal in sidebar', base + 'reveal&path=' + p], ['Open containing folder', base + 'folder&path=' + p]]),
  JSON.stringify(m.items));

await page.click('.ccl-item >> text=Copy full path');
check('Copy full path copies the decoded path', (await page.evaluate(() => navigator.clipboard.readText())) === '/home/amir/repo/paper v2/main.pdf',
  await page.evaluate(() => navigator.clipboard.readText()));
check('menu closes after an action', (await page.$('.ccl-menu')) === null, 'still open');

await page.click('#rel', { button: 'right' });
await page.click('.ccl-item >> text=Open');
const fwd = await page.evaluate(() => window.forwarded.slice());
check('clicking a menu action reaches VS Code\'s link forwarder, with the line',
  JSON.stringify(fwd) === JSON.stringify([base + 'open&path=' + encodeURIComponent('code/fit.R') + '&line=12']), JSON.stringify(fwd));
await page.waitForTimeout(20);
check('menu closes after a forwarded action', (await page.$('.ccl-menu')) === null, 'still open');

await page.click('#abs', { button: 'right' });
await page.keyboard.press('Escape');
check('Esc closes the menu', (await page.$('.ccl-menu')) === null, 'still open');

await page.click('#web', { button: 'right' });
const web = await page.evaluate(() => ({ menu: !!document.querySelector('.ccl-menu'), claude: window.claudeMenus.slice() }));
check('web links keep Claude\'s own menu', !web.menu && JSON.stringify(web.claude) === '["web"]', JSON.stringify(web));

await browser.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
