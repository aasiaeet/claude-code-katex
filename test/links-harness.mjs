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
check('right-click on a file link opens our menu, not Claude\'s', m.items.length === 7 && m.claude.length === 0, JSON.stringify(m));
check('menu actions are vscode:// links to the handler',
  JSON.stringify(m.items.slice(0, 5)) === JSON.stringify([
    ['Open', base + 'open&path=' + p], ['Open in new VS Code window', base + 'window&path=' + p],
    ['Open with system app', base + 'system&path=' + p], ['Reveal in sidebar', base + 'reveal&path=' + p],
    ['Open containing folder', base + 'folder&path=' + p]]),
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

// Folder links: a left-click goes to the handler (and on to the file manager),
// not to Claude Code, which cannot open a folder.
// Real mouse clicks: Playwright's element click refuses when something
// covers the element, and covering it is the point here.
async function mouseClick(sel, button = 'left') {
  const b = await page.$eval(sel, (el) => { const r = el.getClientRects()[0]; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(b.x, b.y);
  await page.mouse.click(b.x, b.y, { button });
  await page.waitForTimeout(20);
}
const reset = () => page.evaluate(() => { window.forwarded = []; window.claudeOpens = []; });
await reset();
await mouseClick('#dir');
let r = await page.evaluate(() => ({ fwd: window.forwarded.slice(), claude: window.claudeOpens.slice() }));
check('left-click on a folder link goes to the handler, not to Claude Code',
  JSON.stringify(r.fwd) === JSON.stringify([base + 'open&path=' + encodeURIComponent('/home/amir/repo/paper/figs')]) && r.claude.length === 0,
  JSON.stringify(r));
await reset();
await mouseClick('#dirslash');
r = await page.evaluate(() => window.forwarded.slice());
check('a trailing slash also counts as a folder', JSON.stringify(r) === JSON.stringify([base + 'open&path=' + encodeURIComponent('results/')]), JSON.stringify(r));
await reset();
await mouseClick('#abs');
r = await page.evaluate(() => ({ fwd: window.forwarded.slice(), claude: window.claudeOpens.slice(), overlay: !!document.querySelector('.ccl-overlay') }));
check('file links still go to Claude Code on left-click', r.fwd.length === 0 && JSON.stringify(r.claude) === '["abs"]' && !r.overlay, JSON.stringify(r));
await mouseClick('#dir', 'right');
const folderMenu = await page.$$eval('.ccl-item', (as) => as.map((a) => a.getAttribute('href')));
check('right-click on a folder link still opens our menu', folderMenu[0] === base + 'open&path=' + encodeURIComponent('/home/amir/repo/paper/figs'),
  JSON.stringify(folderMenu));
await page.keyboard.press('Escape');
await page.mouse.move(2, 2);
check('the click-taker goes away when the mouse leaves the link', (await page.$('.ccl-overlay')) === null, 'still there');

// vscode://file links (VS Code's own file URLs) are file links too.
await page.hover('#vsfile');
check('vscode://file link: hover shows the path, line kept, column dropped',
  (await page.getAttribute('#vsfile', 'title')) === '/home/amir/repo/causal-gan/paper/main.tex:42', await page.getAttribute('#vsfile', 'title'));
await page.keyboard.press('Escape');
await mouseClick('#vsdir', 'right');
const vsMenu = await page.$$eval('.ccl-item', (as) => as.map((a) => [a.textContent, a.getAttribute('href')]));
const vsPath = encodeURIComponent('/home/amir/repo/causal-gan');
check('vscode://file link: right-click shows our menu, with Open containing folder and Open in new VS Code window',
  vsMenu.some(([t, h]) => t === 'Open containing folder' && h === base + 'folder&path=' + vsPath) &&
  vsMenu.some(([t, h]) => t === 'Open in new VS Code window' && h === base + 'window&path=' + vsPath), JSON.stringify(vsMenu));
await page.keyboard.press('Escape');
await reset();
await mouseClick('#vsdir');
r = await page.evaluate(() => ({ fwd: window.forwarded.slice(), claude: window.claudeOpens.slice() }));
check('left-click on a vscode://file folder link opens it as a VS Code workspace',
  JSON.stringify(r.fwd) === JSON.stringify([base + 'window&path=' + vsPath]) && r.claude.length === 0, JSON.stringify(r));
await reset();
await mouseClick('#vsfile');
r = await page.evaluate(() => window.forwarded.slice());
check('left-click on a vscode://file file link opens it at its line',
  JSON.stringify(r) === JSON.stringify([base + 'window&path=' + encodeURIComponent('/home/amir/repo/causal-gan/paper/main.tex') + '&line=42']), JSON.stringify(r));

await browser.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
