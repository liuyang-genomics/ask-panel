/**
 * Render a run as a single self-contained HTML page.
 *
 * No CDN, no dependencies, no network: the file works offline and can be opened
 * anywhere. Answers arrive as loose Markdown, so this does a deliberately small
 * subset - headings, bold, code, lists, pipe tables - because these models use
 * tables constantly and a wall of plain text is unreadable.
 */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Inline spans: code first so its contents are not further transformed. */
function inline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

const isTableRow = (l) => l.includes('|') && l.trim().length > 1;
const isDivider = (l) => /^[\s|:-]+$/.test(l) && l.includes('-');

function table(rows) {
  const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(isDivider(rows[1] || '') ? 2 : 1).map(cells);
  return `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function markdown(src) {
  const lines = String(src || '').split('\n');
  const out = [];
  let list = null, para = [], tbl = null;

  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`); list = null; } };
  const flushTable = () => { if (tbl) { out.push(table(tbl)); tbl = null; } };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (tbl && isTableRow(line)) { tbl.push(line); continue; }
    if (tbl) flushTable();

    if (!line.trim()) { flushAll(); continue; }

    if (isTableRow(line) && line.split('|').length > 2) { flushPara(); flushList(); tbl = [line]; continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushAll(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(`<li>${inline(ul ? ul[1] : ol[2])}</li>`);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushAll();
  return out.join('\n');
}

/** First couple of sentences, for scanning. Honest truncation, not analysis. */
function excerpt(text, max = 260) {
  // Prose only. These answers are full of tables and headings, and flattening
  // those produces "| Model | Size | |---|---|" where a summary should be.
  const prose = String(text || '')
    .split('\n')
    .filter((l) => !/^\s*#+\s/.test(l))          // headings
    .filter((l) => !/^[\s|:-]*\|/.test(l))        // table rows
    .filter((l) => !/^[\s|:-]+$/.test(l))          // table dividers and rules
    .filter((l) => !/^\s*```/.test(l))             // code fences
    .map((l) => l.replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+[.)]\s+/, ''))
    .join(' ');
  const flat = prose.replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.trimEnd() + '\u2026');
}

const BADGE = { ok: 'ok', empty: 'bad', error: 'bad', 'no-tab': 'muted' };

export function renderHtml(payload, synthesis = '', summaries = {}) {
  const results = payload.results || [];
  const good = results.filter((r) => r.status === 'ok' && !r.fallback);
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // The synthesis is written by the agent, not derived here: no amount of text
  // processing turns six answers into one. When present it leads, and the
  // per-site answers demote to evidence underneath it.
  const lead = synthesis ? `<section class="lead">${markdown(synthesis)}</section>
<h2 class="sectionhead">What each model said</h2>
<p class="sectionsub">Evidence for the answer above. Check a claim here before acting on it.</p>` : '';

  const cards = results.map((r, i) => {
    const kind = r.fallback ? 'warn' : (BADGE[r.status] || 'muted');
    const label = r.fallback ? 'fallback - distrust' : r.status;
    const given = summaries[r.site];
    const sum = r.status === 'ok' ? (given || excerpt(r.text)) : '';
    const body = r.status === 'ok'
      ? markdown(r.text)
      : `<p class="none">${esc(r.why || 'no answer')}</p>`;
    return `<article class="card" data-site="${esc(r.site)}" data-ok="${r.status === 'ok' ? 1 : 0}">
      <header>
        <h2>${esc(r.label || r.site)}</h2>
        <span class="badge ${kind}">${esc(label)}</span>
        ${r.chars ? `<span class="meta">${r.chars.toLocaleString()} chars</span>` : ''}
        ${r.recovered ? '<span class="meta">reloaded</span>' : ''}
        ${r.url ? `<a class="meta link" href="${esc(r.url)}" target="_blank" rel="noopener">thread</a>` : ''}
        <button class="fold" data-i="${i}" aria-expanded="false">full</button>
      </header>
      ${sum ? `<p class="peek" id="s${i}"${given ? '' : ' data-excerpt="1"'}>${inline(sum)}</p>` : ''}
      <div class="body" id="b${i}"${sum ? ' hidden' : ''}>${body}</div>
    </article>`;
  }).join('\n');

  // charset must be declared: answers are full of smart quotes and em dashes,
  // and without it a plain file:// open or a bare static server renders mojibake.
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc((payload.question || 'panel').slice(0, 70))}</title>
<style>
  :root{
    --bg:#f7f7f5; --panel:#fff; --ink:#1a1a18; --dim:#6b6b66; --line:#e3e3df;
    --ok:#1a7f4b; --okbg:#e6f4ec; --bad:#a6342a; --badbg:#fbeae8;
    --warn:#8a5a00; --warnbg:#fdf1dc; --accent:#3b5bdb;
  }
  @media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
    --bg:#16161a; --panel:#1e1e24; --ink:#eceCf0; --dim:#9a9aa4; --line:#2e2e37;
    --ok:#6ee7a8; --okbg:#10321f; --bad:#ff9d94; --badbg:#3a1a17;
    --warn:#f3c76b; --warnbg:#3a2c10; --accent:#8da2fb;
  }}
  :root[data-theme="dark"]{
    --bg:#16161a; --panel:#1e1e24; --ink:#ececf0; --dim:#9a9aa4; --line:#2e2e37;
    --ok:#6ee7a8; --okbg:#10321f; --bad:#ff9d94; --badbg:#3a1a17;
    --warn:#f3c76b; --warnbg:#3a2c10; --accent:#8da2fb;
  }
  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--ink);font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
       padding-block:28px;padding-left:20px;padding-right:20px;max-width:1900px;margin:0 auto}
  h1{font-size:21px;line-height:1.35;margin:0 0 10px;font-weight:650}
  .sub{color:var(--dim);font-size:13px;margin-bottom:18px}
  .bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:22px}
  button{font:inherit;font-size:13px;padding:6px 12px;border:1px solid var(--line);background:var(--panel);
         color:var(--ink);border-radius:7px;cursor:pointer}
  button:hover{border-color:var(--accent)}
  button[aria-pressed="true"]{background:var(--accent);color:#fff;border-color:var(--accent)}
  .grid{display:grid;gap:16px}
  /* True side-by-side: every answer is a column of the same width, so they can
     be read against each other. Auto-fit wrapped six cards into 4+2, which is
     not a comparison. Columns stay readable and the strip scrolls sideways
     instead of shrinking them into unreadability. */
  .grid.cols{grid-auto-flow:column;grid-auto-columns:minmax(340px,1fr);
             overflow-x:auto;padding-bottom:8px;align-items:stretch}
  .grid.cols .card{display:flex;flex-direction:column;max-height:76vh}
  .grid.cols .body{overflow-y:auto}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:11px;overflow:hidden}
  .card header{display:flex;flex-wrap:wrap;gap:9px;align-items:center;padding:12px 15px;border-bottom:1px solid var(--line)}
  .card h2{font-size:15px;margin:0;font-weight:650}
  .badge{font-size:11px;padding:2px 8px;border-radius:99px;font-weight:600;letter-spacing:.02em}
  .badge.ok{background:var(--okbg);color:var(--ok)} .badge.bad{background:var(--badbg);color:var(--bad)}
  .badge.warn{background:var(--warnbg);color:var(--warn)} .badge.muted{background:var(--line);color:var(--dim)}
  .meta{font-size:11.5px;color:var(--dim)} a.link{color:var(--accent);text-decoration:none}
  .fold{margin-left:auto;padding:3px 9px;font-size:11.5px}
  .body{padding:4px 15px 14px;font-size:14px;overflow-wrap:anywhere}
  .body[hidden]{display:none}
  .body h3,.body h4,.body h5,.body h6{font-size:14px;margin:16px 0 6px;font-weight:650}
  .body p{margin:9px 0} .body ul,.body ol{margin:9px 0;padding-left:20px} .body li{margin:3px 0}
  .body code{background:var(--bg);padding:1px 5px;border-radius:4px;font-size:12.5px}
  .scroll{overflow-x:auto;margin:11px 0}
  table{border-collapse:collapse;width:100%;font-size:12.5px}
  th,td{border:1px solid var(--line);padding:5px 9px;text-align:left;vertical-align:top}
  th{background:var(--bg);font-weight:650}
  .none{color:var(--dim);font-style:italic}
  .peek{margin:0;padding:12px 15px 14px;font-size:13.5px;color:var(--dim);line-height:1.55}
  .peek[hidden]{display:none}
  .lead{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);
        border-radius:11px;padding:6px 22px 18px;margin-bottom:30px}
  .lead h3,.lead h4{font-size:16px;margin:20px 0 7px;font-weight:650}
  .lead p{margin:10px 0} .lead ul,.lead ol{margin:10px 0;padding-left:21px} .lead li{margin:4px 0}
  .lead table{font-size:13px}
  .sectionhead{font-size:15px;margin:0 0 4px;font-weight:650}
  .sectionsub{color:var(--dim);font-size:12.5px;margin:0 0 16px}
  /* No horizontal strip on a phone: one column, full height, normal scrolling. */
  @media (max-width:700px){
    .grid.cols{grid-auto-flow:row;grid-auto-columns:auto;overflow-x:visible}
    .grid.cols .card{max-height:none}
    .grid.cols .body{overflow-y:visible}
  }
</style>

<h1>${esc(payload.question || 'Panel')}</h1>
<div class="sub">${good.length}/${results.length} answered${payload.elapsedSec ? ` in ${payload.elapsedSec.toFixed(1)}s` : ''} &middot; rendered ${when}</div>

<div class="bar">
  <button id="layout" aria-pressed="true">Side by side</button>
  <button id="only" aria-pressed="false">Only answered</button>
  <button id="foldall" aria-pressed="false">Full answers</button>
  <button id="theme">Theme</button>
</div>

${lead}
<div class="grid cols" id="grid">
${cards}
</div>

<script>
  // Per-viewer conveniences only; the page must render correctly when storage
  // is unavailable (private window, blocked site data), so every access is guarded.
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ask-panel:' + k); return v === null ? d : v === '1'; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('ask-panel:' + k, v ? '1' : '0'); } catch {} },
  };

  const grid = document.getElementById('grid');
  const layout = document.getElementById('layout');
  const setLayout = (cols, persist) => {
    grid.classList.toggle('cols', cols);
    layout.setAttribute('aria-pressed', cols);
    layout.textContent = cols ? 'Side by side' : 'Stacked';
    if (persist) store.set('cols', cols);
  };
  // Side by side is the default and the point of the page: six answers are for
  // comparing, and stacking them turns the comparison back into scrolling.
  setLayout(store.get('cols', true), false);
  layout.onclick = () => setLayout(!grid.classList.contains('cols'), true);

  const only = document.getElementById('only');
  const setOnly = (on, persist) => {
    only.setAttribute('aria-pressed', on);
    for (const c of grid.children) c.hidden = on && c.dataset.ok !== '1';
    if (persist) store.set('only', on);
  };
  setOnly(store.get('only', false), false);
  only.onclick = () => setOnly(only.getAttribute('aria-pressed') !== 'true', true);
  // Cards open on a summary so six answers can be scanned at a glance; the full
  // text is one click away per card, or all at once.
  const setCard = (b, full) => {
    const body = document.getElementById('b' + b.dataset.i);
    const peek = document.getElementById('s' + b.dataset.i);
    if (!peek) return;
    body.hidden = !full;
    peek.hidden = full;
    b.textContent = full ? 'summary' : 'full';
    b.setAttribute('aria-expanded', full);
  };
  for (const b of document.querySelectorAll('.fold')) {
    b.onclick = () => setCard(b, b.getAttribute('aria-expanded') !== 'true');
  }
  const all = document.getElementById('foldall');
  const setAll = (full, persist) => {
    for (const b of document.querySelectorAll('.fold')) setCard(b, full);
    all.textContent = full ? 'Summaries' : 'Full answers';
    all.setAttribute('aria-pressed', full);
    if (persist) store.set('full', full);
  };
  setAll(store.get('full', false), false);
  all.onclick = () => setAll(all.getAttribute('aria-pressed') !== 'true', true);
  document.getElementById('theme').onclick = () => {
    const now = document.documentElement.getAttribute('data-theme');
    const dark = now ? now === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  };
</script>`;
}
