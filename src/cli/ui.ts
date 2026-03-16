import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { exec } from 'child_process'

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`
  exec(cmd)
}

export function serveInspectUI(outputDir: string, pdfPath?: string): void {
  const manifestPath = join(outputDir, 'manifest.json')
  const structurePath = join(outputDir, 'structure.json')
  const chunksPath   = join(outputDir, 'chunks.jsonl')
  const docPath      = join(outputDir, 'document.md')

  const manifest  = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  const structure = existsSync(structurePath)
    ? JSON.parse(readFileSync(structurePath, 'utf-8'))
    : null
  const chunks = existsSync(chunksPath)
    ? readFileSync(chunksPath, 'utf-8').trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
    : []
  const markdown = existsSync(docPath) ? readFileSync(docPath, 'utf-8') : ''
  const hasPdf = !!(pdfPath && existsSync(pdfPath))

  const payload = JSON.stringify({ manifest, structure, chunks, markdown, hasPdf })

  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(buildHtml())
    } else if (url === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(payload)
    } else if (url === '/api/pdf' && hasPdf) {
      const buf = readFileSync(pdfPath!)
      res.writeHead(200, { 'Content-Type': 'application/pdf' })
      res.end(buf)
    } else {
      res.writeHead(404); res.end()
    }
  })

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number }
    const url  = `http://127.0.0.1:${addr.port}`
    process.stderr.write(`\n  \u25c6  rag-chunker UI  \u2192  ${url}\n`)
    process.stderr.write(`     Press Ctrl+C to stop\n\n`)
    openBrowser(url)
  })

  process.on('SIGINT', () => { server.close(); process.exit(0) })
}

