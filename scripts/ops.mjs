/**
 * The operations: submit a question, watch for completion, extract the answer.
 * Everything here is site-agnostic - per-site knowledge lives in sites.mjs.
 */

import { SITES, bare } from './sites.mjs';
import { withTab, par } from './cdp.mjs';
import { PAGE_FIND, PAGE_PASTE, PAGE_CLICK_SEND, PAGE_SUBMIT_STATE, PAGE_PROBE, PAGE_EXTRACT } from './page.mjs';

export async function waitFor(tab, selectors, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await tab.eval(PAGE_FIND.toString(), selectors).catch(() => ({ ok: false }));
    if (r.ok) return r;
    await new Promise((r2) => setTimeout(r2, 400));
  }
  return { ok: false };
}

/** A trusted Enter key event - every one of these composers accepts it. */
export async function pressEnter(tab) {
  for (const type of ['keyDown', 'char', 'keyUp']) {
    await tab.key({
      type,
      key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      ...(type === 'char' ? { text: '\r' } : {}),
    }).catch(() => {});
  }
}

export async function askSite(key, target, question, { fresh = true } = {}) {
  const site = SITES[key];
  return withTab(target, async (tab) => {
    await tab.send('Runtime.enable').catch(() => {});

    // Sites that accept the question in the URL and self-submit skip all DOM work.
    // The query-URL path always opens a NEW thread, so it must not be used in
    // --continue mode: that would silently drop this site's prior context while
    // the others keep theirs. Fall through to the DOM path and report honestly
    // if the site's editor refuses the paste.
    if (site.urlAsk && fresh) {
      await tab.send('Page.navigate', { url: site.urlAsk(question) });
      await new Promise((r) => setTimeout(r, 3000));
      const probe = await tab.eval(PAGE_PROBE.toString(), bare(site));
      return { site: key, ok: true, paste: 'url', submit: 'url', url: probe.url, baseLen: probe.bodyLen };
    }

    if (fresh) {
      await tab.send('Page.navigate', { url: site.newUrl });
      await new Promise((r) => setTimeout(r, 2500));
    }

    const found = await waitFor(tab, site.input, 30000);
    if (!found.ok) return { site: key, ok: false, why: 'input never appeared' };

    // SPA hydration can swap the composer out from under us; retry the paste.
    let pasted = { ok: false, why: 'not attempted' };
    for (let attempt = 0; attempt < 3 && !pasted.ok; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000));
      pasted = await tab.eval(PAGE_PASTE.toString(), site.input, question).catch((e) => ({ ok: false, why: String(e.message) }));
    }
    if (!pasted.ok) return { site: key, ok: false, why: pasted.why };

    // ProseMirror/Lexical commit paste state asynchronously, and the send button
    // only renders once that state lands; 350ms was short enough to lose the race.
    await new Promise((r) => setTimeout(r, 600));

    const readState = () => tab.eval(PAGE_SUBMIT_STATE.toString(), bare(site)).catch(() => null);
    const before = (await readState()) || { found: false, composerLen: 0, userTurns: 0 };
    // The composer emptying is the proof. If the composer node itself vanished
    // we have nothing to compare, so fall back to a new user turn appearing.
    const submitted = (now) =>
      !!now && (now.userTurns > before.userTurns || (now.found && now.composerLen <= 2));

    // Verify and retry rather than fire-and-hope: a single Enter, or a single
    // click at the wrong instant, silently leaves the question in the box.
    let how = null;
    for (let round = 1; round <= 3 && !how; round++) {
      await pressEnter(tab);
      await new Promise((r) => setTimeout(r, 900));
      if (submitted(await readState())) { how = 'enter#' + round; break; }
      const clicked = await tab.eval(PAGE_CLICK_SEND.toString(), site.send).catch(() => ({ ok: false }));
      await new Promise((r) => setTimeout(r, 1100));
      if (submitted(await readState())) how = (clicked.ok ? 'click:' + clicked.sel : 'click-missed') + '#' + round;
    }
    if (!how) how = 'unverified';

    const probe = await tab.eval(PAGE_PROBE.toString(), bare(site));
    return { site: key, ok: how !== 'unverified', paste: pasted.how, submit: how, url: probe.url, baseLen: probe.bodyLen };
  }).catch((e) => ({ site: key, ok: false, why: String(e.message || e) }));
}

