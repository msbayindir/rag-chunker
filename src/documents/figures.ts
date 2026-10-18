import type { LayoutRegion, PageLike } from '../local/layout.js'
import type { Rect } from './tables.js'

/**
 * Figures on a page: where they are (embedded raster images from the content stream; with layout
 * analysis also charts and drawings), which caption belongs to them, and what the output calls
 * them. Cropping and saving is the caller's job (a `FigureSink`), so the text layer stays pure.
 */

export type FigureLabel = 'image' | 'chart'

export interface FigureData {
  /** Path of the PNG relative to the output folder, e.g. `figures/p3-1.png`. */
  file: string
  /** `image` (photo, drawing, embedded picture) or `chart` (layout model). */
  label: FigureLabel
  /** Caption found next to the figure on the page, when any. */
  caption?: string
  /** Description written by a vision model, when `figures.describe` is on. */
  description?: string
}

/** A figure cropped out of a page, kept in memory until the output folder is written. */
export interface FigureFile {
  /** Path relative to the output folder (`figures/p3-1.png`). */
  file: string
  bytes: Uint8Array
  page: number
  /** Position on the page as fractions of its size (origin top-left). */
  box: { x: number; y: number; w: number; h: number }
  label: FigureLabel
  caption?: string
  description?: string
}

export interface FigureCandidate {
  bbox: Rect
  label: FigureLabel
  score: number
  /** Reading-order rank of the layout region, when one produced the candidate. */
  order?: number
}

/** Saves a figure (crop of the page) and returns what the markdown should reference; null skips it. */
export type FigureSink = (
  doc: PageLike,
  pageNumber: number,
  figure: FigureRequest,
) => Promise<FigureData | null>

/** What a reader knows about a figure before it is saved. */
export interface FigureRequest {
  bbox: Rect
  label: FigureLabel
  caption?: string
  /** A line of page text next to the figure (tells a describing model the document's language). */
  nearby?: string
}

export interface LineLike {
  text: string
  y: number
  x0: number
  x1: number
  size: number
  label?: string
}

/** "Figure 3", "Fig. 2a", "Şekil 1:", "Grafik 4", "Abbildung 2", "Figura 1"… at the start of a line. */
export const CAPTION_RE =
  /^(?:fig(?:ure|\.)?|şekil|grafik|resim|görsel|chart|abb(?:ildung|\.)|figura|image|diagram|plate|photo)\s*\.?\s*(?:\d|[a-z]\d|[ivx]+\b|:)/iu

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0)
/** Share of `a` covered by `b`. */
const coverage = (a: Rect, b: Rect) => {
  const inter = overlap(a.x0, a.x1, b.x0, b.x1) * overlap(a.y0, a.y1, b.y0, b.y1)
  const own = area(a)
  return own > 0 ? inter / own : 0
}
const union = (a: Rect, b: Rect): Rect => ({
  x0: Math.min(a.x0, b.x0),
  x1: Math.max(a.x1, b.x1),
  y0: Math.min(a.y0, b.y0),
  y1: Math.max(a.y1, b.y1),
})
const touching = (a: Rect, b: Rect, gap: number) =>
  overlap(a.x0 - gap, a.x1 + gap, b.x0, b.x1) > 0 && overlap(a.y0 - gap, a.y1 + gap, b.y0, b.y1) > 0

/** Joins image rectangles that overlap or touch (images drawn in strips or tiles are one picture). */
export function mergeImageRects(rects: Rect[], gap = 3): Rect[] {
  const out = rects.map((r) => ({ ...r }))
  let merged = true
  while (merged) {
    merged = false
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i] as Rect
        const b = out[j] as Rect
        if (!touching(a, b, gap)) continue
        out[i] = union(a, b)
        out.splice(j, 1)
        merged = true
        break
      }
    }
  }
  return out
}

/**
 * Figure regions of a page. Layout `image`/`chart` regions come first; embedded raster images add
 * what the model did not see (or everything, without a model). Icons, logos, watermarks, full-page
 * scans and pictures that a text/table region explains are left out.
 */
