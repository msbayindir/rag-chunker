# @msbayindir/rag-chunker — Teknik Spesifikasyon

> **Bu döküman orijinal prompt'un netleştirilmiş, belirsizlikleri giderilmiş versiyonudur.**
> Her kritik karar `→ KARAR:` etiketiyle işaretlenmiştir.

---

## 1. Paket Tanımı ve Tek Sorumluluk

PDF al → Anlamlı küçük chunk'lara böl → Her chunk'a Gemini ile
doküman bağlamını anlatan `contextSummary` ekle → RAG'a hazır çıktı ver.

Bu paket Anthropic'in **Contextual Retrieval** yaklaşımını uygular:
her küçük chunk, tüm dokümanın bağlamıyla zenginleştirilir.
Böylece retrieval sırasında chunk'ın dokümandaki yeri ve anlamı kaybolmaz.

**Scope DIŞI:** Depolama, retrieval, embedding pipeline yönetimi, vektör DB entegrasyonu.

---

## 2. Ortam Kısıtları

- **Hedef:** Node.js 20+
- **Browser desteği:** Bu versiyonun scope'u DIŞINDADIR (README'de açıkça belirtilir)
- **Modül sistemi:** ESM (`"type": "module"`)

---

## 3. SDK ve Bağımlılıklar

```
Paket adı:   @msbayindir/rag-chunker

dependencies:
  pdf-lib    → sadece sayfa bölme
  zod        → LLM çıktısı doğrulama
  pino       → loglama

peerDependencies:
  @google/genai: "^1.0.0"   → zorunlu
  openai:        "^4.0.0"   → opsiyonel (sadece OpenAI embedding provider kullanılıyorsa)
```

> **UYARI:** `@google/generative-ai` eski SDK'dır. Bu projede **kesinlikle kullanılmaz.**
> Tüm Gemini çağrıları `@google/genai` üzerinden yapılır. Ana sınıf: `GoogleGenAI`.

---

## 4. Mimari Prensipler

1. **Tek tip pipeline.** Metin veya görsel PDF ayrımı YAPILMAZ. Gemini File API'ye yüklenen PDF, Gemini tarafından hem görsel hem metin olarak işlenir. Bu pakette `pdfjs-dist` veya başka bir metin extraction aracı kullanılmaz. `pdf-lib` sadece sayfaları bölmek için kullanılır.

2. **Global cache + lokal odak.** PDF bir kez yüklenir, tüm doküman context cache'e alınır. Her LLM çağrısı 15'erli sayfa grubunun buffer'ıyla yapılır. Model tüm bağlamı bilir ama sadece 15 sayfaya odaklanır.

3. **Deterministic önce, LLM sonra.** Sayfa gruplama `pdf-lib` ile deterministik yapılır. LLM sadece chunk sınırı belirleme, `contentHint` ve `contextSummary` için kullanılır.

4. **Her chunk bağımsız başarısız olabilir.** Partial success her zaman mümkündür. Bir chunk'ın hatası diğerlerini durdurmamalıdır.

5. **Mimari stil: FUNCTION-BASED.** Class kullanılmaz. Her modül pure function veya factory function export eder.

---

## 5. Tip Tanımları (TypeScript, Eksiksiz)

