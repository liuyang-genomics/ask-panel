/**
 * Unit tests. No browser, no network: everything here runs against stubs.
 *   node --test test/
 *
 * These cover the two places that produced real, silent, data-losing bugs:
 * argument parsing, and deciding whether a site actually answered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { positionalArgs } from '../scripts/args.mjs';
import { PAGE_EXTRACT } from '../scripts/page.mjs';
import { renderMarkdown } from '../scripts/archive.mjs';

// --------------------------------------------------------------- arguments

test('a boolean flag does not swallow the question', () => {
  // The original bug: `run --continue "q"` parsed to nothing, so the tool fell
  // through to reading stdin and the question vanished without a word.
  assert.equal(positionalArgs(['--continue', 'Q'])[0], 'Q');
  assert.equal(positionalArgs(['--no-archive', 'Q'])[0], 'Q');
  assert.equal(positionalArgs(['--json', 'Q'])[0], 'Q');
});

test('argument order never changes meaning', () => {
  const orders = [
    ['Q', '--continue'],
    ['--continue', 'Q'],
    ['--timeout', '240', '--continue', 'Q'],
    ['--sites', 'gemini', 'Q', '--no-archive'],
  ];
  for (const argv of orders) assert.equal(positionalArgs(argv)[0], 'Q', JSON.stringify(argv));
});

test('a value flag still consumes its value', () => {
  assert.deepEqual(positionalArgs(['--sites', 'gemini']), []);
  assert.deepEqual(positionalArgs(['--out', '/tmp/x.json']), []);
});

// --------------------------------------------------------------- extraction

const node = (innerText, textContent = innerText) => ({ innerText, textContent });

function stubDom(bySelector, mainText = '') {
  globalThis.document = {
    querySelectorAll: (sel) => bySelector[sel] || [],
    querySelector: (sel) => (sel === 'main' ? { innerText: mainText } : null),
  };
}

const SITE = { answer: ['[assistant]'] };
const Q = 'In one sentence: what is the mathematical constant pi?';

test('a real answer is returned as ok', () => {
  stubDom({ '[assistant]': [node("Pi is the ratio of a circle's circumference to its diameter, about 3.14159.")] });
  const r = PAGE_EXTRACT(SITE, Q);
  assert.equal(r.status, 'ok');
  assert.equal(r.fallback, undefined);
  assert.match(r.text, /^Pi is the ratio/);
});

test('an empty assistant turn reports empty, not fallback junk', () => {
  // ChatGPT render-death: the turn exists but holds no text. This used to fall
  // through to main and return the question echoed back plus a disclaimer,
  // ~110 chars that read exactly like an answer and poisoned the synthesis.
  stubDom({ '[assistant]': [node('')] }, `${Q}\nChatGPT can make mistakes. Check important info.`);
  const r = PAGE_EXTRACT(SITE, Q);
  assert.equal(r.status, 'empty');
  assert.equal(r.text, '');
  assert.equal(r.via, '[assistant]', 'must name the selector so this reads as render-death, not a broken selector');
});

test('main containing only the question echo is refused', () => {
  stubDom({}, `${Q}\nChatGPT can make mistakes.`);
  const r = PAGE_EXTRACT(SITE, Q);
  assert.equal(r.status, 'empty');
  assert.equal(r.text, '');
});

test('main with substantially more than the question is accepted but flagged', () => {
  const real = 'Pi is irrational and transcendental; it appears throughout mathematics '
    + 'and physics in countless identities far beyond geometry alone, which is why it recurs so widely.';
  stubDom({}, `${Q}\n${real}`);
  const r = PAGE_EXTRACT(SITE, Q);
  assert.equal(r.status, 'ok');
  assert.equal(r.fallback, true, 'fallback text must be flagged so a caller can distrust it');
});

test('Gemini A/B: hidden candidates are read, and the longest wins', () => {
  // innerText is '' for a CSS-hidden node; textContent still has the text.
  // Never click "Choice A" to reveal one - that casts a rating vote.
  stubDom({ '[assistant]': [
    node('', 'Choice A text that is long enough to count as a genuine answer here.'),
    node('', 'Choice B is noticeably longer and should win the longest-candidate rule outright.'),
  ] });
  const r = PAGE_EXTRACT(SITE, Q);
  assert.equal(r.status, 'ok');
  assert.match(r.text, /^Choice B/);
});

test('selectors are tried in order and the first populated one wins', () => {
  stubDom({ '[a]': [], '[b]': [node('A sufficiently long answer lives under the second selector here.')] });
  const r = PAGE_EXTRACT({ answer: ['[a]', '[b]'] }, Q);
  assert.equal(r.status, 'ok');
  assert.equal(r.via, '[b]');
});

// --------------------------------------------------------------- archive

test('markdown flags untrustworthy results and keeps failures visible', () => {
  const md = renderMarkdown({
    question: 'Q?',
    results: [
      { site: 'a', label: 'Alpha', status: 'ok', text: 'good answer', url: 'https://example.com/t' },
      { site: 'b', label: 'Beta', status: 'ok', text: 'iffy', fallback: true },
      { site: 'c', label: 'Gamma', status: 'empty', why: 'render death' },
      { site: 'd', label: 'Delta', status: 'no-tab', why: 'no Delta tab open' },
    ],
  });
  assert.match(md, /1\/4 answered/, 'the header counts only genuine answers');
  assert.match(md, /## Alpha/);
  assert.match(md, /\[thread\]\(https:\/\/example\.com\/t\)/);
  assert.match(md, /\*\*fallback - distrust\*\*/);
  assert.match(md, /render death/, 'a failed site must stay visible, not be dropped');
  assert.match(md, /no Delta tab open/);
});