export function figureCandidates(args: {
  lines: LineLike[]
  regions: LayoutRegion[] | null
  images: Rect[]
  page: { width: number; height: number }
  /** Smallest figure kept, as a share of the page area. */
  minSize: number
}): FigureCandidate[] {
  const { lines, regions, images, page } = args
  const pageArea = page.width * page.height
  const minArea = Math.max(args.minSize * pageArea, 24 * 24)
  const clip = (r: Rect): Rect => ({
    x0: Math.max(0, r.x0),
    x1: Math.min(page.width, r.x1),
    y0: Math.max(0, r.y0),
    y1: Math.min(page.height, r.y1),
  })
  const sized = (r: Rect) => {
    const a = area(r)
    return a >= minArea && a <= pageArea * 0.8 && r.x1 - r.x0 >= 24 && r.y1 - r.y0 >= 24
  }
  const out: FigureCandidate[] = []
  for (const r of regions ?? []) {
    if (r.label !== 'image' && r.label !== 'chart') continue
    const bbox = clip(r.bbox)
    if (!sized(bbox)) continue
    // The same picture detected twice (as image and as chart): the surer one stays.
    const twin = out.find((c) => coverage(c.bbox, bbox) >= 0.5 && coverage(bbox, c.bbox) >= 0.5)
    if (twin) {
      if (r.score > twin.score) Object.assign(twin, { bbox, label: r.label, score: r.score, order: r.order })
      continue
    }
    out.push({ bbox, label: r.label, score: r.score, order: r.order })
  }
  const others = (regions ?? []).filter((r) => r.label !== 'image' && r.label !== 'chart')
  // Full-page images (scans, backgrounds) are left out before merging, or they would swallow the rest.
  const rasters = images.map(clip).filter((r) => area(r) > 0 && area(r) <= pageArea * 0.8)
  for (const raw of mergeImageRects(rasters)) {
    const bbox = clip(raw)
    if (!sized(bbox)) continue
    if (out.some((c) => coverage(bbox, c.bbox) >= 0.5 || coverage(c.bbox, bbox) >= 0.5)) continue
    // A picture inside a text, table or furniture region is background, a logo or a table fill.
    if (others.some((r) => coverage(bbox, r.bbox) >= 0.6)) continue
    // Many long text lines over the picture: a watermark or a background, not a figure.
    const inside = lines.filter(
      (l) =>
        l.y + l.size * 0.35 > bbox.y0 &&
        l.y + l.size * 0.35 < bbox.y1 &&
        overlap(l.x0, l.x1, bbox.x0, bbox.x1) > (l.x1 - l.x0) * 0.5 &&
        l.x1 - l.x0 > (bbox.x1 - bbox.x0) * 0.5,
    )
    if (inside.length >= 6) continue
    out.push({ bbox, label: 'image', score: 1 })
  }
  return out.sort((a, b) => b.bbox.y1 - a.bbox.y1 || a.bbox.x0 - b.bbox.x0)
}

const MAX_CAPTION_GAP = 60
const MAX_CAPTION = 300

/** Caption lines joined; a word broken with a hyphen at a line end is mended. */
function joinCaption(parts: string[]): string {
  let out = ''
  for (const part of parts) {
    const t = part.replace(/\s+/g, ' ').trim()
    if (t === '') continue
    if (out === '') out = t
    else if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(t)) out = out.slice(0, -1) + t
    else out = `${out} ${t}`
  }
  return out.slice(0, MAX_CAPTION)
}

/**
 * The caption of a figure: the nearest `figure_title` region above or below it when layout
 * analysis ran, otherwise the nearest line below (then above) that starts like a caption, with the
 * lines that continue it.
 */