```typescript
// ─── Gemini API referansları ─────────────────────────────────────────────────

/** ai.files.upload() sonucu */
interface FileRef {
  name: string      // "files/abc123xyz" — silme vs. için
  uri: string       // "https://generativelanguage.googleapis.com/v1beta/files/..." — API çağrılarında kullanılır
  mimeType: string  // "application/pdf"
}

/** ai.caches.create() sonucu */
interface CacheRef {
  name: string        // "cachedContents/abc123xyz" — cachedContent parametresinde kullanılır
  model: string       // "models/gemini-1.5-pro" — SDK'nın döndürdüğü tam path
  expireTime: string  // ISO 8601 string, örn. "2024-01-01T00:00:00Z"
}

// ─── Pipeline tipleri ────────────────────────────────────────────────────────

interface PageGroup {
  pageRange: { start: number; end: number }  // 1-based, inclusive
  buffer: Uint8Array                          // pdf-lib'den dönen PDF buffer
}

/** determineChunks() ham çıktısı (Zod'dan geçmiş) */
interface RawChunk {
  pages: number[]                              // Gemini'nin verdiği sayfa numaraları
  text: string
  contentHint: 'table' | 'narrative' | 'qa' | 'mixed'
  groupIndex: number                           // hangi PageGroup'tan geldi
}

// ─── Kullanıcıya dönen tipler ────────────────────────────────────────────────

interface ChunkResult {
  chunkIndex: number                           // Global, 0-tabanlı, tüm pipeline'da sıralı
  pageRange: { start: number; end: number }    // min(pages) / max(pages)
  text: string
  contextSummary: string                       // '' olabilir (failedSteps: ['context'])
  contentHint: 'table' | 'narrative' | 'qa' | 'mixed'
  embedding?: number[]                         // embeddingProvider yoksa field gelmez
  status: 'success' | 'partial' | 'error' | 'timeout'
  failedSteps?: Array<'context' | 'embedding'>
}

interface ChunkerResult {
  chunks: ChunkResult[]
  cacheUsed: boolean
  totalPages: number
  durationMs: number
}

// ─── status mantığı ──────────────────────────────────────────────────────────
// → KARAR:
//   'error'   → determineChunks() tamamen başarısız (text yok)
//   'partial' → text var, ama failedSteps.length > 0 (context veya embedding başarısız)
//   'success' → tüm adımlar başarılı (failedSteps yok veya boş dizi)
//   'timeout' → chunk işleme başlamadan önce timeout/abort sinyali geldi
```

---

## 6. Ana Fonksiyon İmzası

```typescript
// → KARAR: chunk() fonksiyonu aşağıdaki imzaya sahiptir.
// Hem Buffer hem Uint8Array kabul edilir (pdf-lib Uint8Array döner).

export async function chunk(
  pdfBuffer: Buffer | Uint8Array,
  config: ChunkerConfig
): Promise<ChunkerResult>
```

---

## 7. Tam Pipeline Akışı

### ADIM 1 — PDF Yükleme (bir kez)

```
Fonksiyon: uploadPdf(buffer, config) → FileRef
```

**Implementasyon:**
```typescript
import { GoogleGenAI } from '@google/genai'

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey })

// Buffer → Blob dönüşümü (Node.js 20+ globalinde Blob mevcuttur)
const blob = new Blob([buffer], { type: 'application/pdf' })

const uploaded = await ai.files.upload({
  file: blob,
  config: { mimeType: 'application/pdf' }
})

// uploaded: { name, uri, mimeType, sizeBytes, createTime, expirationTime, state }
const fileRef: FileRef = {
  name: uploaded.name,
  uri: uploaded.uri,
  mimeType: uploaded.mimeType ?? 'application/pdf'
}
```

- Hata → `throw` (pipeline durur)
- Dosyalar **48 saat** sonra otomatik silinir
- Maksimum dosya boyutu: **2 GB**

---

### ADIM 2 — Global Context Cache (bir kez)

```
Fonksiyon: createCache(fileRef, config) → CacheRef | null
```

**Implementasyon:**
```typescript
// → KARAR: Cache içeriği sadece PDF dosyasıdır. systemInstruction cache'e EKLENMEZ.
// Sebep: determineChunks ve generateContext farklı talimatlar kullanır.
// Talimatlar her çağrıda contents içinde { text: prompt } olarak gönderilir.

const cache = await ai.caches.create({
  model: config.geminiModel,   // kısa isim, örn. "gemini-1.5-pro"
  config: {
    contents: [{
      role: 'user',
      parts: [{ fileData: { mimeType: 'application/pdf', fileUri: fileRef.uri } }]
    }],
    ttl: '86400s'              // 24 saat (dosya ömrüyle örtüşür)
  }
})

// cache: { name, model, expireTime, ... }
const cacheRef: CacheRef = {
  name: cache.name,            // "cachedContents/abc123" — generateContent'te cachedContent olarak kullanılır
  model: cache.model,          // "models/gemini-1.5-pro" — bilgilendirme amaçlı
  expireTime: cache.expireTime // ISO 8601 string
}
```