test('two runs of the same question never overwrite each other', async () => {
  // Regression: the directory name used a minute-resolution timestamp, so a
  // retry within the same minute resolved to the same directory and silently
  // destroyed the first run's answers.
  const { archiveRun } = await import('../scripts/archive.mjs');
  const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'ask-panel-test-'));
  const run = (text) => archiveRun({ question: 'same question', results: [{ site: 'x', label: 'X', status: 'ok', text }] }, dir);
  const first = run('FIRST RUN ANSWER');
  const second = run('SECOND RUN ANSWER');

  assert.notEqual(first, second, 'each run needs its own directory');
  assert.equal(readdirSync(dir).filter((f) => f !== 'INDEX.md').length, 2);
  assert.match(readFileSync(join(first, 'answers.md'), 'utf8'), /FIRST RUN ANSWER/);
  assert.match(readFileSync(join(second, 'answers.md'), 'utf8'), /SECOND RUN ANSWER/);
});

// --------------------------------------------------------------- html report

test('answer text is escaped, never injected as markup', async () => {
  // Answers come from third-party sites and land inside our HTML. Treat them
  // as hostile input regardless of how trustworthy the site looks.
  const { renderHtml } = await import('../scripts/report.mjs');
  const html = renderHtml({
    question: 'Q?',
    results: [{ site: 'x', label: 'X', status: 'ok', chars: 40, text: '<script>alert(1)</script> & <img src=x onerror=y>' }],
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not survive');
  assert.ok(!html.includes('<img src=x'), 'raw img tag must not survive');
  assert.match(html, /&lt;script&gt;/);
});

test('report declares utf-8 so answers do not render as mojibake', async () => {
  // Regression: without this, smart quotes in answers rendered as "â€œ" when
  // the file was opened directly or served by a bare static server.
  const { renderHtml } = await import('../scripts/report.mjs');
  const html = renderHtml({ question: 'Q?', results: [] });
  assert.match(html, /<meta charset="utf-8">/i);
});

test('pipe tables become real tables', async () => {
  const { renderHtml } = await import('../scripts/report.mjs');
  const html = renderHtml({
    question: 'Q?',
    results: [{ site: 'x', label: 'X', status: 'ok', chars: 99, text: '| Model | Size |\n|---|---|\n| A | 8GB |' }],
  });
  assert.match(html, /<th>Model<\/th>/);
  assert.match(html, /<td>8GB<\/td>/);
  assert.ok(!html.includes('|---|'), 'the divider row must not leak into output');
});

test('cards lead with a summary and keep the full answer available', async () => {
  const { renderHtml } = await import('../scripts/report.mjs');
  const long = 'First sentence that summarises it. ' + 'Then a great deal more detail. '.repeat(30);
  const html = renderHtml({ question: 'Q?', results: [{ site: 'x', label: 'X', status: 'ok', chars: long.length, text: long }] });
  assert.match(html, /class="peek"/, 'a summary must be rendered');
  assert.match(html, /<div class="body" id="b0" hidden>/, 'the full body starts hidden');
  assert.match(html, /First sentence that summarises it\./);
});

test('an agent-written summary overrides the excerpt', async () => {
  const { renderHtml } = await import('../scripts/report.mjs');
  const html = renderHtml(
    { question: 'Q?', results: [{ site: 'x', label: 'X', status: 'ok', chars: 99, text: 'Raw opening text of the answer.' }] },
    '', { x: 'Agent-written one-liner.' });
  assert.match(html, /Agent-written one-liner\./);
  assert.ok(!/class="peek"[^>]*>Raw opening/.test(html), 'the excerpt must not also appear as the summary');
});

test('a failed site shows why, and no summary', async () => {
  const { renderHtml } = await import('../scripts/report.mjs');
  const html = renderHtml({ question: 'Q?', results: [{ site: 'x', label: 'X', status: 'empty', why: 'render death' }] });
  assert.match(html, /render death/);
  assert.ok(!html.includes('class="peek"'), 'nothing to summarise when there is no answer');
});