export async function probeSite(key, target) {
  const site = SITES[key];
  return withTab(target, async (tab) => {
    const p = await tab.eval(PAGE_PROBE.toString(), bare(site));
    const i = await tab.eval(PAGE_FIND.toString(), site.input);
    const s = await tab.eval(PAGE_FIND.toString(), site.send);
    return { site: key, ...p, input: i.sel || null, send: s.sel || null };
  }).catch((e) => ({ site: key, error: String(e.message || e) }));
}

export async function extractSite(key, target, question, { recover = true } = {}) {
  const site = SITES[key];
  return withTab(target, async (tab) => {
    let r = await tab.eval(PAGE_EXTRACT.toString(), bare(site), question || '');
    let recovered = false;

    // Last-resort rescue for a response that completed server-side but was
    // never painted. Un-throttling the tab prevents nearly all of these; when
    // one slips through, reloading rehydrates the thread from the server.
    // RELOAD ONLY - never re-submit: the thread already exists on the user's
    // real account and re-asking would double-post. One attempt, bounded wait.
    if (recover && r.status !== 'ok') {
      const p0 = await tab.eval(PAGE_PROBE.toString(), bare(site)).catch(() => null);
      // A self-submitting query URL would re-run the search on reload.
      const selfSubmitting = p0 && /[?&]q=/.test(p0.url);
      if (p0 && !p0.stopping && !selfSubmitting) {
        await tab.send('Page.reload', {}).catch(() => {});
        const until = Date.now() + 25000;
        while (Date.now() < until) {
          await new Promise((w) => setTimeout(w, 2000));
          const rr = await tab.eval(PAGE_EXTRACT.toString(), bare(site), question || '').catch(() => null);
          if (rr && rr.status === 'ok') { r = rr; recovered = true; break; }
        }
      }
    }

    const p = await tab.eval(PAGE_PROBE.toString(), bare(site));
    return {
      site: key, label: site.label, url: p.url,
      status: r.status, via: r.via, fallback: !!r.fallback, recovered, chars: r.chars || 0,
      text: r.text, ...(r.why ? { why: r.why } : {}),
    };
  }).catch((e) => ({
    site: key, label: site.label, status: 'error', via: null, fallback: false,
    recovered: false, chars: 0, text: '', why: String(e.message || e),
  }));
}

/**
 * Poll until every site stops producing text, then stop polling it.
 *
 * Settling deliberately does not require len > 0. A site can fail and leave an
 * empty assistant turn behind; waiting for that to grow used to burn the whole
 * timeout (181s for a run that was done in 35s) and held the other five hostage.
 * So: an answer node that exists but is not growing is settled whatever its
 * length, while a site that has produced no node at all is given longer, since
 * that is indistinguishable from a slow first token.
 */
export async function pollSettled(live, timeoutMs, opts = {}) {
  const { interval = 5000, stablePolls = 2, emptyPolls = 6, stragglerMs = 90000 } = opts;
  const t0 = Date.now();
  const pending = { ...live };
  const total = Object.keys(pending).length;
  const prev = {}, stable = {}, done = {};
  let firstDoneAt = 0;
  while (Object.keys(pending).length && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, interval));
    const rows = await par(pending, probeSite);
    // Per-site deadline: once anyone has finished, the rest get a bounded window
    // instead of the full timeout, so one wedged site cannot hold up the panel.
    const overdue = firstDoneAt && Date.now() - firstDoneAt > stragglerMs;
    for (const r of rows) {
      const len = r.lastLen || 0;
      if (!r.stopping && prev[r.site] === len) stable[r.site] = (stable[r.site] || 0) + 1;
      else stable[r.site] = 0;
      prev[r.site] = len;
      const need = len > 0 || r.answers > 0 ? stablePolls : emptyPolls;
      if (stable[r.site] >= need) done[r.site] = len > 0 ? 'stable' : 'empty';
      else if (overdue) done[r.site] = 'straggler-deadline';
      if (done[r.site]) delete pending[r.site];
    }
    if (!firstDoneAt && Object.keys(pending).length < total) firstDoneAt = Date.now();
    const left = Object.keys(pending);
    process.stderr.write(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] settled ${total - left.length}/${total}` +
      (left.length ? ` waiting ${left.join(',')}` : '') + '\n');
  }
  for (const k of Object.keys(pending)) done[k] = 'timeout';
  return done;
}