- Hata → `throw` DEĞİL, `null` döner + `warn` log
- Log: `"Context cache oluşturulamadı, fileRef ile devam ediliyor"`
- `~32K token` altı PDF'lerde başarısız olabilir — bu **hata değil**, beklenen durumdur
- `cacheUsed: false` olarak işaretlenir

---

### ADIM 3 — 15'erli Sayfa Gruplarına Bölme (bir kez, deterministik)

```
Fonksiyon: splitIntoGroups(buffer, config) → PageGroup[]
Araç:      pdf-lib — SADECE sayfa bölme
```

**Config uygulama sırası:**
1. `pageRange` varsa sadece o aralığı al (1-based, inclusive)
2. `maxPages` varsa ilk N sayfa
3. `groupSize` (default: 15) ile grupla

**Çıktı:** Her `PageGroup.buffer` bir `Uint8Array`'dir (pdf-lib'in `save()` metodundan).

```typescript
// buffer → base64 dönüşümü (Gemini'ye gönderim için)
const base64 = Buffer.from(group.buffer).toString('base64')
```

- Hata → `throw` (pipeline durur)

---

### ADIM 4 — AI Chunk Belirleme (her PageGroup, paralel)

```
Fonksiyon: determineChunks(group, fileRef, cacheRef, config) → RawChunk[]
```

**System Prompt (contents içinde, text olarak gönderilir):**
```
Sen bir belge analisti ve içerik yapılandırma uzmanısın.
global_referans: Tüm doküman bağlamını anlamak için kullan.
lokal_odak: Sadece bu sayfa grubunu işle, dışına çıkma.
Görev: Bu sayfaları mantıksal içerik birimlerine böl.
Kural: Tek konu, tablo, soru grubu veya paragraf grubu = 1 birim.
Kural: Yarım konu, yarım tablo, yarım soru BÖLME.
Kural: Her birimin metni eksiksiz ve bağımsız anlaşılabilir olmalı.
Her birim için: hangi sayfalar, metnin kendisi ve içerik tipi.
ÇIKTI: Sadece JSON.
{
  "chunks": [{
    "pages": [1, 2],
    "text": "...",
    "contentHint": "table | narrative | qa | mixed"
  }]
}
```

**Gemini Çağrı Yapısı — Cache MEVCUT:**
```typescript
const response = await ai.models.generateContent({
  model: config.geminiModel,
  contents: [{
    role: 'user',
    parts: [
      // lokal odak: bu 15 sayfalık grup
      { inlineData: { mimeType: 'application/pdf', data: groupBase64 } },
      // talimat
      { text: chunkingSystemPrompt }
    ]
  }],
  config: {
    // global bağlam: tüm PDF cache'den geliyor
    cachedContent: cacheRef.name
    // NOT: cachedContent kullanıldığında config içinde systemInstruction KULLANILAMAZ
  }
})
```

**Gemini Çağrı Yapısı — Cache YOKSA (fileRef fallback):**
```typescript
const response = await ai.models.generateContent({
  model: config.geminiModel,
  contents: [{
    role: 'user',
    parts: [
      // global bağlam: tüm PDF
      { fileData: { mimeType: 'application/pdf', fileUri: fileRef.uri } },
      // lokal odak: bu 15 sayfalık grup
      { inlineData: { mimeType: 'application/pdf', data: groupBase64 } },
      // talimat
      { text: chunkingSystemPrompt }
    ]
  }]
})
```

- Retry: `callWithRetry()` üzerinden, max 5 deneme
- Hata: Bu grubun chunk'ları `status: 'error'`, diğer gruplar etkilenmez

---

### ADIM 5 — Anthropic-Style Context Summary (her chunk, paralel)

```
Fonksiyon: generateContext(chunk, fileRef, cacheRef, config) → string
```

**System Prompt:**
```
Sen bir teknik editörsün.
global_referans: Tüm doküman. Bağlamı anlamak için kullan.
islem_yapilacak_hedef: Aşağıdaki metin parçası.
Görev: Bu parçanın tüm dokümandaki yerini ve önemini açıklayan
TAM OLARAK 2 cümlelik bağlam özeti yaz.
Kural: Özet bu parça olmadan da bağlamı anlaşılır kılmalıdır.
ÇIKTI: Sadece JSON. { "contextSummary": "..." }
```

