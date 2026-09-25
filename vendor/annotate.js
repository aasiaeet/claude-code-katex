/* Annotation pop-up (opt-in, claudeCodeKatex.annotate): select text in a
 * Claude reply, type a note in the pop-up, and the quoted span plus the note
 * are inserted into the prompt box.
 *
 * Plain DOM code prepended to Claude Code's webview bundle. It never touches
 * React state directly: the prompt box is a contentEditable="plaintext-only"
 * div whose React onInput handler reads textContent, so the note goes in as a
 * text node followed by an input event (see insertIntoComposer). */
(function () {
  if (window.__CCA_LOADED) return;
  window.__CCA_LOADED = true;

  var COMPOSER = '[role="textbox"][aria-label="Message input"]';
  // CSS-module class names carry a per-build hash suffix; match on the prefix.
  var SCOPE = '[class*="messagesContainer_"]';
  var EXCLUDE = '[class*="userMessage_"],[contenteditable],textarea,input,.cca-pop';
  var HL_NOTED = 'cca-noted';
  var HL_PENDING = 'cca-pending';
  var HL_LABEL = 'cca-label';
  // Label lines drawn bold in the prompt box and in sent messages.
  var LABEL_RE = /^(?:Annotation \d+:|My comment:)[ \t]*$/gm;

  var pop = null;       // the open pop-up, if any
  var popRange = null;  // the range the open pop-up annotates
  var noted = [];       // ranges already sent to the prompt box

  function closestEl(node, sel) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el ? el.closest(sel) : null;
  }

  function supportsHighlights() {
    return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
  }

  function paint() {
    if (!supportsHighlights()) return;
    noted = noted.filter(function (r) { return r.startContainer.isConnected && r.endContainer.isConnected; });
    var h = new Highlight();
    noted.forEach(function (r) { h.add(r); });
    CSS.highlights.set(HL_NOTED, h);
    if (popRange) CSS.highlights.set(HL_PENDING, new Highlight(popRange));
    else CSS.highlights.delete(HL_PENDING);
  }

  // Outermost rendered-math element containing node: a display block when
  // there is one, else the inline .katex span.
  function mathAncestor(node) {
    return closestEl(node, '.katex-display') || closestEl(node, '.katex');
  }

  // Widen the range so it never cuts through an equation.
  function snapToMath(range) {
    var s = mathAncestor(range.startContainer);
    var e = mathAncestor(range.endContainer);
    if (s) range.setStartBefore(s);
    if (e) range.setEndAfter(e);
    return range;
  }

  function texOf(el) {
    var a = el.querySelector('annotation[encoding="application/x-tex"]');
    return a ? a.textContent.trim() : el.textContent;
  }

  // The selection as Markdown-ish text with every equation back in TeX source.
  function quoteOf(range) {
    var frag = range.cloneContents();
    var host = document.createElement('div');
    host.className = 'cca-measure';
    host.appendChild(frag);
    host.querySelectorAll('.katex-display').forEach(function (el) {
      var d = document.createElement('div');
      d.textContent = '$$' + texOf(el) + '$$';
      el.replaceWith(d);
    });
    host.querySelectorAll('.katex').forEach(function (el) {
      el.replaceWith(document.createTextNode('$' + texOf(el) + '$'));
    });
    // innerText honors block layout (paragraph and list breaks), which
    // textContent drops, so the host must be rendered, just off-screen.
    document.body.appendChild(host);
    var text = host.innerText;
    host.remove();
    return text.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function annotatableRange() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    if (!closestEl(range.commonAncestorContainer, SCOPE)) return null;
    if (closestEl(range.startContainer, EXCLUDE) || closestEl(range.endContainer, EXCLUDE)) return null;
    if (!sel.toString().trim()) return null;
    return snapToMath(range.cloneRange());
  }

  function place() {
    if (!pop || !popRange) return;
    var rect = popRange.getBoundingClientRect();
    var rects = popRange.getClientRects();
    var first = rects.length ? rects[0] : rect;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    // The box sizes itself (auto-grow, drag handle), so read its size back.
    var w = pop.offsetWidth;
    var h = pop.offsetHeight;
    var left = Math.max(8, Math.min(first.left, vw - w - 8));
    var top = first.top - h - 6;
    if (top < 8) top = rect.bottom + 6;
    top = Math.max(8, Math.min(top, vh - h - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function closePop() {
    if (pop) pop.remove();
    pop = null;
    popRange = null;
    paint();
  }

  function composer() {
    return document.querySelector(COMPOSER);
  }

  // Claude Code reads the prompt box with textContent, so newlines must be
  // literal "\n" characters in text nodes (the box is white-space: pre-wrap).
  // execCommand('insertText') would turn them into <div> blocks, which
  // textContent drops. This mirrors Claude Code's own insert helper: put a
  // text node in, move the caret after it, and fire the input event its
  // React onInput handler listens for.
  function insertIntoComposer(text) {
    var box = composer();
    if (!box) return false;
    box.focus();
    // Replace everything after the last non-blank character, so exactly one
    // blank line separates the note from what came before.
    var r = document.createRange();
    r.selectNodeContents(box);
    var walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    var last = null, t;
    while ((t = walker.nextNode())) if (/\S/.test(t.data)) last = t;
    if (last) r.setStart(last, last.data.replace(/\s+$/, '').length);
    var data = (last ? '\n\n' : '') + text;
    r.deleteContents();
    var node = document.createTextNode(data);
    r.insertNode(node);
    r.setStartAfter(node);
    r.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: data }));
    return true;
  }

  // Next number is one past the highest "Annotation N:" already in the
  // prompt box, so deleting or reordering notes before sending is harmless.
  function nextNumber() {
    var box = composer();
    var text = box ? box.textContent : '';
    var re = /^Annotation (\d+):/gm, m, max = 0;
    while ((m = re.exec(text))) max = Math.max(max, +m[1]);
    return max + 1;
  }

  function formatNote(n, quote, note) {
    var q = quote.split('\n').map(function (l) { return l ? '> ' + l : '>'; }).join('\n');
    var head = 'Annotation ' + n + ':\n' + q + '\n';
    return note.trim() ? head + 'My comment:\n' + note.trim() + '\n' : head;
  }

  function save() {
    if (!pop || !popRange) return;
    var note = pop.querySelector('textarea').value;
    var range = popRange;
    var text = formatNote(nextNumber(), quoteOf(range), note);
    closePop();
    if (insertIntoComposer(text)) {
      noted.push(range);
    } else {
      // No prompt box, or the browser refused the edit: hand the text over
      // through the clipboard so nothing typed is lost.
      try { navigator.clipboard.writeText(text); } catch (e) {}
      flash('Could not reach the prompt box; the note was copied to the clipboard.');
    }
    paint();
  }

  function flash(msg) {
    var t = document.createElement('div');
    t.className = 'cca-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  function openPop(range) {
    closePop();
    popRange = range;
    pop = document.createElement('div');
    pop.className = 'cca-pop';
    pop.innerHTML = '<textarea rows="1" placeholder="Note (Enter to add)"></textarea>';
    document.body.appendChild(pop);
    var ta = pop.querySelector('textarea');
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); closePop(); }
      e.stopPropagation();
    });
    // Grow with the text; Shift+Enter adds lines.
    ta.addEventListener('input', function () {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 2 + 'px';
      place();
    });
    pop.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    pop.addEventListener('mouseup', function (e) { e.stopPropagation(); });
    place();
    paint();
    // Focus is left on the message selection so Ctrl+C still copies it; the
    // first typed character moves focus into the note (see onKeyDown).
  }

  function onMouseUp(e) {
    if (e.button !== 0) return;
    // Let the browser finish updating the selection first.
    setTimeout(function () {
      var range = annotatableRange();
      if (!range) return;
      if (pop && pop.querySelector('textarea').value.trim()) return; // keep a note in progress
      openPop(range);
    }, 0);
  }

  function onMouseDown(e) {
    if (!pop || pop.contains(e.target)) return;
    if (pop.querySelector('textarea').value.trim()) return;
    closePop();
  }

  // Capture phase, so this runs before any handler in Claude Code's UI that
  // would redirect typing to the prompt box.
  function onKeyDown(e) {
    if (!pop) return;
    var ta = pop.querySelector('textarea');
    if (document.activeElement === ta) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+C etc. act on the selection
    if (e.key === 'Enter' && !e.shiftKey) {
      // Enter before typing anything: add the quote with no note.
      e.preventDefault();
      e.stopPropagation();
      save();
    } else if (e.key.length === 1) {
      e.stopPropagation();
      ta.focus(); // the key's default action now lands in the note
    }
  }

  // Both surfaces are plain text (the prompt box, and sent messages, which
  // Claude Code renders with plainText), so "bold" is a highlight painted over
  // the label lines. The prompt box shows its text through a mirror layer on
  // top of a transparent contentEditable; paint the mirror when it exists.
  function paintLabels() {
    if (!supportsHighlights()) return;
    var roots = [document.querySelector('[class*="mentionMirror_"]') || composer()];
    document.querySelectorAll('[class*="userMessage_"]').forEach(function (el) { roots.push(el); });
    var h = new Highlight();
    roots.forEach(function (root) {
      if (!root) return;
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n, m;
      while ((n = walker.nextNode())) {
        LABEL_RE.lastIndex = 0;
        while ((m = LABEL_RE.exec(n.data))) {
          var r = document.createRange();
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          h.add(r);
        }
      }
    });
    CSS.highlights.set(HL_LABEL, h);
  }

  var labelsQueued = false;
  function queueLabels() {
    if (labelsQueued) return;
    labelsQueued = true;
    requestAnimationFrame(function () { labelsQueued = false; paintLabels(); });
  }

  // Clear the "already noted" marks once the prompt has been sent, which
  // empties the prompt box.
  function onInput(e) {
    var box = closestEl(e.target, COMPOSER);
    if (box && !box.textContent.trim() && noted.length) { noted = []; paint(); }
  }

  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('input', onInput, true);
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
  // Sending a prompt empties the box without an input event in some builds.
  new MutationObserver(function () {
    var box = composer();
    if (box && !box.textContent.trim() && noted.length) { noted = []; paint(); }
    queueLabels();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.__CCA = { quoteOf: quoteOf, formatNote: formatNote, insertIntoComposer: insertIntoComposer };
})();
