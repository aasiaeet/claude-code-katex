// End-to-end check of vendor/annotate.js in headless Chromium, with trusted
// mouse and keyboard input. Run: node test/annotate-harness.mjs
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = 'file://' + path.join(here, 'harness', 'annotate.html');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n     ' + detail));
  if (!ok) failures++;
}

// Viewport point at character `offset` of the first text node under `sel`
// (or the element's box center / edges when `where` says so).
async function point(page, sel, where) {
  return page.evaluate(([sel, where]) => {
    const el = document.querySelector(sel);
    if (where.char !== undefined) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const t = walker.nextNode();
      const r = document.createRange();
      r.setStart(t, where.char); r.setEnd(t, where.char + 1);
      const b = r.getBoundingClientRect();
      return { x: b.left + 1, y: b.top + b.height / 2 };
    }
    const b = el.getBoundingClientRect();
    if (where.edge === 'mid') return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    return { x: b.right - 2, y: b.top + b.height / 2 };
  }, [sel, where]);
}

async function drag(page, a, b) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
}

const composerText = (page) => page.$eval('[aria-label="Message input"]', (el) => el.textContent); // what Claude Code reads

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
page.on('pageerror', (e) => { console.log('PAGE ERROR', e.message); failures++; });
await page.goto(url);

// 1. Selection from plain text into the middle of an inline equation.
{
  const a = await point(page, '#p1', { char: 4 });                 // "density"
  const b = await point(page, '#p1 .katex:first-of-type .katex-html', { edge: 'mid' });
  await drag(page, a, b);
  check('pop-up opens on selection', await page.$('.cca-pop') !== null, 'no .cca-pop');
  const box = await page.$eval('.cca-pop textarea', (t) => ({ w: t.offsetWidth, rows: t.rows, buttons: document.querySelectorAll('.cca-pop button').length }));
  check('one-line, 190px box, no buttons', box.w === 190 && box.rows === 1 && box.buttons === 0, JSON.stringify(box));
  const ctrlC = await page.evaluate(() => window.getSelection().toString().length > 0);
  check('message selection survives while pop-up is open (Ctrl+C still works)', ctrlC, 'selection collapsed');
  await page.keyboard.type('why this normalizer?');               // first key moves focus into the note
  const note = await page.$eval('.cca-pop textarea', (t) => t.value);
  check('typing goes into the note', note === 'why this normalizer?', JSON.stringify(note));
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line');
  const grown = await page.$eval('.cca-pop textarea', (t) => t.offsetHeight > t.scrollHeight - 4 && t.value.includes('\n'));
  check('Shift+Enter adds a line and the box grows to fit', grown, 'did not grow');
  await page.keyboard.press('Enter');
  const text = await composerText(page);
  const want = 'Annotation 1:\n> density is $p(x \\mid \\mu, \\sigma^2) = \\frac{1}{\\sqrt{2\\pi\\sigma^2}}$\nMy comment:\nwhy this normalizer?\nsecond line';
  check('quote snaps to whole equation, TeX restored, note appended', text.trim() === want, JSON.stringify(text));
  const events = await page.evaluate(() => window.inputEvents);
  check('prompt box got a real input event (React onInput fires)',
    events.length > 0 && events[events.length - 1].type === 'insertText', JSON.stringify(events));
  check('pop-up closed after adding', await page.$('.cca-pop') === null, 'still open');
}

// 2. Multi-paragraph selection across a display equation; appended as a
//    second block with a blank line between.
{
  const a = await point(page, '#p2', { char: 2 });
  const b = await point(page, '#p3', { char: 7 });
  await drag(page, a, b);
  await page.click('.cca-pop textarea');
  await page.keyboard.type('check this identity');
  await page.keyboard.press('Enter');
  const text = await composerText(page);
  const second = text.slice(text.indexOf('Annotation 2:')).trim();
  check('exactly one blank line between annotations', /normalizer\?\nsecond line\n\nAnnotation 2:/.test(text), JSON.stringify(text));
  const want = [
    'Annotation 2:',
    '> second paragraph before the display.',
    '>',
    '> $$\\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6}$$',
    '>',
    '> Closing',
    'My comment:',
    'check this identity',
  ].join('\n');
  check('display math and paragraph breaks preserved in second note', second === want,
    JSON.stringify(second) + '\n     want ' + JSON.stringify(want));
}

// 2b. Enter with nothing typed adds the quote alone; numbering continues
//     from the highest number present even after the user deletes one.
{
  await page.$eval('[aria-label="Message input"]', (el) => {
    el.textContent = el.textContent.replace(/^Annotation 1:[\s\S]*?(?=Annotation 2:)/, '');
  });
  const a = await point(page, '#p3', { char: 0 });
  const b = await point(page, '#p3', { char: 6 });
  await drag(page, a, b);
  await page.keyboard.press('Enter');
  const text = await composerText(page);
  check('Enter before typing adds quote only, numbered 3 after deleting 1',
    /identity\n\nAnnotation 3:\n> Closin\s*$/.test(text) && !/Annotation 1:/.test(text), JSON.stringify(text));
}

// 2c. Label lines are painted bold in the prompt box and in sent messages.
{
  await page.waitForTimeout(50);
  const labels = await page.evaluate(() => {
    const h = CSS.highlights.get('cca-label');
    return h ? [...h].map((r) => r.toString() + '@' + (r.startContainer.parentElement.closest('[id]')?.id || r.startContainer.parentElement.getAttribute('aria-label'))) : [];
  });
  const want = ['Annotation 7:@sent', 'My comment:@sent', 'Annotation 2:@Message input', 'My comment:@Message input', 'Annotation 3:@Message input'];
  check('labels highlighted in prompt box and sent message', JSON.stringify(labels.sort()) === JSON.stringify(want.sort()), JSON.stringify(labels));
  const quoteNotLabel = labels.every((l) => !l.startsWith('>'));
  check('quote lines are not painted as labels', quoteNotLabel, JSON.stringify(labels));
}

// 3. Selecting in the user's own message or the prompt box does nothing.
{
  const a = await point(page, '#user', { char: 0 });
  const b = await point(page, '#user', { char: 10 });
  await drag(page, a, b);
  check('no pop-up on the user\'s own message', await page.$('.cca-pop') === null, 'pop-up opened');
}

// 4. Esc cancels without touching the prompt box.
{
  const before = await composerText(page);
  const a = await point(page, '#p3', { char: 0 });
  const b = await point(page, '#p3', { char: 12 });
  await drag(page, a, b);
  await page.keyboard.press('Escape');
  check('Esc closes the pop-up', await page.$('.cca-pop') === null, 'still open');
  check('Esc leaves the prompt box unchanged', (await composerText(page)) === before, 'changed');
}

// 5. Highlights painted for noted spans; cleared when the prompt is sent
//    (Claude Code empties the box on send).
{
  const n = await page.evaluate(() => CSS.highlights.get('cca-noted')?.size ?? 0);
  check('noted spans highlighted', n === 3, 'size ' + n);
  await page.$eval('[aria-label="Message input"]', (el) => { el.textContent = ''; });
  await page.waitForTimeout(50);
  const m = await page.evaluate(() => CSS.highlights.get('cca-noted')?.size ?? 0);
  check('highlights cleared after send', m === 0, 'size ' + m);
}

await page.screenshot({ path: path.join(here, '..', 'test-results', 'annotate.png') }).catch(() => {});
await browser.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