**Gemini Çağrı Yapısı — Cache MEVCUT:**
```typescript
// → KARAR: generateContext'te groupBase64 YOK, sadece chunk.text gönderilir.
// Büyük buffer yerine küçük metin = daha verimli ve daha ucuz.

const response = await ai.models.generateContent({
  model: config.geminiModel,
  contents: [{
    role: 'user',
    parts: [
      // işlenecek chunk metni
      { text: chunk.text },
      // talimat
      { text: contextSystemPrompt }
    ]
  }],
  config: {
    cachedContent: cacheRef.name   // global bağlam cache'den
  }
})
```

**Gemini Çağrı Yapısı — Cache YOKSA (fileRef fallback):**
```typescript
const response = await ai.models.generateContent({
  model: config.geminiModel,
  contents: [{
    role: 'user',
    parts: [
      { fileData: { mimeType: 'application/pdf', fileUri: fileRef.uri } }, // global bağlam
      { text: chunk.text },                                                 // hedef metin
      { text: contextSystemPrompt }                                         // talimat
    ]
  }]
})
```

- Retry: `callWithRetry()` üzerinden, max 5 deneme
- Hata: `contextSummary: ''`, `failedSteps: ['context']`, devam et

---

### ADIM 6 — Embedding (her chunk, opsiyonel)

- Koşul: `embeddingProvider` config'de tanımlıysa çalışır
- Input (değiştirilemez Anthropic yaklaşımı): `contextSummary + "\n\n" + chunk.text`
- Hata: `embedding` field gelmez, `failedSteps: ['embedding']`, devam et

---

### chunkIndex Atama Stratejisi

```
→ KARAR: chunkIndex global ve 0-tabanlıdır.
Gruplar sıralı (group 0, group 1, ...) işlenir.
Her grubun chunk'ları kendi içinde sıralıdır.
Tüm grupların sonuçları birleştirildikten sonra global index atanır.

Örnek:
  Group 0: 3 chunk → chunkIndex 0, 1, 2
  Group 1: 2 chunk → chunkIndex 3, 4
  Group 2: 4 chunk → chunkIndex 5, 6, 7, 8
```

---

### pageRange Türetme

```typescript
// → KARAR: Zod'dan gelen pages: number[] dizisinden türetilir.
pageRange: {
  start: Math.min(...rawChunk.pages),
  end: Math.max(...rawChunk.pages)
}
```

---

## 8. @google/genai SDK — API Referansı

### Başlatma

```typescript
import { GoogleGenAI } from '@google/genai'

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey })
```

### Embedding

```typescript
// → KARAR: gemini-embedding-001 geçerli model adıdır (@google/genai v1.x'te doğrulanmıştır).
// outputDimensionality parametresiyle boyut ayarlanabilir.

const result = await ai.models.embedContent({
  model: 'gemini-embedding-001',
  contents: [text],                  // string dizisi
  config: {
    taskType: 'RETRIEVAL_DOCUMENT',
    outputDimensionality: 1536        // Gemini provider için
  }
})

// result.embeddings[0].values → number[]
```

### Hata Tespiti

```typescript
// → KARAR: @google/genai SDK typed error fırlatır. HTTP kodu 'status' property'sinden alınır.

function isRetryable(error: unknown): boolean {
  if (error !== null && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status
    return [429, 500, 503, 504].includes(status)
  }
  return false
}

function isNonRetryable(error: unknown): boolean {
  if (error !== null && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status
    return [400, 401, 403].includes(status)
  }
  return false
}
```

---

## 9. Hata Modeli

### Pipeline durduran hatalar (throw)
- Gemini File API upload başarısız
- PDF parse edilemiyor (bozuk dosya)

### Context cache hatası (throw değil)
- `null` döner + `warn` log
- Tüm çağrılar fileRef fallback ile devam eder
- `cacheUsed: false`

### Grup hatası (throw değil)
- `determineChunks()` max retry sonrası başarısız
- O grubun chunk'ları `status: 'error'` olarak işaretlenir
- Diğer gruplar etkilenmez

### Chunk hatası (throw değil)
- `generateContext()` başarısız → `failedSteps: ['context']`, `status: 'partial'`
- `embed()` başarısız → `failedSteps: ['embedding']`, `status: 'partial'`
- Her adım bağımsız try/catch
- Bir adımın hatası aynı chunk'taki diğer adımı durdurmaz

