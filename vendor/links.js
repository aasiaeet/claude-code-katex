/* File links in Claude's replies: hover shows the full path, right-click
 * opens a menu (Open, Open with system app, Reveal in sidebar, Open
 * containing folder, Copy full path, Copy link) in place of Claude Code's
 * "Copy Link".
 *
 * The webview can only message Claude Code's own extension, so menu actions
 * that need VS Code are real <a href="vscode://..."> links handled by this
 * extension's URI handler. VS Code forwards a link click from a webview only
 * when it is a genuine user click, and the menu lives outside Claude Code's
 * React tree, so nothing stops that click on its way. */
(function () {
  if (window.__CCL_LOADED) return;
  window.__CCL_LOADED = true;

  var SCOPE = '[class*="messagesContainer_"]';
  var HANDLER = 'vscode://aasiaeet.claude-code-annotate/link';
  var menu = null;

  // The file a link points at, or null for web links and anchors. Mirrors
  // Claude Code's own parsing: "path", "path:12", "path:12-20", "path#L12".
  function fileTarget(a) {
    var href = a.getAttribute('href') || '';
    if (/^(https?|mailto|vscode|command):/i.test(href) || href.charAt(0) === '#' || !href) return null;
    if (/^file:\/\//i.test(href)) href = href.replace(/^file:\/\//i, '');
    var line = null;
    var m = /^(.*?)(?:[:#]L?(\d+)(?:-L?\d+)?)$/.exec(href);
    if (m && m[1]) { href = m[1]; line = +m[2]; }
    var p;
    try { p = decodeURIComponent(href); } catch (e) { return null; }
    if (/[\x00-\x1f]/.test(p)) return null;
    return { path: p, line: line, href: a.getAttribute('href') };
  }

  function linkAt(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    var a = el && el.closest('a[href]');
    return a && a.closest(SCOPE) ? a : null;
  }

  function actionUrl(action, t) {
    var q = 'action=' + action + '&path=' + encodeURIComponent(t.path);
    if (t.line) q += '&line=' + t.line;
    return HANDLER + '?' + q;
  }

  function copy(text) {
    try { navigator.clipboard.writeText(text); } catch (e) {}
  }

  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
  }

  function item(label, opts) {
    var a = document.createElement('a');
    a.className = 'ccl-item';
    a.textContent = label;
    if (opts.url) {
      a.href = opts.url;
      // Let the click travel on to VS Code's link forwarder; only tidy up.
      a.addEventListener('click', function () { setTimeout(closeMenu, 0); });
    } else {
      a.href = '#';
      a.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        opts.run();
        closeMenu();
      });
    }
    return a;
  }

  function openMenu(t, x, y) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'ccl-menu';
    menu.setAttribute('role', 'menu');
    menu.appendChild(item('Open', { url: actionUrl('open', t) }));
    menu.appendChild(item('Open with system app', { url: actionUrl('system', t) }));
    menu.appendChild(item('Reveal in sidebar', { url: actionUrl('reveal', t) }));
    menu.appendChild(item('Open containing folder', { url: actionUrl('folder', t) }));
    var sep = document.createElement('div');
    sep.className = 'ccl-sep';
    menu.appendChild(sep);
    menu.appendChild(item('Copy full path', { run: function () { copy(t.path); } }));
    menu.appendChild(item('Copy link', { run: function () { copy(t.href); } }));
    document.body.appendChild(menu);
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    menu.style.left = Math.max(4, Math.min(x, vw - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, vh - menu.offsetHeight - 4)) + 'px';
  }

  // Capture phase on window: runs before Claude Code's React handler, which
  // would open its own "Copy Link" menu.
  window.addEventListener('contextmenu', function (e) {
    var a = linkAt(e.target);
    var t = a && fileTarget(a);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(t, e.clientX, e.clientY);
  }, true);

  document.addEventListener('mouseover', function (e) {
    var a = linkAt(e.target);
    if (!a || a.dataset.cclTitled) return;
    var t = fileTarget(a);
    if (!t) return;
    a.title = t.line ? t.path + ':' + t.line : t.path;
    a.dataset.cclTitled = '1';
  });

  window.addEventListener('mousedown', function (e) {
    if (menu && !menu.contains(e.target)) closeMenu();
  }, true);
  window.addEventListener('keydown', function (e) {
    if (menu && e.key === 'Escape') { e.preventDefault(); closeMenu(); }
  }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);

  window.__CCL = { fileTarget: fileTarget, actionUrl: actionUrl };
})();
