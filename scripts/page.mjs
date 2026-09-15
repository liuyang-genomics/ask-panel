/**
 * Functions injected into the page. Each one is stringified and evaluated inside
 * the tab, so they must be entirely self-contained: no imports, no closures over
 * anything in this file, and only JSON-safe arguments and return values.
 */

export const PAGE_FIND = function (selectors) {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true') return { sel, ok: true };
    }
  }
  return { ok: false };
};

/** Deliver text as a real paste. Returns how it landed. */
export const PAGE_PASTE = function (selectors, text) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== 'hidden';
  };
  let el = null;
  for (const sel of selectors) {
    for (const cand of document.querySelectorAll(sel)) {
      if (visible(cand) && !cand.disabled) { el = cand; break; }
    }
    if (el) break;
  }
  if (!el) return { ok: false, why: 'no input found' };

  el.scrollIntoView({ block: 'center' });
  el.focus();
  el.click();

  // clear anything already there
  if ('value' in el && el.tagName !== 'DIV') {
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete');
  }

  // 1) synthetic paste - what rich editors (ProseMirror/Lexical/Quill) listen for
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  const consumed = !el.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));

  const readBack = () => ('value' in el && el.tagName !== 'DIV' ? el.value : el.innerText) || '';
  if (readBack().trim().length >= Math.min(20, text.length)) {
    return { ok: true, how: consumed ? 'paste-event' : 'paste-default', len: readBack().length };
  }

  // 2) React-safe native value setter (plain textareas)
  if ('value' in el && el.tagName !== 'DIV') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (readBack().trim().length) return { ok: true, how: 'native-setter', len: readBack().length };
  }

  // 3) execCommand insertText - fires beforeinput/input the way typing does
  el.focus();
  document.execCommand('insertText', false, text);
  if (readBack().trim().length) return { ok: true, how: 'execCommand', len: readBack().length };

  return { ok: false, why: 'all paste strategies produced empty input' };
};

export const PAGE_CLICK_SEND = function (selectors) {
  const laidOut = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && getComputedStyle(el).display !== 'none';
  };
  const usable = (el) => laidOut(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  // Two passes. el.click() dispatches straight at the node with no hit-testing,
  // so a button that is laid out but CSS-hidden still fires its handler - worth
  // trying rather than giving up, since a stalled fade-in leaves Claude's send
  // button in exactly that state.
  for (const pass of ['visible', 'hidden']) {
    for (const sel of selectors) {
      for (const el of [...document.querySelectorAll(sel)].reverse()) {
        if (!usable(el)) continue;
        const shown = getComputedStyle(el).visibility !== 'hidden';
        if (pass === 'visible' ? !shown : shown) continue;
        el.click();
        return { ok: true, sel: pass === 'hidden' ? sel + ' (css-hidden)' : sel };
      }
    }
  }
  return { ok: false };
};

/**
 * Proof-of-submission snapshot. Firing Enter or clicking send is not evidence
 * that anything was sent: the click can land on a button whose handler is not
 * attached, or on one the app has visually retired. The only trustworthy proof
 * is the composer emptying, or a new user turn appearing in the thread.
 */
export const PAGE_SUBMIT_STATE = function (site) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== 'hidden';
  };
  let found = false, composerLen = 0;
  for (const sel of site.input) {
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el)) continue;
      found = true;
      const v = ('value' in el && el.tagName !== 'DIV' ? el.value : el.innerText) || '';
      composerLen = Math.max(composerLen, v.trim().length);
    }
    if (found) break;
  }
  let userTurns = 0;
  for (const sel of site.userMsg || []) userTurns += document.querySelectorAll(sel).length;
  return { found, composerLen, userTurns };
};

/** Cheap progress signal: are we still generating, and how much text is there. */
export const PAGE_PROBE = function (site) {
  const txt = document.body.innerText || '';
  let answered = 0;
  let last = '';
  for (const sel of site.answer) {
    const els = document.querySelectorAll(sel);
    if (els.length) {
      answered = els.length;
      // innerText is '' for CSS-hidden nodes (Gemini's A/B panel); textContent still has it.
      const el = els[els.length - 1];
      last = el.innerText || el.textContent || '';
      break;
    }
  }
  let stopping = false;
  for (const sel of site.stop || []) if (document.querySelector(sel)) stopping = true;
  return { url: location.href, bodyLen: txt.length, answers: answered, lastLen: last.length, stopping };
};

/**
 * Answer plus an honest verdict. A site that failed has to say so: an empty
 * assistant turn used to fall through to main's text, which is the question
 * echoed back plus a "can make mistakes" disclaimer - ~110 chars that read like
 * an answer and would poison any synthesis built on them.
 */
export const PAGE_EXTRACT = function (site, question) {
  const MIN = 40;
  let matched = null, best = '';
  for (const sel of site.answer) {
    const els = [...document.querySelectorAll(sel)];
    if (!els.length) continue;
    // Longest candidate wins: Gemini's A/B test renders two candidate answers,
    // and innerText is '' for the CSS-hidden one while textContent still has it.
    // Never click "Choice A" to reveal one - that casts a rating vote.
    const t = els.map((e) => (e.innerText || e.textContent || '').trim())
      .sort((a, b) => b.length - a.length)[0] || '';
    // Record the selector even for a zero-length hit: "assistant turn exists but
    // is blank" is the render-death signature and must not be reported as
    // "no answer node", which would send the caller looking at selectors.
    if (!matched) matched = sel;
    if (t.length > best.length) { best = t; matched = sel; }
    if (best.length >= MIN) break;
  }
  if (best.length >= MIN) return { status: 'ok', via: matched, text: best, chars: best.length };
  if (matched) {
    return { status: 'empty', via: matched, text: '', chars: best.length,
      why: 'answer node present but only ' + best.length + ' chars' };
  }

  // No answer node at all. main is mostly page furniture plus an echo of the
  // question, so trust it only when there is substantially more there than what
  // we put in, and flag it so a caller can discount it.
  const main = document.querySelector('main') || document.body;
  const t = (main.innerText || '').trim();
  const q = (question || '').trim();
  const residue = (q ? t.split(q).join(' ') : t).replace(/\s+/g, ' ').trim();
  if (t.length >= Math.max(200, q.length * 3) && residue.length >= 150) {
    return { status: 'ok', via: 'fallback:main', fallback: true, text: t, chars: t.length };
  }
  return { status: 'empty', via: 'fallback:main', text: '', chars: t.length,
    why: 'no answer node; main holds only the question echo' };
};