### Timeout ve iptal

```typescript
// → KARAR: AbortSignal.any() ile birden fazla sinyal birleştirilir.

const signals: AbortSignal[] = []
if (config.timeoutMs) signals.push(AbortSignal.timeout(config.timeoutMs))
if (config.abortSignal) signals.push(config.abortSignal)
const combinedSignal = signals.length > 0
  ? AbortSignal.any(signals)
  : undefined

// Pool'daki her iş başlamadan önce signal kontrol edilir.
// Sinyal tetiklendiğinde: o anda işlenmekte olan chunk'lar biter,
// henüz başlamamış olanlar status: 'timeout' olarak eklenir.
```

---

## 10. Concurrency Modeli

İki seviyeli sliding window concurrency.

### processWithPool implementasyonu (güncel)

```typescript
// → KARAR: delayMs parametresi eklendi.
// Her öğe başlamadan önce delayMs kadar beklenir (stagger delay).
// Rate limit'i önlemek için birden fazla çağrı eş zamanlı patlamasını engeller.

async function processWithPool<T>(
  items: T[],
  concurrency: number,
  delayMs: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const executing = new Set<Promise<void>>()
  for (const item of items) {
    if (delayMs > 0) await new Promise<void>(r => setTimeout(r, delayMs))
    const p = fn(item).finally(() => executing.delete(p))
    executing.add(p)
    if (executing.size >= concurrency) {
      await Promise.race(executing)
    }
  }
  await Promise.all(executing)
}
```

### Kullanım

```typescript
// Seviye 1: Sayfa grupları
await processWithPool(
  pageGroups,
  config.maxConcurrentGroups ?? 3,
  config.perGroupDelayMs ?? 300,
  async (group) => { /* determineChunks */ }
)

// Seviye 2: Chunk'lar
await processWithPool(
  rawChunks,
  config.maxConcurrentChunks ?? 5,
  config.perChunkDelayMs ?? 100,
  async (chunk) => { /* generateContext + embed */ }
)
```

---

## 11. Retry Modeli

```typescript
async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 5
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      // Non-retryable: direkt fırlat
      if (isNonRetryable(error)) throw error

      // Son deneme: fırlat
      if (attempt === maxAttempts - 1) throw error

      // Retryable: exponential backoff
      if (isRetryable(error)) {
        const backoffMs = Math.min(Math.pow(2, attempt) * 1000, 30_000)
        await new Promise<void>(r => setTimeout(r, backoffMs))
        continue
      }

      // Bilinmeyen hata: fırlat
      throw error
    }
  }
  throw new Error('unreachable')
}

// Backoff tablosu:
//   attempt 0 → 1000ms
//   attempt 1 → 2000ms
//   attempt 2 → 4000ms
//   attempt 3 → 8000ms
//   attempt 4 → 16000ms
```

**JSON temizleme:**
```typescript
// Gemini bazen ```json ... ``` ile sarar
function extractJson(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
}
// Zod ile parse edilir. Parse başarısız → hata fırlatılır.
```

---

## 12. Zod Şemaları

```typescript
import { z } from 'zod'

export const ChunkingOutputSchema = z.object({
  chunks: z.array(z.object({
    pages:       z.array(z.number().int().positive()),
    text:        z.string().min(1),
    contentHint: z.enum(['table', 'narrative', 'qa', 'mixed'])
  }))
})

export const ContextSummarySchema = z.object({
  contextSummary: z.string().min(1).max(600)
})
```

---

## 13. ChunkerConfig

```typescript
interface ChunkerConfig {
  geminiApiKey:          string
  geminiModel?:          string       // default: 'gemini-1.5-pro'
  groupSize?:            number       // default: 15 (sayfa/grup)
  pageRange?:            { start: number; end: number }  // 1-based, inclusive
  maxPages?:             number
  maxConcurrentGroups?:  number       // default: 3
  maxConcurrentChunks?:  number       // default: 5
  perGroupDelayMs?:      number       // default: 300
  perChunkDelayMs?:      number       // default: 100
  timeoutMs?:            number
  abortSignal?:          AbortSignal
  embeddingProvider?:    IEmbeddingProvider
  logger?:               ILogger
}
```

