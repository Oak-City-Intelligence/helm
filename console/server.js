#!/usr/bin/env node
// helm console — live read-only dashboard over the helm control-plane docs.
// Zero dependencies. Reads files off disk per request, so it is never stale.
//
//   node server.js                 → http://127.0.0.1:8090  (loopback only by default)
//   HOST=0.0.0.0 node server.js    → binds all interfaces (opt-in; only on a trusted network)
//   PORT=9000 node server.js
//
// Routes:
//   /                     dashboard (per-project QUEUE/BLOCKED/LEDGER-tail)
//   /doc/<relpath>        any file under helm/, markdown rendered, others raw-ish
//   /raw/<relpath>        raw file bytes
//   /dir/<relpath>        directory listing

const http = require('http');
const fs = require('fs');
const path = require('path');

const HELM = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '127.0.0.1'; // loopback by default; HOST=0.0.0.0 is an explicit opt-in
const PROJECTS = () => {
  try {
    return fs.readdirSync(path.join(HELM, 'projects'), { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
};

// ---------- tiny markdown renderer (headings, lists, tables, code, links) ----------
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Prefix marking a relative doc link, resolved once the document's dir is known. The resolver captures
// up to the closing quote, so an href carrying a '#anchor' resolves whole. (The old form delimited the
// end with '#', which truncated the href at its first '#'.)
const DOCLINK = '%%DOCLINK%%';

function inline(md) {
  let s = esc(md);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  // links: route relative .md targets through /doc/
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    if (/^https?:\/\//.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
    return `<a href="${DOCLINK}${href}">${text}</a>`; // resolved per-document later
  });
  return s;
}

function renderMd(md, relDir) {
  const lines = md.split('\n');
  const out = [];
  let inCode = false, inList = false, inQuote = false, inTable = false;
  const closeAll = () => {
    if (inList) { out.push('</ul>'); inList = false; }
    if (inQuote) { out.push('</blockquote>'); inQuote = false; }
    if (inTable) { out.push('</table></div>'); inTable = false; }
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      closeAll();
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(esc(line)); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { closeAll(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { closeAll(); out.push('<hr>'); continue; }

    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // separator row
      if (!inTable) { closeAll(); out.push('<div class="tblwrap"><table>'); inTable = true; }
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      out.push('<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>');
      continue;
    }
    if (inTable) { out.push('</table></div>'); inTable = false; }

    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) {
      if (!inList) { if (inQuote) { out.push('</blockquote>'); inQuote = false; } out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList && /^\s{2,}\S/.test(line)) { out.push(`<span class="licont">${inline(line.trim())}</span>`); continue; }
    if (inList) { out.push('</ul>'); inList = false; }

    const q = line.match(/^\s*>\s?(.*)/);
    if (q) {
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      out.push(`${inline(q[1])}<br>`);
      continue;
    }
    if (inQuote) { out.push('</blockquote>'); inQuote = false; }

    if (line.trim() === '') { out.push(''); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push('</pre>');
  closeAll();
  // resolve relative doc links against the document's directory
  return out.join('\n').replace(new RegExp(DOCLINK + '([^"]+)', 'g'), (_, href) => {
    const clean = href.replace(/^\.\//, '');
    const target = path.posix.normalize(path.posix.join(relDir, clean));
    return `/doc/${target}`;
  });
}

// ---------- page shell ----------
function page(title, body, autorefresh) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${autorefresh ? '<meta http-equiv="refresh" content="45">' : ''}
<title>${esc(title)}</title>
<style>
:root{--bg:#EFF1EE;--panel:#FBFCFA;--line:#D8DDD6;--ink:#1B242E;--muted:#5C6873;--accent:#9A6B15;
--ok:#2F7D4F;--warn:#A97814;--crit:#B23F2E;}
@media (prefers-color-scheme:dark){:root{--bg:#0D1218;--panel:#151C24;--line:#26303B;--ink:#D5DCE2;
--muted:#8593A0;--accent:#D9A441;--ok:#4CAF7D;--warn:#D19A3A;--crit:#D96A57;}}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:14.5px/1.55 system-ui,sans-serif;margin:0;padding:0 0 60px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
nav{position:sticky;top:0;background:var(--bg);border-bottom:2px solid var(--ink);padding:10px 20px;
display:flex;gap:18px;flex-wrap:wrap;align-items:baseline;z-index:5}
nav .brand{font-weight:700}
nav a{font-family:ui-monospace,Menlo,monospace;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
nav .live{margin-left:auto;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--ok)}
main{max-width:1120px;margin:0 auto;padding:18px 20px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:3px;padding:4px 18px 12px;margin:16px 0}
.panel>h2.paneltitle{font-size:13px;text-transform:uppercase;letter-spacing:.1em;
font-family:ui-monospace,Menlo,monospace;color:var(--muted);border-bottom:1px solid var(--line);
padding:10px 0 8px;margin:0 0 6px}
.panel>h2.paneltitle a{color:var(--muted)}
h1{font-size:20px}h2{font-size:17px}h3{font-size:15px}
code{font-family:ui-monospace,Menlo,monospace;font-size:.92em;background:rgba(128,128,128,.13);
padding:1px 4px;border-radius:2px}
pre{background:rgba(128,128,128,.1);border:1px solid var(--line);padding:10px;overflow-x:auto;
font-family:ui-monospace,Menlo,monospace;font-size:12.5px;border-radius:3px}
.tblwrap{overflow-x:auto}
table{border-collapse:collapse;font-size:13px;margin:8px 0}
td{border:1px solid var(--line);padding:4px 8px;vertical-align:top}
blockquote{border-left:3px solid var(--accent);margin:8px 0;padding:4px 12px;color:var(--muted)}
ul{padding-left:22px}
.licont{display:block;margin-left:2px;color:var(--muted)}
hr{border:0;border-top:1px solid var(--line)}
.dim{color:var(--muted)}
.tail{font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;
word-break:break-word;color:var(--muted)}
.filelist li{padding:2px 0}
</style></head><body>
<nav><span class="brand">⚓ helm console</span>
<a href="/">board</a>
<a href="/doc/DOCTRINE.md">doctrine</a>
<a href="/doc/ARCHITECTURE.md">architecture</a>
<a href="/doc/ROADMAP.md">roadmap</a>
<a href="/dir/">all files</a>
<span class="live">live · reads disk per request</span></nav>
<main>${body}</main></body></html>`;
}

const read = rel => { try { return fs.readFileSync(path.join(HELM, rel), 'utf8'); } catch { return null; } };
const mtime = rel => { try { return fs.statSync(path.join(HELM, rel)).mtime.toISOString().slice(0, 16).replace('T', ' '); } catch { return '—'; } };

function panel(title, rel, html) {
  return `<section class="panel"><h2 class="paneltitle"><a href="/doc/${rel}">${esc(title)}</a>
  <span class="dim" style="float:right">${mtime(rel)} · <a href="/raw/${rel}">raw</a></span></h2>${html}</section>`;
}

function mdPanel(title, rel, opts = {}) {
  const src = read(rel);
  if (src === null) {
    if (opts.omitIfMissing) return ''; // a healthy project has no BLOCKED.md; don't render a "missing" panel
    return `<section class="panel"><h2 class="paneltitle">${esc(title)}</h2><p class="dim">missing: ${esc(rel)}</p></section>`;
  }
  let body = src;
  if (opts.section) { // extract one "## <name>" section
    const re = new RegExp(`^## ${opts.section}[^\\n]*$`, 'm');
    const m = src.match(re);
    if (m) {
      const start = m.index;
      const rest = src.slice(start + m[0].length);
      const next = rest.search(/^## /m);
      body = m[0] + (next === -1 ? rest : rest.slice(0, next));
    } else body = `_section "## ${opts.section}" not found — open the doc_`;
  }
  if (opts.tail) body = body.split('\n').slice(-opts.tail).join('\n');
  const relDir = path.posix.dirname(rel);
  const html = opts.tail ? `<div class="tail">${esc(body)}</div>` : renderMd(body, relDir);
  return panel(title, rel, html);
}

function dashboard() {
  let out = '';
  for (const p of PROJECTS()) {
    out += `<h2 style="margin-top:28px">${esc(p)}</h2>`;
    out += mdPanel(`${p} — QUEUE`, `projects/${p}/QUEUE.md`);
    out += mdPanel(`${p} — BLOCKED`, `projects/${p}/BLOCKED.md`, { omitIfMissing: true });
    out += mdPanel(`${p} — LEDGER (tail)`, `projects/${p}/LEDGER.md`, { tail: 12 });
  }
  return page('helm console', out, true);
}

function docView(rel) {
  const src = read(rel);
  if (src === null) return null;
  const relDir = path.posix.dirname(rel);
  const isMd = /\.(md|markdown)$/i.test(rel);
  const body = isMd
    ? renderMd(src, relDir === '.' ? '' : relDir)
    : `<pre>${esc(src)}</pre>`;
  return page(rel, `<p class="dim">${esc(rel)} · ${mtime(rel)} · <a href="/raw/${rel}">raw</a></p>${body}`, false);
}

function dirView(rel) {
  const abs = path.join(HELM, rel);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return null; }
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const items = entries
    .filter(e => !e.name.startsWith('.git'))
    .map(e => {
      const child = path.posix.join(rel, e.name);
      return e.isDirectory()
        ? `<li>📁 <a href="/dir/${child}">${esc(e.name)}/</a></li>`
        : `<li>· <a href="/doc/${child}">${esc(e.name)}</a></li>`;
    }).join('\n');
  const up = rel ? `<p><a href="/dir/${path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)}">↑ up</a></p>` : '';
  return page(`helm/${rel}`, `<h1>helm/${esc(rel)}</h1>${up}<ul class="filelist">${items}</ul>`, false);
}

function safeRel(urlPath, prefix) {
  const rel = decodeURIComponent(urlPath.slice(prefix.length)).replace(/^\/+/, '');
  // Reject `..` segments and dotfiles (.git, .env, …) before resolving. `..` never appears in a
  // legitimate request here, and dotfiles hold repo internals we never serve.
  const segs = rel.split('/').filter(Boolean);
  if (segs.some(s => s === '..' || s.startsWith('.'))) return null;
  const abs = path.resolve(HELM, rel);
  // Stay inside HELM. Use an exact-or-child test, not a bare prefix: `abs.startsWith(HELM)` alone
  // would also accept a sibling like `<HELM>-secret`. The path.sep guard forbids that.
  if (abs !== HELM && !abs.startsWith(HELM + path.sep)) return null;
  return rel;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, body, type = 'text/html; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type });
    res.end(body);
  };
  try {
    if (url === '/' || url === '') return send(200, dashboard());
    if (url.startsWith('/doc/')) {
      const rel = safeRel(url, '/doc/');
      if (rel === null) return send(403, 'forbidden');
      const abs = path.join(HELM, rel);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return send(200, dirView(rel) || 'not found');
      const v = docView(rel);
      return v ? send(200, v) : send(404, page('404', `<p>not found: ${esc(rel)}</p>`));
    }
    if (url.startsWith('/raw/')) {
      const rel = safeRel(url, '/raw/');
      if (rel === null) return send(403, 'forbidden');
      const src = read(rel);
      return src === null ? send(404, 'not found', 'text/plain') : send(200, src, 'text/plain; charset=utf-8');
    }
    if (url.startsWith('/dir')) {
      const rel = safeRel(url, '/dir/') ?? '';
      const v = dirView(rel);
      return v ? send(200, v) : send(404, 'not found');
    }
    send(404, page('404', '<p>no such route</p>'));
  } catch (e) {
    send(500, page('error', `<pre>${esc(String(e && e.stack || e))}</pre>`));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`helm console: http://${HOST.startsWith('127.') ? 'localhost' : HOST}:${PORT}  (root: ${HELM})`);
});
