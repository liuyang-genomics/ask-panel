#!/usr/bin/env node
/**
 * ask-panel - put one question to several logged-in AI web chats at once.
 *
 * Drives an already-running Chrome over the DevTools Protocol. No API keys: it
 * uses the browser sessions you are already signed into. Text is delivered as a
 * synthetic paste, never typed character by character.
 *
 * Layout:
 *   sites.mjs    per-site selectors - the only file that needs regular upkeep
 *   cdp.mjs      DevTools transport
 *   page.mjs     functions injected into the page
 *   ops.mjs      submit / poll / extract
 *   archive.mjs  saving runs
 *
 * Run `node panel.mjs --help` for usage.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';

import { SITES } from './sites.mjs';
import { resolveTabs, withTab, par, NoBrowserError } from './cdp.mjs';
import { askSite, probeSite, extractSite, pollSettled } from './ops.mjs';
import { archiveRun, defaultArchiveDir } from './archive.mjs';
import { parser, positionalArgs } from './args.mjs';

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const { flag, has } = parser(argv);

const USAGE = `ask-panel - ask one question to several logged-in AI web chats at once

  node panel.mjs run "<question>"     ask, wait, print JSON      <- usual choice
  node panel.mjs ask "<question>"     ask and return immediately
  node panel.mjs status               who is still generating
  node panel.mjs wait                 block until all settle, then print JSON
  node panel.mjs collect              extract answers right now
  node panel.mjs check                instant status of a detached run (no browser)
  node panel.mjs probe                per-site selector health (read-only)
  node panel.mjs dump                 raw page text, for debugging selectors
  node panel.mjs archive --from <f>   re-file a saved run.json

Options
  --out <path>       write JSON here instead of stdout. Prefer this: progress
                     goes to stderr, so "> f 2>&1" corrupts the payload.
  --sites a,b        only these sites (${Object.keys(SITES).join(', ')})
  --continue         stay in the current thread instead of starting a new chat
  --timeout <sec>    give up waiting after this long (default 240)
  --no-archive       do not save this run
  --archive-dir <d>  where runs are saved (default ${defaultArchiveDir()})
  --no-recover       skip the one reload that rescues an unrendered answer
  --port <n>         CDP port (default 9333, or PANEL_CDP_PORT)
  --json             collect: print JSON instead of text

Needs a Chrome started with --remote-debugging-port and signed in to the sites.
See SKILL.md for setup.`;

if (has('help') || cmd === 'help' || cmd === '--help') { console.log(USAGE); process.exit(0); }

const PORT = flag('port', process.env.PANEL_CDP_PORT || '9333');
const STATE = flag('state', join(tmpdir(), 'ask-panel-state.json'));
const ARCHIVE = flag('archive-dir', defaultArchiveDir());
const ONLY = (flag('sites', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const positional = positionalArgs(argv.slice(1));

const UNKNOWN = ONLY.filter((k) => !Object.prototype.hasOwnProperty.call(SITES, k));
if (UNKNOWN.length) {
  console.error(`unknown site(s): ${UNKNOWN.join(', ')}\nknown: ${Object.keys(SITES).join(', ')}`);
  process.exit(2);
}

// ---------------------------------------------------------------- helpers

function saveState(o) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(o, null, 2));
}
const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});

/** A site with no open tab, shaped like a result so counts stay honest. */
const noTab = (key) => ({
  site: key, label: SITES[key].label, status: 'no-tab', via: null, fallback: false,
  recovered: false, chars: 0, text: '', settle: 'no-tab',
  why: `no ${SITES[key].label} tab open in the browser`,
});

function emit(payload) {
  const dest = flag('out', null);
  const json = JSON.stringify(payload, null, 2);
  if (dest) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, json);
  } else {
    console.log(json);
  }
  let archived = null;
  if (!has('no-archive')) {
    try { archived = archiveRun(payload, ARCHIVE); }
    catch (e) { process.stderr.write(`archive failed: ${e.message}\n`); }
  }
  const n = (payload.results || []).length;
  const ok = (payload.results || []).filter((r) => r.status === 'ok').length;
  if (dest) process.stderr.write(`\nwrote ${dest} (${ok}/${n} ok)\n`);
  if (archived) process.stderr.write(`archived ${archived}\n`);
}