export function captionFor(
  figure: Rect,
  lines: LineLike[],
  regions: LayoutRegion[] | null,
): { text: string; bbox: Rect } | null {
  const horizontally = (r: Rect) =>
    overlap(r.x0, r.x1, figure.x0, figure.x1) >= 0.3 * Math.min(r.x1 - r.x0, figure.x1 - figure.x0)
  const gapOf = (r: Rect) => (r.y1 <= figure.y0 ? figure.y0 - r.y1 : r.y0 >= figure.y1 ? r.y0 - figure.y1 : 0)
  if (regions) {
    const titles = regions
      .filter((r) => r.label === 'figure_title' && horizontally(r.bbox) && gapOf(r.bbox) <= MAX_CAPTION_GAP)
      .sort((a, b) => gapOf(a.bbox) - gapOf(b.bbox))
    for (const t of titles) {
      const inside = lines
        .filter((l) => {
          const cy = l.y + l.size * 0.35
          const cx = (l.x0 + l.x1) / 2
          return cy >= t.bbox.y0 && cy <= t.bbox.y1 && cx >= t.bbox.x0 && cx <= t.bbox.x1
        })
        .sort((a, b) => b.y - a.y || a.x0 - b.x0)
      if (inside.length > 0) return { text: joinCaption(inside.map((l) => l.text)), bbox: t.bbox }
    }
    return null
  }
  const near = (l: LineLike) => horizontally({ x0: l.x0, x1: l.x1, y0: l.y, y1: l.y + l.size })
  const below = lines
    .filter((l) => l.y < figure.y0 + 2 && figure.y0 - l.y <= MAX_CAPTION_GAP && near(l))
    .sort((a, b) => b.y - a.y)
  const above = lines
    .filter((l) => l.y > figure.y1 - 2 && l.y - figure.y1 <= MAX_CAPTION_GAP && near(l))
    .sort((a, b) => a.y - b.y)
  const follow = (start: LineLike, pool: LineLike[]) => {
    const parts = [start]
    let prev = start
    for (const l of pool) {
      if (l.y >= prev.y) continue
      if (prev.y - l.y > l.size * 1.6 || CAPTION_RE.test(l.text) || parts.length >= 4) break
      parts.push(l)
      prev = l
    }
    return parts
  }
  const belowStart = below.find((l) => CAPTION_RE.test(l.text))
  if (belowStart) {
    const parts = follow(belowStart, below)
    return { text: joinCaption(parts.map((l) => l.text)), bbox: boxOf(parts) }
  }
  const aboveStart = above.find((l) => CAPTION_RE.test(l.text))
  if (aboveStart) {
    const pool = lines.filter((l) => l.y < aboveStart.y && l.y > figure.y1 - 2).sort((a, b) => b.y - a.y)
    const parts = follow(aboveStart, pool)
    return { text: joinCaption(parts.map((l) => l.text)), bbox: boxOf(parts) }
  }
  return null
}

function boxOf(lines: LineLike[]): Rect {
  return {
    x0: Math.min(...lines.map((l) => l.x0)),
    x1: Math.max(...lines.map((l) => l.x1)),
    y0: Math.min(...lines.map((l) => l.y - l.size * 0.25)),
    y1: Math.max(...lines.map((l) => l.y + l.size * 0.8)),
  }
}

/** The text line closest to the figure (above or below, overlapping it horizontally), if any. */
export function nearbyText(figure: Rect, lines: LineLike[]): string | undefined {
  let best: LineLike | undefined
  let bestGap = 120
  for (const l of lines) {
    if (overlap(l.x0, l.x1, figure.x0, figure.x1) <= 0) continue
    const gap = l.y >= figure.y1 ? l.y - figure.y1 : l.y + l.size <= figure.y0 ? figure.y0 - l.y - l.size : -1
    if (gap < 0 || gap >= bestGap || l.text.trim().length < 12) continue
    best = l
    bestGap = gap
  }
  return best?.text.replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** Alt text for the markdown image: the caption, else the kind of figure. */
export function altText(caption: string | undefined, label: FigureLabel): string {
  const clean = (caption ?? '')
    .replace(/[[\]\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return clean || (label === 'chart' ? 'Chart' : 'Figure')
}
