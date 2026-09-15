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

const BADGE = { ok: 'ok', empty: 'bad', error: 'bad', 'no-tab': 'muted' };

export function renderHtml(payload) {
  const results = payload.results || [];
  const good = results.filter((r) => r.status === 'ok' && !r.fallback);
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const cards = results.map((r, i) => {
    const kind = r.fallback ? 'warn' : (BADGE[r.status] || 'muted');
    const label = r.fallback ? 'fallback - distrust' : r.status;
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
        <button class="fold" data-i="${i}" aria-expanded="true">collapse</button>
      </header>
      <div class="body" id="b${i}">${body}</div>
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
       padding-block:28px;padding-left:20px;padding-right:20px;max-width:1500px;margin:0 auto}
  h1{font-size:21px;line-height:1.35;margin:0 0 10px;font-weight:650}
  .sub{color:var(--dim);font-size:13px;margin-bottom:18px}
  .bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:22px}
  button{font:inherit;font-size:13px;padding:6px 12px;border:1px solid var(--line);background:var(--panel);
         color:var(--ink);border-radius:7px;cursor:pointer}
  button:hover{border-color:var(--accent)}
  button[aria-pressed="true"]{background:var(--accent);color:#fff;border-color:var(--accent)}
  .grid{display:grid;gap:16px}
  .grid.cols{grid-template-columns:repeat(auto-fit,minmax(330px,1fr));align-items:start}
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
  @media (max-width:700px){ .grid.cols{grid-template-columns:1fr} }
</style>

<h1>${esc(payload.question || 'Panel')}</h1>
<div class="sub">${good.length}/${results.length} answered${payload.elapsedSec ? ` in ${payload.elapsedSec.toFixed(1)}s` : ''} &middot; rendered ${when}</div>

<div class="bar">
  <button id="layout" aria-pressed="true">Side by side</button>
  <button id="only" aria-pressed="false">Only answered</button>
  <button id="foldall">Collapse all</button>
  <button id="theme">Theme</button>
</div>

<div class="grid cols" id="grid">
${cards}
</div>

<script>
  const grid = document.getElementById('grid');
  const layout = document.getElementById('layout');
  layout.onclick = () => {
    const cols = grid.classList.toggle('cols');
    layout.setAttribute('aria-pressed', cols);
    layout.textContent = cols ? 'Side by side' : 'Stacked';
  };
  const only = document.getElementById('only');
  only.onclick = () => {
    const on = only.getAttribute('aria-pressed') !== 'true';
    only.setAttribute('aria-pressed', on);
    for (const c of grid.children) c.hidden = on && c.dataset.ok !== '1';
  };
  for (const b of document.querySelectorAll('.fold')) {
    b.onclick = () => {
      const body = document.getElementById('b' + b.dataset.i);
      body.hidden = !body.hidden;
      b.textContent = body.hidden ? 'expand' : 'collapse';
      b.setAttribute('aria-expanded', !body.hidden);
    };
  }
  document.getElementById('foldall').onclick = (e) => {
    const collapse = e.target.textContent === 'Collapse all';
    for (const b of document.querySelectorAll('.fold')) {
      const body = document.getElementById('b' + b.dataset.i);
      if (body.hidden !== collapse) b.click();
    }
    e.target.textContent = collapse ? 'Expand all' : 'Collapse all';
  };
  document.getElementById('theme').onclick = () => {
    const now = document.documentElement.getAttribute('data-theme');
    const dark = now ? now === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  };
</script>`;
}
