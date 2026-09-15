/**
 * Run archive.
 *
 * Archiving is on by default. The raw answers are the expensive part of a run -
 * six sites, 30-100s, real rate limit against real accounts - so losing them to
 * a cleared /tmp or a closed terminal costs far more than the disk does.
 *
 * The archive deliberately lives OUTSIDE the skill directory. It holds the
 * user's questions, the models' answers, and live URLs into their logged-in
 * accounts; none of that should sit inside a folder that might be published,
 * copied or committed. Override with ASK_PANEL_HOME or --archive-dir.
 */

import { writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const defaultArchiveDir = () =>
  join(process.env.ASK_PANEL_HOME || join(homedir(), '.ask-panel'), 'runs');

/** Trustworthy answers vs. ones whose text came from a page-furniture fallback. */
export function countAnswers(results = []) {
  const ok = results.filter((r) => r.status === 'ok');
  return { good: ok.filter((r) => !r.fallback).length, weak: ok.filter((r) => r.fallback).length };
}

const slugify = (q) =>
  q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';

/** Render a run as readable Markdown, one section per site. */
export function renderMarkdown(payload, when = new Date()) {
  const results = payload.results || [];
  // Count only trustworthy answers. A fallback result has status 'ok' but its
  // text came from page furniture, so counting it as "answered" overstates how
  // much the panel actually told you - the very thing this tool exists to avoid.
  const { good, weak } = countAnswers(results);
  const out = [
    `# ${payload.question || 'untitled'}`, '',
    `*${when.toISOString()} - ${good}/${results.length} answered`
      + `${weak ? `, ${weak} fallback (distrust)` : ''}`
      + `${payload.elapsedSec ? `, ${payload.elapsedSec.toFixed(1)}s` : ''}*`, '',
  ];
  for (const r of results) {
    out.push('---', '', `## ${r.label || r.site}`, '');
    if (r.status !== 'ok') { out.push(`*(${r.status}${r.why ? ': ' + r.why : ''})*`, ''); continue; }
    const tags = [
      r.fallback ? '**fallback - distrust**' : null,
      r.recovered ? 'recovered via reload' : null,
      r.url ? `[thread](${r.url})` : null,
    ].filter(Boolean);
    if (tags.length) out.push(`*${tags.join(' - ')}*`, '');
    out.push(r.text || '', '');
  }
  return out.join('\n');
}

export function archiveRun(payload, archiveDir = defaultArchiveDir()) {
  const q = payload.question || 'untitled';
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  const name = `${stamp}-${slugify(q)}`;
  const dir = join(archiveDir, name);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'run.json'), JSON.stringify(payload, null, 2));
  writeFileSync(join(dir, 'answers.md'), renderMarkdown(payload, now));

  const results = payload.results || [];
  const { good } = countAnswers(results);
  const index = join(archiveDir, 'INDEX.md');
  if (!existsSync(index)) writeFileSync(index, '# ask-panel runs\n\nNewest last.\n\n');
  appendFileSync(index, `- \`${stamp}\` [${q.slice(0, 90)}](${name}/answers.md) - ${good}/${results.length}\n`);
  return dir;
}
