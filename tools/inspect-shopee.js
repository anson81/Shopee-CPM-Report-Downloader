/**
 * Read-only DOM inspector for Shopee Seller Centre.
 *
 * Paste into DevTools Console (F12 -> Console) on
 *   https://seller.shopee.com.my/datacenter/product/overview
 *
 * It clicks nothing. It prints the selectors and wording the extension has to
 * match, then watches the page for 2 minutes so you can click "Export Data"
 * yourself and have it record what actually appears: the processing row, the
 * finished row, and any rate-limit toast.
 *
 * Copy the final block it prints and send it back.
 */
(() => {
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const all = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const desc = (el) =>
    el
      ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${squash(el.className).split(' ').filter(Boolean).join('.')}`
      : null;

  /* ---- 1. static structure ------------------------------------------ */
  const structure = {
    url: location.href,
    biDateInput: all('.bi-date-input').map(desc),
    shortcuts: all('.bi-date-shortcuts li').map((li) => squash(li.textContent)),
    datePickerPanels: all('.eds-date-picker-panel').map(desc),
    prevArrows: all('.eds-picker-header__prev').map(desc),
    dateCells: all('.eds-date-table__cell').length,
    exportButtons: all('button.export, div.eds-dropdown.export button').map(
      (b) => `${desc(b)} :: "${squash(b.textContent)}"`
    ),
    // The input the old build wrongly typed dates into:
    visibleTextInputs: all('input[type="text"], input[class*="date"]')
      .filter(vis)
      .map((i) => `${desc(i)} placeholder="${i.placeholder || ''}"`)
  };

  /* ---- 2. the Latest Reports panel ----------------------------------- */
  function findPanel() {
    const hits = Array.from(document.querySelectorAll('*')).filter((el) => {
      const t = squash(el.textContent);
      return t && t.length < 200 && /latest reports/i.test(t);
    });
    const innermost = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    for (const head of innermost) {
      let node = head;
      for (let up = 0; up < 6 && node; up++) {
        node = node.parentElement;
        if (node && /download/i.test(node.innerText || '')) return node;
      }
    }
    return null;
  }

  function panelSnapshot() {
    const panel = findPanel();
    if (!panel) return { found: false };
    const rows = Array.from(panel.children).map((c) => ({
      cls: squash(c.className),
      text: squash(c.innerText).slice(0, 160)
    }));
    return {
      found: true,
      selector: desc(panel),
      text: squash(panel.innerText).slice(0, 600),
      rowCount: rows.length,
      rows: rows.slice(0, 6)
    };
  }

  /* ---- 3. toasts ----------------------------------------------------- */
  const TOASTY = '[class*="toast"],[class*="message"],[class*="notice"],[class*="tip"],[class*="alert"],[role="alert"]';
  const seenToasts = new Set();
  function grabToasts() {
    for (const el of all(TOASTY).filter(vis)) {
      const t = squash(el.innerText);
      if (t && t.length < 300) seenToasts.add(`${desc(el)} :: "${t}"`);
    }
  }

  console.log('=== STATIC STRUCTURE ===');
  console.log(JSON.stringify(structure, null, 2));
  console.log('=== PANEL NOW ===');
  console.log(JSON.stringify(panelSnapshot(), null, 2));
  console.log(
    '%c>>> Now click "Export Data" yourself. Recording for 120s...',
    'font-weight:bold;color:#ee4d2d'
  );

  const timeline = [];
  let last = '';
  const started = Date.now();
  const timer = setInterval(() => {
    grabToasts();
    const snap = panelSnapshot();
    const sig = snap.found ? snap.text : '(no panel)';
    if (sig !== last) {
      timeline.push({ t: `${Math.round((Date.now() - started) / 1000)}s`, panel: sig.slice(0, 300) });
      last = sig;
    }
    if (Date.now() - started > 120000) {
      clearInterval(timer);
      const out = {
        structure,
        finalPanel: panelSnapshot(),
        toastsSeen: Array.from(seenToasts),
        timeline
      };
      console.log('=== SEND THIS BACK ===');
      console.log(JSON.stringify(out, null, 2));
      try {
        copy(JSON.stringify(out, null, 2));
        console.log('%c(copied to clipboard)', 'color:green');
      } catch (_) {
        console.log('(select the JSON above and copy it)');
      }
    }
  }, 2000);
})();