const pad = (key) => (SITES[key].label + '          ').slice(0, 11);

// ---------------------------------------------------------------- dispatch

if (cmd === 'check') {
  // Instant, browser-free status of a detached run. Exists so no agent ever has
  // a reason to `sleep` waiting on a panel: ask this, get an answer, move on.
  const out = flag('out', join(homedir(), '.ask-panel', 'last.json'));
  const log = flag('log', out.replace(/\.json$/, '') + '.log');
  if (existsSync(out)) {
    const d = JSON.parse(readFileSync(out, 'utf8'));
    const rows = (d.results || []).map((r) => `${r.label}=${r.status}${r.fallback ? '(fallback)' : ''}`);
    console.log(`DONE in ${(d.elapsedSec || 0).toFixed(1)}s | ${rows.join(' ')}`);
    console.log(`answers: ${out}`);
    process.exit(0);
  }
  const running = spawnSync('pgrep', ['-f', 'panel.mjs (run|ask)'], { encoding: 'utf8' }).stdout.trim()
    || spawnSync('pgrep', ['-f', 'panel.mjs'], { encoding: 'utf8' }).stdout.trim();
  const tailLine = existsSync(log)
    ? (readFileSync(log, 'utf8').trim().split('\n').pop() || '').trim() : 'no log yet';
  const age = existsSync(log) ? Math.round((Date.now() - statSync(log).mtimeMs) / 1000) : null;
  if (running) {
    console.log(`RUNNING | ${tailLine}${age !== null ? ` | log idle ${age}s` : ''}`);
    if (age !== null && age > 120) console.log('log has been idle over 2 minutes - it may be wedged; check again later or re-run');
  } else {
    console.log(`NOT RUNNING and no ${out} - the run died. Last log line: ${tailLine}`);
  }
  process.exit(0);
}

let tabs, missing;
try {
  // --continue resumes existing threads, so it wants a tab already in one;
  // a fresh ask navigates the tab away, so it must not grab a conversation.
  ({ tabs, missing } = await resolveTabs(SITES, PORT, ONLY, { preferThread: has('continue') }));
} catch (e) {
  console.error(e instanceof NoBrowserError ? e.message : `Could not list browser tabs: ${e.message}`);
  process.exit(2);
}
if (!Object.keys(tabs).length) {
  console.error(`No AI tabs found on CDP port ${PORT}.\n`
    + `Start Chrome with --remote-debugging-port=${PORT} and open the sites. See SKILL.md.`);
  process.exit(2);
}
if (missing.length) process.stderr.write(`no tab open for: ${missing.join(', ')}\n`);

const recover = { recover: !has('no-recover') };
const withMissing = (out) => [...out, ...missing.map(noTab)];