// ─── HTML ────────────────────────────────────────────────────────────────────
// NOTE: The JS block uses a separate variable so we never nest template
// literals — the single source of truth for escaping is the JS string itself.

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--surf:#161b22;--bdr:#30363d;--bdr2:#21262d;
  --txt:#e6edf3;--mut:#8b949e;--acc:#58a6ff;--grn:#3fb950;
  --yel:#d29922;--pur:#bc8cff;--org:#ffa657;
}
html,body{height:100%;background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.5}
#topbar{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--surf);border-bottom:1px solid var(--bdr);flex-wrap:wrap;position:sticky;top:0;z-index:100}
.brand{font-weight:700;color:var(--acc)}
.chip{display:inline-flex;align-items:center;padding:2px 8px;border-radius:12px;font-size:12px;background:var(--bdr2);border:1px solid var(--bdr);white-space:nowrap}
.chip.green{color:var(--grn)}.chip.blue{color:var(--acc)}.chip.yellow{color:var(--yel)}.chip.purple{color:var(--pur)}.chip.orange{color:var(--org)}
#pagenav{display:flex;align-items:center;gap:8px;padding:8px 16px;background:var(--surf);border-bottom:1px solid var(--bdr)}
.navbtn{background:var(--bdr2);border:1px solid var(--bdr);color:var(--txt);padding:4px 12px;border-radius:6px;cursor:pointer;font-size:13px}
.navbtn:hover{background:var(--bdr)}.navbtn:disabled{opacity:.35;cursor:default}
#pageinfo{font-size:13px;color:var(--mut);min-width:110px;text-align:center}
.spacer{flex:1}
.tbtn{background:transparent;border:1px solid var(--bdr);color:var(--mut);padding:3px 10px;border-radius:6px;cursor:pointer;font-size:12px}
.tbtn.on{background:var(--bdr2);color:var(--txt)}
#main{display:flex;height:calc(100vh - 88px);overflow:hidden}
#left,#right{flex:1;overflow-y:auto;padding:16px}
#left{border-right:1px solid var(--bdr)}
#md h1,#md h2,#md h3,#md h4{margin:14px 0 6px;border-bottom:1px solid var(--bdr2);padding-bottom:4px}
#md h1{font-size:1.4em}#md h2{font-size:1.2em}#md h3{font-size:1.05em;border:none}
#md p{margin:7px 0;color:#cdd5df}
#md ul,#md ol{padding-left:20px;margin:7px 0}#md li{margin:3px 0;color:#cdd5df}
#md code{background:#1c2128;padding:1px 5px;border-radius:4px;font-size:12px;font-family:monospace}
#md pre{background:#1c2128;padding:12px;border-radius:6px;overflow-x:auto;margin:10px 0}
#md pre code{background:none;padding:0}
#md table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13px}
#md th{background:var(--bdr2);padding:6px 10px;text-align:left;border:1px solid var(--bdr)}
#md td{padding:5px 10px;border:1px solid var(--bdr);color:#cdd5df}
#md tr:nth-child(even) td{background:#0a0d11}
#md strong,#md b{color:var(--txt)}
#raw{display:none;font-family:monospace;font-size:12px;color:#cdd5df;white-space:pre-wrap;word-break:break-word;line-height:1.6}
.sec{display:flex;align-items:baseline;gap:8px;margin-bottom:12px}
.sec-title{color:var(--txt);font-size:13px;font-weight:600}
.sec-meta{color:var(--mut);font-size:12px}
.card{border:1px solid var(--bdr);border-radius:8px;margin-bottom:10px;overflow:hidden;cursor:pointer;transition:border-color .15s}
.card:hover{border-color:var(--mut)}.card.open{border-color:var(--acc)}
.ch{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--surf);pointer-events:none}
.ci{color:var(--mut);font-size:11px;font-family:monospace;min-width:30px}
.tb{font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600;text-transform:uppercase}
.t-text{background:#1c3a2e;color:var(--grn)}.t-table{background:#2d2a1a;color:var(--yel)}
.t-code{background:#1a2540;color:var(--acc)}.t-mixed{background:#2a1a2d;color:var(--pur)}
.tok{color:var(--mut);font-size:11px;margin-left:auto}
.pb{font-size:10px;color:var(--org)}
.sp{padding:3px 12px 5px;font-size:11px;color:var(--mut);border-top:1px solid var(--bdr2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
/* preview — always visible */
.preview{padding:8px 12px 10px;font-size:12px;color:#9ca8b8;line-height:1.6;pointer-events:none;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
/* expanded body */
.cb{display:none;border-top:1px solid var(--bdr2);background:#0a0e13}
.card.open .cb{display:block}
.card.open .preview{-webkit-line-clamp:unset;overflow:visible}
.lbl{font-size:10px;color:var(--mut);font-weight:600;text-transform:uppercase;padding:10px 12px 4px}
.lbl:first-child{padding-top:12px}
.ctx{margin:0 12px 2px;background:#0f1923;border-left:3px solid var(--acc);padding:8px 10px;border-radius:0 4px 4px 0;font-size:13px;color:#cdd5df;line-height:1.65}
.full-content{margin:0 12px;background:#0d1117;border-radius:4px;padding:10px;font-family:monospace;font-size:11px;color:#8b949e;max-height:320px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;line-height:1.6}
.cid{font-family:monospace;font-size:11px;color:var(--mut);line-height:1.8;padding:8px 12px 12px}
.empty{color:var(--mut);font-size:13px;padding:20px 0;text-align:center}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--bdr);border-radius:3px}
`

// JS is a template literal — single/double quotes inside work without escaping
const JS = `
var DATA = null, pages = [], pageMap = {}, chunksByPage = {}, pageIdx = 0, showRaw = false;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderChips() {
  var m = DATA.manifest;
  var s = m.chunkStats || {};
  var st = DATA.structure;
  var ce = m.contextEnrichment;
  var hf = m.headingFix;
  var defs = [
    { l: (s.total || DATA.chunks.length) + ' chunks', c: 'blue' },
    { l: ((st && st.pageCount) || '?') + ' pages', c: 'green' },
    { l: m.ocrModel, c: 'yellow' },
    m.ocrCacheHit ? { l: 'OCR cached', c: 'green' } : null,
    (m.contextMode && m.contextMode !== 'none') ? { l: 'context: ' + m.contextMode, c: 'purple' } : null,
    (ce && ce.chunksEnriched > 0) ? { l: ce.chunksEnriched + ' enriched', c: 'purple' } : null,
    (hf && !hf.skipped) ? { l: hf.corrections + ' heading fixes', c: 'orange' } : null,
    { l: (m.durationMs / 1000).toFixed(1) + 's', c: 'blue' }
  ].filter(Boolean);
  document.getElementById('chips').innerHTML = defs
    .map(function(d) { return '<span class="chip ' + d.c + '">' + esc(d.l) + '</span>'; })
    .join(' ');
}

function parsePages() {
  var lines = DATA.markdown.split('\\n');
  var curPage = 1, segLines = [];
  for (var i = 0; i < lines.length; i++) {
    var pm = /^<!--\\s*page\\s+(\\d+)\\s*-->$/i.exec(lines[i].trim());
    if (pm) {
      if (segLines.length) pageMap[curPage] = (pageMap[curPage] || '') + segLines.join('\\n');
      curPage = parseInt(pm[1], 10);
      segLines = [];
    } else {
      segLines.push(lines[i]);
    }
  }
  if (segLines.length) pageMap[curPage] = (pageMap[curPage] || '') + segLines.join('\\n');
  pages = Object.keys(pageMap).map(Number).sort(function(a, b) { return a - b; });
  if (!pages.length) { pages = [1]; pageMap[1] = DATA.markdown; }
}

function parseChunks() {
  DATA.chunks.forEach(function(c) {
    var p = c.pageNumber || 1;
    if (!chunksByPage[p]) chunksByPage[p] = [];
    chunksByPage[p].push(c);
  });
}

function renderPage() {
  var pageNum = pages[pageIdx] || 1;
  var mdText  = pageMap[pageNum] || '';

  document.getElementById('pageinfo').textContent = 'Page ' + pageNum + ' / ' + pages[pages.length - 1];
  document.getElementById('btn-prev').disabled = (pageIdx === 0);
  document.getElementById('btn-next').disabled = (pageIdx === pages.length - 1);

  if (showRaw) {
    document.getElementById('md').style.display  = 'none';
    document.getElementById('raw').style.display = 'block';
    document.getElementById('raw').textContent   = mdText;
  } else {
    document.getElementById('md').style.display  = 'block';
    document.getElementById('raw').style.display = 'none';
    try {
      var html = (typeof marked !== 'undefined' && marked.parse)
        ? marked.parse(mdText)
        : mdText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>');
      document.getElementById('md').innerHTML = html;
    } catch(e) {
      document.getElementById('md').textContent = mdText;
    }
  }

  renderChunkList(pageNum);
}

function renderChunkList(pageNum) {
  var pc   = chunksByPage[pageNum] || [];
  var list = document.getElementById('chunk-list');

  // section header
  document.getElementById('chunk-sec').innerHTML =
    '<span class="sec-title">' + pc.length + ' chunk' + (pc.length !== 1 ? 's' : '') + '</span>' +
    '<span class="sec-meta">page ' + pageNum + '</span>';

  if (!pc.length) { list.innerHTML = '<div class="empty">No chunks extracted from this page</div>'; return; }

  var parts = [];
  for (var i = 0; i < pc.length; i++) {
    var c  = pc[i];
    var sp = (c.sectionPath && c.sectionPath.length) ? c.sectionPath.join(' \u203a ') : '\u2014';
    var hasCtx = !!(c.contextSummary && c.contextSummary.length > 0);

    // collapsed header row
    var card = '<div class="card">';
    card += '<div class="ch">';
    card += '<span class="ci">#' + c.index + '</span>';
    card += '<span class="tb t-' + c.contentType + '">' + c.contentType + '</span>';
    if (c.mustPreserve) card += '<span class="pb">\u25a0 preserved</span>';
    card += '<span class="tok">' + c.tokenCount + ' tok</span>';
    card += '</div>';

    // section breadcrumb
    card += '<div class="sp" title="' + esc(sp) + '">' + esc(sp) + '</div>';

    // preview — always visible, clipped to 3 lines; full when open
    card += '<div class="preview">' + esc(c.rawContent) + '</div>';

    // expanded section
    var body = '';
    if (hasCtx) {
      body += '<div class="lbl">Context Summary</div>';
      body += '<div class="ctx">' + esc(c.contextSummary) + '</div>';
    }
    body += '<div class="lbl">Full Content</div>';
    body += '<div class="full-content">' + esc(c.rawContent) + '</div>';
    body += '<div class="lbl">Metadata</div>';
    body += '<div class="cid">';
    body += 'id: ' + esc(c.chunkId) + '<br>';
    body += 'page: ' + c.pageNumber + ' &nbsp;\u00b7&nbsp; ';
    body += 'tokens: ' + c.tokenCount + ' &nbsp;\u00b7&nbsp; ';
    body += 'type: ' + c.contentType;
    body += '</div>';

    card += '<div class="cb">' + body + '</div>';
    card += '</div>';
    parts.push(card);
  }
  list.innerHTML = parts.join('');
}

document.addEventListener('DOMContentLoaded', function() {
  // toggle card open/close via event delegation — no inline onclick needed
  document.getElementById('chunk-list').addEventListener('click', function(e) {
    var target = e.target;
    while (target && target !== this) {
      if (target.classList && target.classList.contains('card')) {
        target.classList.toggle('open');
        return;
      }
      target = target.parentElement;
    }
  });

  document.getElementById('btn-prev').addEventListener('click', function() {
    if (pageIdx > 0) { pageIdx--; renderPage(); }
  });
  document.getElementById('btn-next').addEventListener('click', function() {
    if (pageIdx < pages.length - 1) { pageIdx++; renderPage(); }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowLeft'  && pageIdx > 0)               { pageIdx--; renderPage(); }
    if (e.key === 'ArrowRight' && pageIdx < pages.length - 1) { pageIdx++; renderPage(); }
  });
  document.getElementById('btn-rendered').addEventListener('click', function() {
    showRaw = false;
    document.getElementById('btn-rendered').classList.add('on');
    document.getElementById('btn-raw').classList.remove('on');
    renderPage();
  });
  document.getElementById('btn-raw').addEventListener('click', function() {
    showRaw = true;
    document.getElementById('btn-raw').classList.add('on');
    document.getElementById('btn-rendered').classList.remove('on');
    renderPage();
  });

  fetch('/api/data')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      DATA = d;
      renderChips();
      parsePages();
      parseChunks();
      renderPage();
    })
    .catch(function(e) {
      document.getElementById('left').innerHTML = '<div class="empty">Error loading data: ' + e + '</div>';
    });
});
`

function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>rag-chunker inspector</title>
<style>${CSS}</style>
</head>
<body>
<div id="topbar">
  <span class="brand">&#9670; rag-chunker</span>
  <span id="chips"></span>
  <span class="spacer"></span>
</div>
<div id="pagenav">
  <button class="navbtn" id="btn-prev">&#8592;</button>
  <span id="pageinfo">loading&#8230;</span>
  <button class="navbtn" id="btn-next">&#8594;</button>
  <span class="spacer"></span>
  <button class="tbtn on" id="btn-rendered">Rendered</button>
  <button class="tbtn" id="btn-raw">Raw</button>
</div>
<div id="main">
  <div id="left">
    <div id="md"></div>
    <div id="raw"></div>
  </div>
  <div id="right">
    <div class="sec" id="chunk-sec"></div>
    <div id="chunk-list"></div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js"></script>
<script>${JS}</script>
</body>
</html>`
}