---

## 14. Embedding Provider

```typescript
interface IEmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
  readonly dimensions: number
  readonly providerName: string
}
```

**Embedding input (Anthropic yaklaşımı — değiştirilemez):**
```typescript
// Her zaman ikisi birleştirilir. Ayrı ayrı embed edilmez.
const input = `${chunk.contextSummary}\n\n${chunk.text}`
const [[vector]] = await embeddingProvider.embed([input])
```

### createGeminiEmbeddingProvider

```typescript
createGeminiEmbeddingProvider(opts: { apiKey: string }): IEmbeddingProvider
// model: 'gemini-embedding-001'
// taskType: 'RETRIEVAL_DOCUMENT'
// dimensions: 1536
// API: ai.models.embedContent({ model, contents, config: { taskType, outputDimensionality } })
// return: result.embeddings[0].values
```

### createOpenAiEmbeddingProvider

```typescript
createOpenAiEmbeddingProvider(opts: { apiKey: string }): IEmbeddingProvider
// model: 'text-embedding-3-large'
// dimensions: 3072
// → KARAR: openai paketi dynamic import ile yüklenir.
//   Kurulu değilse anlaşılır hata mesajı fırlatılır:
//   "openai paketi bulunamadı. Kurmak için: npm install openai"
```

### createNullEmbeddingProvider

```typescript
createNullEmbeddingProvider(): IEmbeddingProvider
// passthrough, null object pattern
// dimensions: 0
// embed(): texts.map(() => [])
```

---

## 15. Paket Yapısı

```
src/
├── gemini/
│   ├── file-upload.ts       → uploadPdf()
│   ├── context-cache.ts     → createCache()  [null döner, throw etmez]
│   └── llm-caller.ts        → callWithRetry(), extractJson(), isRetryable()
├── pdf/
│   ├── page-splitter.ts     → splitIntoGroups()  [pdf-lib, sadece bölme]
│   └── chunk-determiner.ts  → determineChunks()
├── context/
│   └── summarizer.ts        → generateContext()
├── pipeline/
│   └── pool.ts              → processWithPool()
├── embedding/
│   ├── types.ts             → IEmbeddingProvider interface
│   ├── gemini.provider.ts   → createGeminiEmbeddingProvider()
│   ├── openai.provider.ts   → createOpenAiEmbeddingProvider()  [dynamic import]
│   └── null.provider.ts     → createNullEmbeddingProvider()
├── logger.ts                → ILogger, createDefaultLogger()  [Pino]
├── types.ts                 → FileRef, CacheRef, PageGroup, RawChunk,
│                               ChunkResult, ChunkerResult, ChunkerConfig
└── index.ts                 → public API

Kök:
├── package.json             ["type": "module", ESM]
├── tsconfig.json            [strict: true]
└── .env.example
```

### index.ts — Public Exports

```typescript
// Fonksiyonlar
export { chunk } from './chunk'
export { createGeminiEmbeddingProvider } from './embedding/gemini.provider'
export { createOpenAiEmbeddingProvider } from './embedding/openai.provider'
export { createNullEmbeddingProvider } from './embedding/null.provider'
export { createDefaultLogger } from './logger'

// Tipler
export type {
  ChunkerConfig,
  ChunkerResult,
  ChunkResult,
  FileRef,
  CacheRef
} from './types'
export type { IEmbeddingProvider } from './embedding/types'
export type { ILogger } from './logger'
```

---

## 16. Logger Mimarisi

```typescript
interface ILogger {
  debug(msg: string, meta?: unknown): void
  info(msg: string, meta?: unknown):  void
  warn(msg: string, meta?: unknown):  void
  error(msg: string, meta?: unknown): void
}

// createDefaultLogger(): ILogger → Pino implementasyonu
// Config'te logger verilmezse createDefaultLogger() otomatik çağrılır.
```

**Loglanan olaylar:**
- PDF upload başlangıç/bitiş + süre + dosya boyutu
- Cache oluşturma sonucu (başarılı: name + expireTime / başarısız: sebep)
- Toplam sayfa ve grup sayısı
- Her grup: pageRange, chunk sayısı, süre
- Her chunk: index, contentHint, status, failedSteps
- Toplam süre ve toplam chunk sayısı