if (cmd === 'probe') {
  for (const r of await par(tabs, probeSite)) {
    console.log(`${pad(r.site)}| input=${r.input || 'MISSING'} | send=${r.send || 'MISSING'}`
      + ` | answers=${r.answers} lastLen=${r.lastLen} ${r.error || ''}`);
  }

} else if (cmd === 'ask' || cmd === 'run') {
  const q = (positional[0] || readFileSync(0, 'utf8')).trim();
  if (!q) { console.error('no question given'); process.exit(2); }
  const t0 = Date.now();
  const sent = await par(tabs, (k, t) => askSite(k, t, q, { fresh: !has('continue') }));
  for (const r of sent) {
    process.stderr.write(`${pad(r.site)}| ${r.ok ? 'SENT' : 'FAIL'} | paste=${r.paste || '-'}`
      + ` submit=${r.submit || '-'} ${r.why || ''}\n`);
  }
  // A --sites re-run patches one site; don't wipe the others' baselines.
  const prev = ONLY.length ? loadState().sites || {} : {};
  saveState({ question: q, started: Date.now(), sites: { ...prev, ...Object.fromEntries(sent.map((r) => [r.site, r])) } });

  if (cmd === 'ask') {
    process.stderr.write(`\nsubmitted in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  } else {
    const timeout = Number(flag('timeout', 240)) * 1000;
    const live = Object.fromEntries(Object.entries(tabs).filter(([k]) => sent.find((r) => r.site === k)?.ok));
    const reasons = await pollSettled(live, Math.max(5000, timeout - (Date.now() - t0)));
    const out = await par(tabs, (k, t) => extractSite(k, t, q, recover));
    for (const r of out) r.settle = reasons[r.site] || 'not-sent';
    process.stderr.write(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)}s | `
      + out.map((r) => `${r.label}=${r.status}${r.fallback ? '(fallback)' : ''}${r.recovered ? '(reloaded)' : ''}`).join(' ') + '\n');
    emit({ question: q, elapsedSec: (Date.now() - t0) / 1000, results: withMissing(out) });
  }

} else if (cmd === 'status') {
  const st = loadState();
  for (const r of await par(tabs, probeSite)) {
    const base = st.sites?.[r.site]?.baseLen || 0;
    console.log(`${pad(r.site)}| ${r.stopping ? 'GENERATING' : 'idle      '}`
      + ` | answers=${r.answers} lastLen=${r.lastLen} bodyLen=${r.bodyLen} (base ${base})`);
  }

} else if (cmd === 'wait') {
  const st = loadState();
  const reasons = await pollSettled(tabs, Number(flag('timeout', 240)) * 1000);
  const out = await par(tabs, (k, t) => extractSite(k, t, st.question, recover));
  for (const r of out) r.settle = reasons[r.site] || 'unknown';
  emit({ question: st.question, results: withMissing(out) });

} else if (cmd === 'collect') {
  const st = loadState();
  const out = await par(tabs, (k, t) => extractSite(k, t, st.question, recover));
  if (has('json') || flag('out', null)) emit({ question: st.question, results: withMissing(out) });
  else {
    // Archive here too: the text and JSON paths must not differ in whether the
    // answers survive, or `collect` silently breaks the documented promise.
    if (!has('no-archive')) {
      try {
        const dir = archiveRun({ question: st.question, results: withMissing(out) }, ARCHIVE);
        process.stderr.write(`archived ${dir}\n`);
      } catch (e) { process.stderr.write(`archive failed: ${e.message}\n`); }
    }
    for (const r of out) {
      const tag = `${r.status.toUpperCase()}${r.fallback ? ' via fallback - DISTRUST' : ''}`;
      console.log(`\n${'='.repeat(70)}\n## ${r.label}  [${tag}] (${r.via || '-'})\n${'='.repeat(70)}\n${r.text || r.why || ''}`);
    }
  }

} else if (cmd === 'archive') {
  // `collect` re-reads whatever the tabs show NOW, so a tab that has navigated
  // away loses its answer. The run's own JSON is the authoritative record;
  // this rebuilds an archive entry from it.
  const src = flag('from', null);
  if (!src) { console.error('archive needs --from <run.json>'); process.exit(2); }
  const payload = JSON.parse(readFileSync(src, 'utf8'));
  const dir = archiveRun(payload, ARCHIVE);
  const good = (payload.results || []).filter((r) => r.status === 'ok' && !r.fallback).length;
  console.log(`archived ${dir} (${good}/${(payload.results || []).length} trustworthy)`);

} else if (cmd === 'dump') {
  const out = await par(tabs, (k, t) => withTab(t, async (tab) => {
    const r = await tab.eval(function () {
      return { url: location.href, text: (document.body.innerText || '').slice(0, 4000) };
    }.toString());
    return { site: k, ...r };
  }).catch((e) => ({ site: k, text: 'ERR ' + e.message })));
  for (const r of out) console.log(`\n=== ${r.site} ${r.url || ''} ===\n${r.text}`);

} else {
  console.error(USAGE);
  process.exit(2);
}
process.exit(0);
