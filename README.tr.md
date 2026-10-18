# rag-chunker

[![npm](https://img.shields.io/npm/v/@msbayindir/rag-chunker)](https://www.npmjs.com/package/@msbayindir/rag-chunker)
[![CI](https://github.com/msbayindir/rag-chunker/actions/workflows/ci.yml/badge.svg)](https://github.com/msbayindir/rag-chunker/actions/workflows/ci.yml)
[![Node ≥ 22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

**PDF, Word, PowerPoint, görsel ve Markdown → aramaya hazır chunk'lar.**
Tek `npx` komutu, Python yok. **API anahtarı olmadan**, Ollama (Gemma 4) ile **tamamen yerel** ya da herhangi bir bulut modeliyle çalışır: Gemini, Claude, OpenAI, OpenRouter, Mistral OCR. Her aşama için farklı model seçebilirsiniz.

[English README](README.md)

```bash
npx @msbayindir/rag-chunker process kitap.pdf            # anahtarsız: metin katmanı + yapıya duyarlı chunk'lar
npx @msbayindir/rag-chunker process kitap.pdf --local    # her şey Ollama'da, hiçbir veri makineden çıkmaz
```

## Neden rag-chunker

- **Dokümana saygılı chunk'lar.** Deterministik, AST tabanlı chunker başlıkları içerikleriyle birlikte tutar, mecbur kalmadıkça cümle ortasından bölmez, büyük tabloları *başlık satırını tekrarlayarak* satır satır böler, kod bloklarının çitlerini korur ve hiçbir kelimeyi kaybetmez (property testleriyle doğrulanır).
- **Doğru kaynak gösterimi.** Her chunk'ta `pageStart`/`pageEnd`, başlık yolu (`sectionPath`) ve çakışmayan, kalıcı bir `chunkId` bulunur.
- **Kademeli OCR.** Dijital sayfalar PDF'in metin katmanından ücretsiz okunur; yalnızca taranmış sayfalar Mistral OCR'a veya bir vision modeline (Gemma 4, Gemini, Claude, GPT…) gider. Tekrar eden üst/alt bilgiler ve sayfa numaraları temizlenir.
- **Contextual retrieval** ([Anthropic'in yöntemi](https://www.anthropic.com/news/contextual-retrieval)): her chunk'a, dokümandaki yerini anlatan 1–2 cümlelik bir özet eklenir. Modele sığmayan büyük dokümanlarda doküman ve bölüm özetleri kullanılır, böylece küçük yerel modellerle de çalışır.
- **Başlık onarımı.** OCR sayfaları tek tek okuduğu için başlık seviyelerini karıştırır; bir LLM adımı ve deterministik bir numaralandırma adımı bunu düzeltir.
- **Her aşamada her sağlayıcı.** Her yerde `sağlayıcı/model`: `ollama/gemma4:e4b-it-qat`, `gemini/gemini-3.5-flash-lite`, `anthropic/claude-haiku-5-5`, `openrouter/…` ya da kendi OpenAI-uyumlu sunucunuz. Her sağlayıcı için yerleşik prompt cache desteği.
- **Kaldığı yerden devam eder, tekrar çalıştırmak ucuzdur.** OCR sayfaları, özetler ve embedding'ler cache'lenir; yarıda kesilen bir iş aynı komutla devam eder, chunk boyutunu değiştirmek OCR'a tekrar para ödetmez.
- **Ölçülebilir kalite.** `rag-chunker eval` kanıta dayalı sorular üretir ve BM25, vektör ve hibrit arama için hit@k / MRR raporlar; farklı chunk ayarlarını yan yana karşılaştırın.
- **Her şey dahil.** Tarayıcıda inceleme arayüzü, pgvector / Qdrant / LanceDB export'ları ve ajanların (Claude Desktop, Claude Code…) dokümanlarınızda arama yapabilmesi için bir MCP sunucusu.

## Hızlı başlangıç

```bash
# 1. Bu makinede neyin hazır olduğunu kontrol edin
npx @msbayindir/rag-chunker doctor

# 2. (isteğe bağlı) Sorularla config oluşturun — Ollama'yı, RAM'i ve API anahtarlarını algılar
npx @msbayindir/rag-chunker init

# 3. Dokümanları işleyin (dosyalar ya da klasörler)
npx @msbayindir/rag-chunker process belgeler/ -o cikti/

# 4. Sonucu inceleyin
npx @msbayindir/rag-chunker inspect cikti/rapor --ui --pdf belgeler/rapor.pdf
```

### Tamamen yerel (hassas belgeler, KVKK)

```bash
brew install ollama            # ya da https://ollama.com/download
ollama pull gemma4:e4b-it-qat  # görsel + metin, ~6 GB; 16 GB RAM yeterli
ollama pull embeddinggemma     # embedding, ~0,6 GB
npx @msbayindir/rag-chunker process sozlesme.pdf --local
```

`--local`, RAM'inize göre kurulu en iyi Gemma 4 modelini seçer ve bütün aşamaları açar: taranmış sayfalar için vision OCR, başlık onarımı, context özetleri ve embedding. `MISTRAL_API_KEY` tanımlı olsa bile buluta hiçbir şey gönderilmez.

### Bulut modelleri

API anahtarları ortam değişkenlerinden ya da bulunduğunuz klasördeki `.env` dosyasından okunur; config dosyasına asla yazılmaz.

```bash
echo "GEMINI_API_KEY=..." >> .env
npx @msbayindir/rag-chunker process kitap.pdf \
  --context gemini/gemini-3.5-flash-lite \
  --embedding gemini/gemini-embedding-001
```

`MISTRAL_API_KEY` tanımlıysa PDF'ler otomatik olarak Mistral OCR ile okunur (tablolar ve karmaşık sayfa düzenleri için en iyi kalite).

## Nasıl çalışır

```
oku ─▶ OCR ─▶ başlıklar ─▶ chunk ─▶ context ─▶ embedding ─▶ chunks.jsonl, document.md, structure.json, manifest.json
       │       (isteğe bağlı)          (isteğe bağlı) (isteğe bağlı)
       ├─ metin katmanı (dijital sayfalar, ücretsiz)
       ├─ Mistral OCR (tüm sayfalar)        ← MISTRAL_API_KEY varsa
       └─ vision model (taranmış sayfalar)  ← models.vision / --local
```

Modeli tanımlanmayan aşama atlanır. Hiç ayar yapmazsanız metin katmanı ve chunker çalışır; hiçbir ağ çağrısı yapılmaz.

| Girdi | Nasıl okunur |
|---|---|
| PDF | Metin katmanı (font boyutundan başlıklar, listeler, iki sütunlu düzen, tire birleştirme); taranmış sayfalar OCR motoruyla |
| DOCX | Word başlıkları, paragraflar ve tablolar |
| PPTX | Her slayt bir sayfa: başlık, iç içe maddeler, tablolar, konuşmacı notları |
| PNG / JPEG / WebP | OCR motoru (Mistral ya da vision model) |
| Markdown / metin | Olduğu gibi; `<!-- page N -->` işaretleri sayfa numarasını belirler |

## Model seçimi

Her model `sağlayıcı/model` biçiminde yazılır. Yerleşik sağlayıcılar ayar gerektirmez:

| Sağlayıcı | Anahtar (ortam değişkeni) | Örnek modeller |
|---|---|---|
| `ollama` | — (`OLLAMA_HOST`, varsayılan `127.0.0.1:11434`) | `gemma4:e4b-it-qat`, `gemma4:12b-it-qat`, `embeddinggemma` |
| `gemini` | `GEMINI_API_KEY` | `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-embedding-001` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-haiku-5-5`, `claude-sonnet-5-5` |
| `openai` | `OPENAI_API_KEY` | sohbet modeliniz, `text-embedding-3-large` |
| `openrouter` | `OPENROUTER_API_KEY` | `anthropic/claude-haiku-5-5`, herhangi bir OpenRouter modeli |
| `mistral` | `MISTRAL_API_KEY` | OCR (`ocr.engine: "mistral"`), `mistral-embed` |
| `lmstudio` | — | LM Studio'nun 1234 portunda sunduğu model |

Model adları zamanla değişir; hesabınızda olanları kullanın. `rag-chunker doctor` tanımlı her modeli kontrol eder.

OpenAI-uyumlu herhangi bir sunucu (vLLM, llama.cpp, bir gateway…) isim verilerek kullanılır:

```json
{
  "providers": { "lab": { "type": "openai-compatible", "baseURL": "http://localhost:8000/v1", "apiKeyEnv": "LAB_KEY" } },
  "models": { "context": "lab/qwen3-32b" }
}
```

**Önerilen kombinasyonlar**

| Hedef | vision / OCR | context | embedding |
|---|---|---|---|
| Ücretsiz ve gizli | `ollama/gemma4:e4b-it-qat` | aynısı | `ollama/embeddinggemma` |
| En iyi PDF, ucuz | Mistral OCR | `gemini/gemini-3.5-flash-lite` | `gemini/gemini-embedding-001` |
| Karma | Mistral OCR | `ollama/gemma4:12b-it-qat` | `openai/text-embedding-3-large` |
| Tek anahtar | `openrouter/…` | `openrouter/anthropic/claude-haiku-5-5` | kendi vektör DB'nizde |

## Yapılandırma

Ayarların önceliği (yüksekten düşüğe): **CLI bayrakları → `rag-chunker.config.json` (ya da `.mjs`/`.js`) → otomatik algılama → varsayılanlar.**

```json
{
  "$schema": "./node_modules/@msbayindir/rag-chunker/schema/config.schema.json",
  "ocr": { "engine": "auto" },
  "models": {
    "vision": "ollama/gemma4:e4b-it-qat",
    "structure": "anthropic/claude-sonnet-5-5",
    "context": "ollama/gemma4:e4b-it-qat",
    "embedding": "ollama/embeddinggemma"
  },
  "chunk": { "maxTokens": 512, "minTokens": 64, "overlapTokens": 0 }
}
```

`$schema` satırı VS Code ve diğer editörlerde otomatik tamamlama ve açıklama sağlar. Tüm seçeneklerin tablosu [İngilizce README](README.md#configuration)'de; en önemlileri:

| Seçenek | Varsayılan | Anlamı |
|---|---|---|
| `ocr.engine` | `auto` | `auto` (`MISTRAL_API_KEY` varsa Mistral, yoksa `models.vision`, yoksa metin katmanı), `text-layer`, `mistral` ya da vision `sağlayıcı/model` |
| `models.*` | — | Aşama başına model; boş bırakılan aşama atlanır |
| `chunk.maxTokens` | `512` | Chunk başına kesin üst sınır (o200k token) |
| `chunk.minTokens` | `64` | Daha küçük chunk'lar aynı bölümdeki komşusuyla birleşir |
| `chunk.overlapTokens` | `0` | Önceki chunk'ın son cümleleri `content`'in başına eklenir |
| `context.strategy` | `auto` | `full` (tüm doküman cache'li bağlam olarak), `hierarchical` (özetler), `auto` |
| `providers.<ad>` | — | `type`, `baseURL`, `apiKeyEnv`, `contextWindow`, `maxContext` (Ollama `num_ctx` üst sınırı, varsayılan 32768), `concurrency`, `timeoutMs` |

## Komutlar

| Komut | Ne yapar |
|---|---|
| `process <dosyalar/klasörler…>` | Pipeline'ı çalıştırır. `-o`, `--local`, `--ocr`, `--vision`, `--structure`, `--context`, `--embedding`, `--max-tokens`, `--min-tokens`, `--overlap`, `--no-cache`, `--dry-run`, `--json`, `--verbose` |
| `init` | Sorularla kurulum; Gemma 4 / EmbeddingGemma indirmeyi önerir; `--yes` ile varsayılanlar |
| `doctor` | Node, cache, anahtarlar, Ollama ve tanımlı her modeli kontrol eder (ücretli çağrı yapmaz) |
| `inspect <klasör>` | Özet; `--ui` arama ve `--pdf` sayfa görünümü olan yerel bir tarayıcı arayüzü açar |
| `eval <klasörler…>` | Arama kalitesi ölçümü (`--model`, `--questions`, `--questions-file`, `--embedding`) |
| `export <klasörler…> --to pgvector\|qdrant\|lancedb` | Chunk'ları ve vektörleri veritabanına yazar (`--url`, `--replace-document`, `--embedding`, `--index`) |
| `mcp <klasörler…>` | Yapay zekâ ajanları için stdio üzerinden MCP sunucusu |
| `cache info` / `cache clear [--older-than <gün>]` | Cache yönetimi |

`--dry-run`, hiçbir model çağırmadan OCR'lanacak sayfaları, tahmini chunk ve istek sayısını ve context token'ları için bir üst sınırı gösterir.

## Çıktı

Her doküman için dört dosya yazılır: `chunks.jsonl` (satır başına bir chunk), `document.md` (sayfa işaretli tam markdown), `structure.json` (başlıklar, tablolar, bölümler), `manifest.json` (sürüm, aşama başına modeller, istatistikler, token kullanımı, anahtarsız config, uyarılar). Alanların açıklaması [İngilizce README](README.md#output)'de.

**Neyi embed etmeli:** `content` (context özeti ve overlap dahildir). Hibrit aramada vektör tarafına `content`, anahtar kelime tarafına `rawContent` verin. Sorguları aynı modelle ve `embedQuery()` ile embed edin; Gemini ve EmbeddingGemma doküman ve sorgu için farklı prompt kullanır.

## Programatik kullanım

```ts
import { processDocument } from '@msbayindir/rag-chunker'

const sonuc = await processDocument('kitap.pdf', {
  models: { context: 'ollama/gemma4:e4b-it-qat', embedding: 'ollama/embeddinggemma' },
}, {
  onProgress: (e) => e.type === 'progress' && console.log(e.stage, `${e.done}/${e.total}`),
})

await sonuc.save('cikti/kitap')
```

Diğer fonksiyonlar: `planDocument`, `chunkMarkdown`, `embedTexts`, `embedQuery`, `buildSearchIndex` + `search`, `generateQuestions` + `evaluate`, `exportToPgvector` / `exportToQdrant` / `exportToLanceDb`, `createMcpServer`, `readOutputDir`, `loadConfig` / `defineConfig`. Tüm hatalar sabit bir `code` ve okunabilir bir `hint` içeren `RagChunkerError`'dır.

## Kaliteyi ölçmek

```bash
npx @msbayindir/rag-chunker process kitap.pdf -o denemeler/512 --max-tokens 512 --embedding ollama/embeddinggemma
npx @msbayindir/rag-chunker process kitap.pdf -o denemeler/256 --max-tokens 256 --embedding ollama/embeddinggemma
npx @msbayindir/rag-chunker eval denemeler/512 denemeler/256 --model ollama/gemma4:e4b-it-qat --questions 40
```

Sorular birebir alıntılanmış bir kanıt cümlesiyle üretildiği için aynı dokümanın her chunk'lama biçiminde geçerlidir. Tablo BM25, vektör ve hibrit arama için hit@1/5/10 ve MRR gösterir.

## Ajanlar için MCP sunucusu

```json
{
  "mcpServers": {
    "belgeler": { "command": "npx", "args": ["-y", "@msbayindir/rag-chunker", "mcp", "/tam/yol/cikti/kitap"] }
  }
}
```

Araçlar: `search`, `get_chunk`, `get_page`, `list_documents`.

## Sorun giderme

| Sorun | Çözüm |
|---|---|
| `N page(s) have no usable text layer` | Taranmış sayfalar: `MISTRAL_API_KEY` tanımlayın, `--local` ya da `--ocr <vision model>` kullanın |
| `model is not installed in Ollama` | `ollama pull <model>` |
| `cannot reach Ollama` | Ollama uygulamasını açın ya da `ollama serve`; uzak sunucu için `OLLAMA_HOST` |
| `needs an API key` | Anahtarı `.env`'e ya da ortama yazın (hata mesajı değişken adını söyler) |
| Küçük yerel model geçersiz JSON döndürüyor | Otomatik olarak yeniden denenir ve bölünür; kalıcı hatalar uyarı olarak görünür. `structure` için daha büyük bir model kullanın |

Önce `rag-chunker doctor` çalıştırın; yukarıdakilerin hepsini kontrol eder.

## Gereksinimler

Node.js 22 veya üzeri. İsteğe bağlı: yerel modeller için [Ollama](https://ollama.com).

## Katkı

Issue ve pull request'ler memnuniyetle karşılanır; [CONTRIBUTING.md](CONTRIBUTING.md)'ye göz atın.

## Lisans

[MIT](LICENSE)