---

## 17. Kullanım Örnekleri

```typescript
// ÖRNEK 1 — Minimal
import { chunk } from '@msbayindir/rag-chunker'
const result = await chunk(pdfBuffer, { geminiApiKey: '...' })

// ÖRNEK 2 — Embedding ile tam RAG hazırlığı
import { chunk, createOpenAiEmbeddingProvider } from '@msbayindir/rag-chunker'
const result = await chunk(pdfBuffer, {
  geminiApiKey:      '...',
  embeddingProvider: createOpenAiEmbeddingProvider({ apiKey: '...' }),
  groupSize:         15
})

// ÖRNEK 3 — Vektör DB'ye yükle
for (const c of result.chunks) {
  await vectorDB.upsert({
    id:     `doc_${c.chunkIndex}`,
    vector: c.embedding,
    metadata: {
      text:        c.text,
      context:     c.contextSummary,
      pages:       c.pageRange,
      contentHint: c.contentHint
    }
  })
}

// ÖRNEK 4 — Partial success kontrolü
const failed = result.chunks.filter(c => c.status !== 'success')
failed.forEach(c => console.log(c.chunkIndex, c.failedSteps))

// ÖRNEK 5 — Cache kontrolü
console.log('Cache kullanıldı:', result.cacheUsed)

// ÖRNEK 6 — Sadece belirli sayfalar
const result = await chunk(pdfBuffer, {
  geminiApiKey: '...',
  pageRange: { start: 1, end: 60 }
})

// ÖRNEK 7 — Kendi embedding provider'ı
import type { IEmbeddingProvider } from '@msbayindir/rag-chunker'
const myProvider: IEmbeddingProvider = {
  providerName: 'custom',
  dimensions: 768,
  async embed(texts) { /* ... */ return texts.map(() => []) }
}
```

---

## 18. Uygulama Sırası

```
1.  package.json            [ESM, peerDeps versiyonlu]
2.  tsconfig.json           [strict: true]
3.  src/types.ts            [tüm tipler]
4.  src/logger.ts           [ILogger + createDefaultLogger]
5.  src/gemini/file-upload.ts
6.  src/gemini/context-cache.ts
7.  src/gemini/llm-caller.ts
8.  src/pdf/page-splitter.ts
9.  src/pdf/chunk-determiner.ts
10. src/context/summarizer.ts
11. src/pipeline/pool.ts
12. src/embedding/types.ts
13. src/embedding/gemini.provider.ts
14. src/embedding/openai.provider.ts
15. src/embedding/null.provider.ts
16. src/index.ts
17. .env.example
```

---

## 19. Kalite Kriterleri

- `TypeScript strict: true` — `any` tipi kesinlikle yasak
- Her public fonksiyon JSDoc'lu
- Class kullanılmaz — her şey fonksiyon veya factory function
- `pdfjs-dist` kullanılmaz
- `pdf-lib` sadece sayfa bölme için kullanılır
- Zero framework bağımlılığı: sadece `pdf-lib`, `zod`, `pino`
- SDK: `@google/genai ^1.0.0` (peer dependency)
- `openai ^4.0.0` optional peer dependency — dynamic import + helpful error
- Cache başarısızlığı hata değil — warn + fileRef fallback
- Her chunk ve her grup bağımsız başarısız olabilir
- Embedding input her zaman: `contextSummary + "\n\n" + chunkText`
- İki seviyeli concurrency: grup ve chunk bazında ayrı ayrı
- `systemInstruction` cache'e dahil edilmez — talimatlar her çağrıda contents içinde gönderilir

---

## 20. Önemli Kısıtlamalar (README'de Belirtilecek)

- **Node.js 20+** gerektirir, browser desteği yoktur
- Dosyalar Gemini sunucusunda **48 saat** sonra otomatik silinir
- Maksimum PDF boyutu: **2 GB**
- Context Cache minimum **~32K token** gerektirir; altındaki PDF'lerde cache başarısız olur (hata değil, fallback çalışır)
- `openai` paketi sadece `createOpenAiEmbeddingProvider` kullanıldığında gereklidir
