/* global marked */
;(() => {
  let data = null
  let pages = []
  const pageText = new Map()
  const chunksByPage = new Map()
  let pageIndex = 0
  let view = 'rendered'
  let query = ''
  let selectedId = null

  const $ = (id) => document.getElementById(id)

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // Raw HTML inside OCR output is shown as text, never executed.
  if (typeof marked !== 'undefined') {
    marked.use({ renderer: { html: (token) => esc(token.text) } })
  }

  function renderMarkdown(text) {
    if (typeof marked === 'undefined') return `<pre>${esc(text)}</pre>`
    try {
      return marked.parse(text)
    } catch {
      return `<pre>${esc(text)}</pre>`
    }
  }

  function chip(label, on) {
    return `<span class="chip${on ? ' on' : ''}">${esc(label)}</span>`
  }

  function renderHeader() {
    const m = data.manifest
    const s = m.stages
    $('title').textContent = m.source.name
    const chips = [
      chip(`${s.chunk.count} chunks`),
      chip(`${data.structure ? data.structure.pageCount : '?'} pages`),
      chip(`OCR: ${s.ocr.model}`),
      s.structure ? chip(`headings: ${s.structure.corrections} fixed`, true) : '',
      s.context ? chip(`context: ${s.context.model} (${s.context.strategy})`, true) : chip('context: off'),
      s.embedding
        ? chip(`embedding: ${s.embedding.model} · ${s.embedding.dimensions}d`, true)
        : chip('embedding: off'),
      chip(`${(m.durationMs / 1000).toFixed(1)}s`),
      chip(`v${m.version}`),
    ]
    $('chips').innerHTML = chips.join('')
    if (m.warnings.length > 0) {
      const box = $('warnings')
      box.hidden = false
      box.querySelector('summary').textContent = `${m.warnings.length} warning(s)`
      box.querySelector('ul').innerHTML = m.warnings.map((w) => `<li>${esc(w)}</li>`).join('')
    }
  }

  function parsePages() {
    const re = /<!--\s*page\s+(\d+)\s*-->/gi
    const text = data.markdown
    const matches = [...text.matchAll(re)]
    if (matches.length === 0) {
      pageText.set(1, text)
    } else {
      matches.forEach((m, i) => {
        const start = m.index + m[0].length
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length
        const n = Number(m[1])
        pageText.set(n, ((pageText.get(n) || '') + text.slice(start, end)).trim())
      })
    }
    for (const c of data.chunks) {
      for (let p = c.pageStart; p <= c.pageEnd; p++) {
        if (!chunksByPage.has(p)) chunksByPage.set(p, [])
        chunksByPage.get(p).push(c)
      }
      if (!pageText.has(c.pageStart)) pageText.set(c.pageStart, '')
    }
    pages = [...pageText.keys()].sort((a, b) => a - b)
    if (pages.length === 0) pages = [1]
  }

  function highlight(text) {
    const safe = esc(text)
    if (!query) return safe
    const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return safe.replace(new RegExp(q, 'gi'), (m) => `<mark>${m}</mark>`)
  }

  function card(c) {
    const path = c.sectionPath?.length ? c.sectionPath.join(' › ') : '—'
    const pagesLabel = c.pageStart === c.pageEnd ? `p${c.pageStart}` : `p${c.pageStart}–${c.pageEnd}`
    let body = ''
    if (c.contextSummary)
      body += `<div class="label">Context</div><div class="ctx">${esc(c.contextSummary)}</div>`
    body += '<div class="label">Metadata</div>'
    const boxes = c.boxes?.length ? ` · ${c.boxes.length} box${c.boxes.length > 1 ? 'es' : ''}` : ''
    body += `<div class="meta">id ${esc(c.chunkId)}<br>${pagesLabel} · ${c.tokenCount} tokens · ${esc(c.ocrSource)}${c.embedding?.length ? ` · ${c.embedding.length}d vector` : ''}${boxes}</div>`
    body += `<button class="jump" data-page="${c.pageStart}">Go to page ${c.pageStart}</button>`
    return (
      `<div class="card${c.chunkId === selectedId ? ' selected' : ''}" data-id="${esc(c.chunkId)}">` +
      `<div class="card-head"><span class="idx">#${c.index}</span><span class="type ${c.contentType}">${c.contentType}</span>` +
      `${c.mustPreserve ? '<span class="idx">preserved</span>' : ''}<span class="tok">${pagesLabel} · ${c.tokenCount} tok</span></div>` +
      `<div class="path" title="${esc(path)}">${esc(path)}</div>` +
      `<div class="preview">${highlight(c.rawContent)}</div>` +
      `<div class="body">${body}</div></div>`
    )
  }

  function renderList() {
    let list
    let headerText
    if (query) {
      const q = query.toLowerCase()
      list = data.chunks.filter(
        (c) =>
          c.rawContent.toLowerCase().includes(q) ||
          (c.contextSummary || '').toLowerCase().includes(q) ||
          (c.sectionPath || []).join(' ').toLowerCase().includes(q),
      )
      headerText = `<b>${list.length}</b> match(es) for “${esc(query)}”`
    } else {
      const p = pages[pageIndex]
      list = chunksByPage.get(p) || []
      headerText = `<b>${list.length}</b> chunk(s) on page ${p}`
    }
    $('list-header').innerHTML = headerText
    $('chunk-list').innerHTML = list.length ? list.map(card).join('') : '<div class="empty">No chunks</div>'
  }

  function renderPage() {
    const p = pages[pageIndex]
    $('pageinfo').textContent = `Page ${p} / ${pages[pages.length - 1]}`
    $('prev').disabled = pageIndex === 0
    $('next').disabled = pageIndex === pages.length - 1
    const text = pageText.get(p) || ''
    $('rendered').hidden = view !== 'rendered'
    $('raw').hidden = view !== 'raw'
    $('pdf').hidden = view !== 'pdf'
    if (view === 'rendered')
      $('rendered').innerHTML = text ? renderMarkdown(text) : '<div class="empty">No text on this page</div>'
    if (view === 'raw') $('raw').textContent = text
    if (view === 'pdf') {
      $('pdf-img').src = `/api/page/${p}.png`
      renderBoxes(p)
    }
    renderList()
  }

  // Chunk positions are fractions of the page, so the overlay scales with the image.
  function renderBoxes(page) {
    const html = []
    for (const c of chunksByPage.get(page) || []) {
      for (const b of c.boxes || []) {
        if (b.page !== page) continue
        const style = `left:${(b.x * 100).toFixed(2)}%;top:${(b.y * 100).toFixed(2)}%;width:${(b.w * 100).toFixed(2)}%;height:${(b.h * 100).toFixed(2)}%`
        html.push(
          `<div class="pdf-box${c.chunkId === selectedId ? ' active' : ''}" data-id="${esc(c.chunkId)}" style="${style}" title="#${c.index}"></div>`,
        )
      }
    }
    $('pdf-boxes').innerHTML = html.join('')
  }

  function select(id) {
    selectedId = selectedId === id ? null : id
    for (const el of document.querySelectorAll('.card'))
      el.classList.toggle('selected', el.dataset.id === selectedId)
    for (const el of document.querySelectorAll('.pdf-box'))
      el.classList.toggle('active', el.dataset.id === selectedId)
  }

  function goTo(page) {
    const i = pages.indexOf(page)
    if (i >= 0) {
      pageIndex = i
      query = ''
      $('search').value = ''
      renderPage()
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('prev').addEventListener('click', () => {
      if (pageIndex > 0) {
        pageIndex--
        renderPage()
      }
    })
    $('next').addEventListener('click', () => {
      if (pageIndex < pages.length - 1) {
        pageIndex++
        renderPage()
      }
    })
    document.addEventListener('keydown', (e) => {
      if (e.target === $('search')) return
      if (e.key === 'ArrowLeft') $('prev').click()
      if (e.key === 'ArrowRight') $('next').click()
    })
    for (const btn of document.querySelectorAll('.toggle')) {
      btn.addEventListener('click', () => {
        view = btn.dataset.view
        for (const b of document.querySelectorAll('.toggle')) b.classList.toggle('on', b === btn)
        renderPage()
      })
    }
    $('search').addEventListener('input', (e) => {
      query = e.target.value.trim()
      renderList()
    })
    $('chunk-list').addEventListener('click', (e) => {
      const jump = e.target.closest('.jump')
      if (jump) {
        goTo(Number(jump.dataset.page))
        return
      }
      const head = e.target.closest('.card-head, .preview, .path')
      if (head) {
        const cardEl = head.closest('.card')
        cardEl.classList.toggle('open')
        select(cardEl.dataset.id)
      }
    })
    $('pdf-boxes').addEventListener('click', (e) => {
      const box = e.target.closest('.pdf-box')
      if (!box) return
      select(box.dataset.id)
      const cardEl = document.querySelector(`.card[data-id="${CSS.escape(box.dataset.id)}"]`)
      if (cardEl) {
        cardEl.classList.add('open')
        cardEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    })

    fetch('/api/data')
      .then((r) => r.json())
      .then((d) => {
        data = d
        if (d.hasPdf) $('pdf-toggle').hidden = false
        renderHeader()
        parsePages()
        renderPage()
      })
      .catch((e) => {
        $('rendered').innerHTML = `<div class="empty">Could not load data: ${esc(e)}</div>`
      })
  })
})()
