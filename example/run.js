import { readFileSync, existsSync, writeFileSync } from 'fs'
import { chunk, createNullEmbeddingProvider, createGeminiEmbeddingProvider } from '@msbayindir/rag-chunker'

// ─── API key ──────────────────────────────────────────────────────────────────
import { config as loadEnv } from 'dotenv'
loadEnv()
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ''

if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith('buraya')) {
  console.error('❌ .env dosyasına GEMINI_API_KEY yaz!')
  process.exit(1)
}

// ─── PDF yükle ────────────────────────────────────────────────────────────────
const pdfPath = process.argv[2] ?? './test.pdf'

if (!existsSync(pdfPath)) {
  console.error(`❌ PDF bulunamadı: ${pdfPath}`)
  console.error('   Kullanım: node run.js <pdf_dosyası>')
  console.error('   Örnek:    node run.js rapor.pdf')
  process.exit(1)
}

const pdfBuffer = readFileSync(pdfPath)
console.log(`📄 PDF yüklendi: ${pdfPath} (${(pdfBuffer.byteLength / 1024).toFixed(1)} KB)`)

// ─── Çalıştır ────────────────────────────────────────────────────────────────
console.log('\n🚀 Pipeline başlatılıyor...\n')

const result = await chunk(pdfBuffer, {
  geminiApiKey: GEMINI_API_KEY,
  geminiModel: 'gemini-3.1-pro-preview',

  groupSize: 15,            // 15 sayfalık gruplar
  maxConcurrentGroups: 2,   // aynı anda 2 grup işle
  maxConcurrentChunks: 3,   // aynı anda 3 chunk işle
  perGroupDelayMs: 500,     // rate limit için bekleme
  perChunkDelayMs: 200,

  // Embedding istemiyorsan: createNullEmbeddingProvider()
  // Gemini embedding istiyorsan: createGeminiEmbeddingProvider({ apiKey: GEMINI_API_KEY })
  embeddingProvider: createNullEmbeddingProvider(),
})

// ─── Sonuçlar ────────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────────')
console.log(`✅ Tamamlandı!`)
console.log(`   Toplam chunk:  ${result.chunks.length}`)
console.log(`   Toplam sayfa:  ${result.totalPages}`)
console.log(`   Cache:         ${result.cacheUsed ? 'kullanıldı' : 'kullanılmadı (fallback)'}`)
console.log(`   Süre:          ${(result.durationMs / 1000).toFixed(1)}s`)
console.log('─────────────────────────────────────────\n')

// İlk 3 chunk'ı göster
const preview = result.chunks.slice(0, 3)
for (const c of preview) {
  console.log(`📦 Chunk #${c.chunkIndex} [${c.status}]`)
  console.log(`   Sayfalar:   ${c.pageRange.start}–${c.pageRange.end}`)
  console.log(`   Tür:        ${c.contentHint}`)
  console.log(`   Bağlam:     ${c.contextSummary || '(yok)'}`)
  console.log(`   Metin:      ${c.text.slice(0, 120).replace(/\n/g, ' ')}...`)
  if (c.failedSteps?.length) {
    console.log(`   ⚠️  Başarısız adımlar: ${c.failedSteps.join(', ')}`)
  }
  console.log()
}

// Başarısız chunk'lar
const failed = result.chunks.filter(c => c.status !== 'success')
if (failed.length > 0) {
  console.log(`⚠️  ${failed.length} chunk tam başarılı değil:`)
  for (const c of failed) {
    console.log(`   #${c.chunkIndex} → ${c.status} (${c.failedSteps?.join(', ') ?? ''})`)
  }
}

// ─── JSON kaydet ──────────────────────────────────────────────────────────────
const outputPath = pdfPath.replace(/\.pdf$/i, '') + '-result.json'
writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8')
console.log(`\n💾 Sonuç kaydedildi: ${outputPath}`)
