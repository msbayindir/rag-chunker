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
- **Kademeli OCR.** Dijital sayfalar PDF'in metin katmanından ücretsiz okunur; yalnızca taranmış sayfalar OCR'a gider: yerel PP-OCRv5 modelleri (anahtarsız; Türkçe dahil Latin alfabeleri, varsayılan profilde belge başına tespit edilen Çince/Japonca), Mistral OCR ya da bir vision modeli (Gemma 4, Gemini, Claude, GPT…). Tekrar eden üst/alt bilgiler ve sayfa numaraları temizlenir. Yan veya ters taranmış sayfalar önce dik çevrilir.
- **Ölçülmüş yerel belge modelleri.** Okuma sırasıyla sayfa yerleşimi, tablo yapısı, LaTeX olarak blok formüller ve cross-encoder reranker, hepsi makinenizde `onnxruntime-node` üzerinde çalışır. `local.profile` en güçlü modelleri (`full`, varsayılan) ya da küçük ve hızlı olanları (`basic`) seçer; açık veri setlerindeki sonuçlar için bkz. [Ölçümler](#ölçümler).
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

`MISTRAL_API_KEY` tanımlıysa PDF'ler otomatik olarak Mistral OCR ile okunur (tablolar ve karmaşık sayfa düzenleri için en iyi kalite). Anahtarın planında OCR kotası yoksa rag-chunker uyarı verip bir sonraki motorla devam eder.

## Nasıl çalışır

```
oku ─▶ OCR ─▶ başlıklar ─▶ chunk ─▶ context ─▶ embedding ─▶ chunks.jsonl, document.md, structure.json, document.json, manifest.json
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
| XLSX | Her görünür sayfa bir sayfa: hücre blokları GFM tablosu olur (boş satırlar böler, üstteki tek hücre başlıktır); tarih, yüzde, mantıksal değer ve formül sonuçları çözülür, birleşik hücreler tekrarlanır |
| HTML | Ana içerik (`<main>`, tek `<article>`, yoksa gövde); betikler, gezinme, site üst/alt bilgisi ve gizli öğeler atılır; her biçimde tablo, kod blokları, alt metinler |
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
| `cohere` | `COHERE_API_KEY` | Yalnızca yeniden sıralama: `rerank.engine: "cohere/rerank-v3.5"` |
| `jina` | `JINA_API_KEY` | Yalnızca yeniden sıralama: `rerank.engine: "jina/jina-reranker-v2-base-multilingual"` |
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
| `ocr.engine` | `auto` | `auto` (modelleri indirilmişse yerel PP-OCR, yoksa `MISTRAL_API_KEY` varsa Mistral, yoksa `models.vision`, yoksa metin katmanı), `text-layer`, `pp-ocr`, `mistral` ya da vision `sağlayıcı/model` |
| `ocr.detector` | `auto` | Yerel OCR'ın metin dedektörü: `mobile` (PP-OCRv5 mobil, 5 MB, hızlı), `server` (PP-OCRv5 server, 84 MB; küçük punto ve tablo hücrelerinde daha iyi, yaklaşık 1,8 kat yavaş), `auto` (`local.profile`'ı izler) |
| `ocr.script` | `auto` | Yerel OCR'ın tanıyıcısı: `latin` (Türkçe, İngilizce, Almanca, Fransızca…), `cjk` (Çince, Japonca ve İngilizce için PP-OCRv5 server modeli, 84 MB, satır başına ~10 kat yavaş, Ğ/İ yok), `auto` (`full` profilde belgenin ilk taranmış sayfasının en geniş satırları CJK modeliyle okunur, CJK çıkarsa belge o modele geçer) |
| `ocr.detection.limit` | `960` | Yerel OCR dedektörünün sayfayı gördüğü en uzun kenar, piksel (PaddleOCR varsayılanı); büyüğü küçük puntoyu bulur, zaman alır |
| `ocr.detection.denseMinLine` | `12` | Yoğun sayfalar için ikinci algılama geçişi: algılanan satırların medyanı bu kadar dedektör pikselinden kısaysa sayfa, satırı bu yüksekliğe getiren boyutta yeniden algılanır (en çok 3.200 px); `0` kapatır |
| `ocr.orientation` | `auto` | 90, 180 veya 270 derece dönmüş taranmış sayfalar ve görseller dik okunur: `auto` yerel OCR'ın okuduğu her sayfayı sınıflandırır (PP-LCNet belge yönü modeli, 7 MB, bir kez indirilir; sayfanın `rotation` değeri `document.json`'a yazılır), `off` sayfaları olduğu gibi okur |
| `local.profile` | `full` | `auto` ayarlarının hangi yerel modelleri seçeceği: `full` (en güçlü modeller, daha büyük indirme; bugün server OCR dedektörü, `ocr.script: auto` için CJK tanıyıcı, formül modeli ve `bge-reranker-v2-m3` reranker'ı), `basic` (küçük modeller: mobil dedektör, Latin tanıyıcı, `mmarco-minilm`; CLI `--profile basic`) |
| `formulas.recognize` | `auto` | Layout modelinin formül bölgelerindeki blok formüller yerel bir modelle ([texify2](https://huggingface.co/vikp/texify2), 8 bit ONNX, 320 MB, `npm install @huggingface/transformers` gerekir) LaTeX'e çevrilip `$$…$$` blokları olarak yazılır: `auto` (`full` profilde, layout analizi çalışıyorsa ve paket kuruluysa açık), `on`, `off` (CLI `--no-formulas`) |
| `local.device` | `auto` | Hızlandırıcıdan kazanan yerel modellerin (OCR metin dedektörü ve CJK tanıyıcı; layout, tablo, Latin OCR ve reranker modelleri CPU'da daha hızlı olduğundan orada kalır) nerede çalışacağı: `auto` (macOS'ta CoreML, diğerlerinde `onnxruntime-node` sunuyorsa CUDA, yoksa CPU), `cpu`, `coreml`, `cuda`. Hızlandırıcının alamadığı model CPU'ya düşer; `doctor` kullanılan cihazı gösterir |
| `models.*` | — | Aşama başına model; boş bırakılan aşama atlanır |
| `chunk.maxTokens` | `512` | Chunk başına kesin üst sınır (o200k token) |
| `chunk.minTokens` | `64` | Daha küçük chunk'lar aynı bölümdeki komşusuyla birleşir |
| `chunk.overlapTokens` | `0` | Önceki chunk'ın son cümleleri `content`'in başına eklenir |
| `context.strategy` | `auto` | `full` (tüm doküman cache'li bağlam olarak), `hierarchical` (doküman + bölüm özetleri), `auto` (modelin bağlamı yetiyorsa 60 bin token'a kadar `full`, üstünde `hierarchical`) |
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

**Yerel OCR (anahtarsız).** `--ocr pp-ocr` (ve `--local`) taranmış sayfaları ve görselleri `onnxruntime-node` üzerinde PP-OCRv5 mobile ile okur: 5 MB'lık metin tespit modeli ve 8 MB'lık Latin alfabesi tanıma modeli (Türkçe, İngilizce, Almanca, Fransızca, İspanyolca…; diğer alfabeler planda). OCR satırları metin katmanı satırlarıyla aynı hatta girer; başlıklar, listeler, hizalamayla bulunan tablolar, layout bölgeleri ve konumlar taranmış sayfada da çalışır; her satırın güven skoru `document.json`'a (`confidence`) ulaşır ve satırdaki kelimeler konumlarını korur (tanıma modelinin zaman adımlarından), böylece taranmış bir tabloda aynı satırda yan yana duran hücreler ayırt edilir. Dizüstü işlemcide sayfa başına 0,3–1 sn, sayfa bazında cache'lenir. Modeller bir kez indirildikten sonra `auto` yerel OCR'ı Mistral'a tercih eder.

**Şekiller.** PDF sayfalarına gömülü resimler sayfa görüntüsünden kesilip PNG olarak kaydedilir (`figures/p<sayfa>-<n>.png`, diğer çıktıların yanında) ve `document.md`'de okuma sırasındaki yerinden referans verilir: `![açıklama](figures/p3-1.png)`. Açıklama, yerleşim analizi çalıştıysa `figure_title` bölgesinden, yoksa resmin altında ya da üstünde açıklama gibi başlayan en yakın satırdan ("Şekil 1", "Figure 3", "Fig. 2a", "Grafik 4"…) alınır; açıklama metni akışta kalır. `--layout` ile vektör çizimli grafikler ve şemalar da şekil olur (`image` ve `chart` bölgeleri) — makalelerdeki şekillerin çoğu böyledir; onsuz yalnızca gömülü resimler bulunur. Simgeler, logolar, tam sayfa taramalar ve üzerine paragraf yazılmış resimler atlanır. `document.json` her şekli kutusu, dosyası, açıklaması ve (`--describe-figures` ile) bir görsel modelin yazdığı betimlemeyle `figure` bloğu olarak listeler — `--local` bunun için Gemma 4'ü kullanır; böylece bir grafiğin eksenleri, göstergesi ve eğilimi resmin altında aranabilir metin olur. `rag-chunker inspect --ui` şekilleri satır içinde gösterir. `figures.extract`, `figures.describe` ve `figures.minSize` ayarlarıyla yönetilir.

**Yeniden sıralama (yerel, anahtarsız).** `rag-chunker eval <klasör> --rerank` ve `rag-chunker mcp <klasör> --rerank` aramaya ikinci bir aşama ekler: hibrit (ya da BM25) aramanın en iyi 30 adayı, sorguyla parçayı birlikte okuyup parçanın soruyu ne kadar yanıtladığını puanlayan bir cross-encoder'dan geçer. `full` profili [BGE reranker v2 m3](https://huggingface.co/BAAI/bge-reranker-v2-m3) modelini kullanır (568M parametre, int8 ONNX, 570 MB, Apache-2.0, 100'den fazla dil): İngilizce ve Türkçe arama ölçümlerimizde kanıt parçasını en üste en sık o taşıdı, ama dizüstü işlemcide sorgu başına saniyeler alır. `basic` profili mMARCO mMiniLMv2-L12 (118M parametre, int8 ONNX, 120 MB, Apache-2.0; 14 dilde eğitilmiş, Türkçe gibi dillere de aktarılıyor) ile çift başına ~20 ms'de çalışır. İkisi de `onnxruntime-node` üzerinde, SentencePiece tokenizer'ları paketin içinde. Bir kez indirildikten sonra `auto` profilin modelini kullanır; `rerank.engine` ile başka model seçilir ya da kapatılır, `rerank.candidates` süreyle kaliteyi dengeler (15 aday süreyi yarıya indirir, kayıp küçüktür). `eval`, `bm25`/`vector`/`hybrid` yanında `rerank` modunu da raporlar; kazanç kendi belgelerinizde görünür.

**Kalite raporu.** Her çalışma `manifest.json`'a `quality` yazar: kaynağına göre sayfalar ve OCR güveni, metne benzemeyen bloklar, başlık derinliği ve atlanan seviyeler, dedektöre göre tablolar ve seyrek olanlar, açıklamalı/açıklamasız şekiller, chunk boyutları ve konumu bilinenler — ayrıca `flags`: "3 sayfada metin yok — taranmış sayfalar için OCR motoru gerekir" ya da "2 tabloda hücrelerin çoğu boş" gibi düz dille bulgular. `rag-chunker process` ilk bulguları, `rag-chunker inspect <klasör>` hepsini yazdırır.

**Benchmark.** `npm run bench` paketi beş açık belgede (Anayasa, TEMD hipertansiyon kılavuzu, Sağlık Bakanlığı diyabet protokolü, BERT ve Llama 2 makaleleri; orijinal adreslerinden indirilip sha256 ile doğrulanır, dağıtılmaz) çalıştırır ve `bench/questions/` içindeki sabit soru kümeleriyle değerlendirir. Tablo basar (sayfa, süre, chunk, başlık, tablo, şekil, arama moduna göre MRR) ve `bench/results/<tarih>-<etiket>.json` yazar; `--embedding <model>` vektör/hibrit, `--rerank` yeniden sıralayıcı ekler. Korpus kartı ve güncel sayılar `bench/README.md`'de.

**Çalışmaları karşılaştırma.** `rag-chunker eval <A> <B> --compare` aynı belgenin birden çok çıktısını tek soru kümesiyle (ilk klasörün `eval-questions.json`'ı ya da `--questions-file`) değerlendirir; her çıktı için MRR ve hit@5'i ilkine göre farkıyla, kaç sorunun iyileşip kaçının gerilediğini ve sırası değişen her soruyu gösterir; tek klasörde arama modlarını aynı biçimde karşılaştırır. Sonuç `eval-compare.json`'a yazılır.

**Sayfa düzeni analizi (yerel, anahtarsız).** `--layout` (veya `--local`) ile her PDF sayfası ayrıca PP-DocLayoutV3'ten (130 MB'lık ONNX modeli) geçer: model sayfadaki blokları etiketler (başlık, bölüm başlığı, metin, tablo, şekil, altyazı, dipnot, üst/alt bilgi, sayfa numarası, formül, kaynakça…) ve okuma sırasını verir. Metin yine metin katmanından alınır; model bloğun ne olduğuna ve hangi sırada okunduğuna karar verir: üst/alt bilgi, sayfa numaraları ve şekil içindeki etiketler düşer, altyazı ve dipnotlar asla başlık olmaz, başlıklar olur (satıra sarılan başlıklar birleşir), tablolar modelin gösterdiği yerde aranır, çok sütunlu sayfalar modelin sırasını izler. `document.json`'daki bloklar sınıfı `label` olarak taşır. Opsiyonel `onnxruntime-node` paketi gerekir (`npm install onnxruntime-node`); modeller (PP-DocLayoutV3 + SLANet_plus, 138 MB) ilk kullanımda projenin Hugging Face deposundan ([msbayindir/rag-chunker-models](https://huggingface.co/msbayindir/rag-chunker-models); lisanslarıyla birlikte değiştirilmemiş PaddleOCR dışa aktarımları) `~/.rag-chunker/models` altına indirilir (`RAG_CHUNKER_MODELS_DIR` ile değiştirilebilir) ve hash ile doğrulanır. Maliyet dizüstü işlemcide sayfa başına yaklaşık bir saniye, sayfa bazında cache'lenir. `rag-chunker doctor` hazır olup olmadığını, `--dry-run` çalışmada ne kullanılacağını gösterir.

PDF metin katmanındaki tablolar tablo olarak kurulur: çizgili ızgaralar (birleşik hücreler ve iki satırlı başlıklar dahil), yalnızca yatay çizgili makale tabloları ve hiç çizgisi olmayıp hizalı sütunlardan tanınan tablolar. `--layout` ile, çizilmiş bir ızgaranın açıklamadığı tablo bölgeleri ayrıca SLANet_plus'tan (8 MB'lık tablo yapısı modeli) geçer: model görüntüden satır, sütun ve birleşmeleri tahmin eder, sayfa metni hücrelere yerleştirilir ve metnin daha büyük kısmını hizalamadan iyi açıkladığı yerde kullanılır; taranmış sayfalar, görseller ve çok seviyeli başlıklı tablolar yapısını böyle alır (çizgiler arasında hizalamanın birleştirdiği dar sütunları da ayırır). `document.json`'daki `table.source` hangi dedektörün bulduğunu söyler (`ruled`, `rules`, `aligned`, `model`). `document.md`'de GFM tablosu, chunk'larda tablo chunk'ı olurlar (kısa tablo başlığıyla birlikte, uzun tablo başlık satırı tekrarlanarak bölünür); `document.json` hücre yapısını birleşmelerle birlikte tutar (`tableToHtml()` ile HTML), sonraki sayfaya taşan tabloya başlık aktarılır ve iki parça bağlanır. `teds()` tanınan tabloyu referansla karşılaştırır.

Her doküman için beş dosya yazılır: `chunks.jsonl` (satır başına bir chunk), `document.md` (sayfa işaretli tam markdown), `structure.json` (başlıklar, tablolar, bölümler), `document.json` (her bloğun sayfası, sayfadaki konumu ve içinde bulunduğu chunk'lar; PDF metin katmanından gelen chunk'lar da `boxes` alanında konumlarını taşır), `manifest.json` (sürüm, aşama başına modeller, istatistikler, token kullanımı, anahtarsız config, uyarılar). Alanların açıklaması [İngilizce README](README.md#output)'de.

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

## Ölçümler

rag-chunker 4.2.0, varsayılan `full` profille (yerel layout, OCR, tablo ve formül modelleri; API
anahtarı yok), yalnız sayfa görselleriyle, Apple M1'de ölçüldü. Sayfa sayfa sonuçlar ve yeniden
üretme komutları [`bench/`](bench/README.md#external-benchmarks) klasöründe.

**Belge okuma — [OmniDocBench](https://github.com/opendatalab/OmniDocBench) v1.6 setinin 1.651
sayfasının tamamı, resmi değerlendirme betiğiyle** (resmi uçtan uca tablodaki gibi sayfa
ortalaması):

| | Metin düzenleme mesafesi ↓ | Tablo TEDS ↑ | Tablo TEDS-S ↑ | Okuma sırası ↓ |
| --- | ---: | ---: | ---: | ---: |
| **rag-chunker 4.2.0** | **0.165** | **55.2** | **69.2** | **0.218** |
| Marker (resmi tablo) | 0.157 | 65.8 | 73.2 | 0.243 |
| MinerU pipeline (resmi tablo) | 0.055 | 81.9 | 88.7 | 0.153 |

Dile göre: İngilizce 0.151 (755 sayfa), Basitleştirilmiş Çince 0.156 (765 sayfa), İngilizce-Çince
karışık 0.290 (116 sayfa). Metinde Marker'a yakın ve MinerU'nun epey gerisinde, okuma sırasında
Marker'ın önünde; en zayıf yanımız tablolar. 4.2.0 yan taranmış sayfaları dik okuyor (setteki 10
sayfa, hepsi sayfaya yatay basılmış tablolar): onların TEDS'i yükseldi, diğer her sayfanın metin
puanı 4.1.0 ile birebir aynı (4.1.0: 0.165 / 54.8 / 68.5 / 0.218). Formül (CDM) skoru LaTeX araç zinciri istediği için
yok, bu yüzden resmi "Overall" verilmiyor. Rakip satırları resmi tablodan alındı, biz koşturmadık;
resmi betiği ana dalının 2026-10-19 haliyle ve varsayılan eşleştirme ayarlarıyla çalıştırdık.

**Taranmış Türkçe belgeler** (metin katmanlı orijinale göre karakter hata oranı): hipertansiyon
kılavuzu %10,1 (4.0.0: %13,2), Anayasa %1,5 (%2,5).

**Arama** (cevabı içeren parçanın MRR'ı; hibrit arama, ilk 30 aday yeniden sıralanır):

| Set | Hibrit | + mmarco-MiniLM (`basic`) | + bge-reranker-v2-m3 (`full`) |
| --- | ---: | ---: | ---: |
| [FinanceBench](https://github.com/patronus-ai/financebench), 150 analist sorusu, raporun içinde | 0.268 | 0.216 | **0.329** |
| FinanceBench, 83 raporun tek indeksi | 0.169 | 0.169 | **0.288** |
| [SQuAD-TR](https://github.com/boun-tabi/squad-tr), 100 Türkçe soru | 0.805 | 0.876 | **0.938** |

**Nerede duruyor.** İşinizin merkezinde tablo çıkarımı varsa (finansal tablolar) ya da GPU'lu bir
Python altyapısı kullanıyorsanız MinerU belgeleri daha iyi ayrıştırır. rag-chunker'ın yeri,
belgeden kaynak gösteren ve aranabilen chunk'lara kadar bütün yolu Node.js'te, yerel olarak ve
Python'suz yürütmek; sayıları doğrulanabilir, `rag-chunker eval` ile kendi belgelerinizde de
ölçebilirsiniz.

## Ajanlar için MCP sunucusu

```json
{
  "mcpServers": {
    "belgeler": { "command": "npx", "args": ["-y", "@msbayindir/rag-chunker", "mcp", "/tam/yol/cikti/kitap"] }
  }
}
```

Araçlar: `search`, `get_chunk`, `get_page`, `list_documents`.

`--rerank` ile her `search` isteği `local.profile`'ın reranker'ından geçer; sunucu modeli ilk aramada indirir (istemcinin el sıkışması önce yanıtlanır). `full` profilin `bge-reranker-v2-m3` modeli dizüstü işlemcide arama başına saniyeler alır: `--candidates 15` bunu küçük bir kayıpla yarıya indirir (FinanceBench MRR 30 adayda 0,329 yerine 0,315), `--profile basic` ise çift başına yaklaşık 20 ms süren `mmarco-minilm`'e geçer.

## Sorun giderme

| Sorun | Çözüm |
|---|---|
| `N page(s) have no usable text layer` | Taranmış sayfalar: `MISTRAL_API_KEY` tanımlayın, `--local` ya da `--ocr <vision model>` kullanın |
| `model is not installed in Ollama` | `ollama pull <model>` |
| `cannot reach Ollama` | Ollama uygulamasını açın ya da `ollama serve`; uzak sunucu için `OLLAMA_HOST` |
| `needs an API key` | Anahtarı `.env`'e ya da ortama yazın (hata mesajı değişken adını söyler) |
| `plan has no quota for this model` | Anahtar geçerli ama planı o model için 0 istek hakkı veriyor (ücretsiz planlarda Mistral OCR'da sık görülür). Sağlayıcı konsolundan faturalandırmayı açın. `ocr.engine: "auto"` iken rag-chunker uyarı verip vision modele ya da metin katmanına geçer |
| `rate limited (429) even after retries` | `providers.<ad>.concurrency` değerini düşürüp tekrar çalıştırın; biten sayfalar ve chunk'lar cache'ten gelir |
| Küçük yerel model geçersiz JSON döndürüyor | Otomatik olarak yeniden denenir ve bölünür; kalıcı hatalar uyarı olarak görünür. `structure` için daha büyük bir model kullanın |

Önce `rag-chunker doctor` çalıştırın; yukarıdakilerin hepsini kontrol eder.

## Gereksinimler

Node.js 22 veya üzeri. İsteğe bağlı: yerel modeller için [Ollama](https://ollama.com).

**Kurulum boyutu.** Paketin kendisi 1,5 MB; `npm install` yerel modellerin gerektirdiği isteğe bağlı yerel paketleri de getirir, diskte yaklaşık 700 MB: `onnxruntime-node` (290 MB, her işletim sistemi için ikili dosyalar), formül modeli için `@huggingface/transformers` (kendi bağımlılıklarıyla 180 MB), `@napi-rs/canvas` ve sağlayıcı SDK'ları. `npm install --omit=optional` yalnız çekirdeği kurar (metin katmanı, chunk'lama, bulut sağlayıcıları); kullandığınızı sonradan eklersiniz, örneğin yerel OCR, layout, tablo ve reranker için `npm install onnxruntime-node @napi-rs/canvas`. Model dosyaları ilk kullanımda `~/.rag-chunker/models` klasörüne iner (`RAG_CHUNKER_MODELS_DIR`), pakete hiç girmez.

## Örnekler

[`examples/`](examples/) klasöründe çalıştırılabilir betikler var: temel kullanım, yerel yerleşim modeli ile şekiller ve betimlemeleri, XLSX/HTML girdileri, reranker ile iki aşamalı arama, iki chunk boyutunu `eval --compare` ile karşılaştırma, tamamen yerel hat, karışık sağlayıcılar, pgvector sorgusu ve Claude Desktop / Claude Code / Cursor için MCP kurulumu.

## Geri bildirim ve katkı

- Yanlış çıkan bir belge (eksik metin, okuma sırası, tablo, başlık, şekil, OCR): `rag-chunker inspect <klasör>` çıktısındaki kalite bulgularıyla bir [belge sorunu](https://github.com/msbayindir/rag-chunker/issues/new/choose) açın — en işe yarayan bildirim türü bu.
- Soru, fikir ve ne yaptığınız: [Discussions](https://github.com/msbayindir/rag-chunker/discussions).
- Güvenlik: [SECURITY.md](SECURITY.md) (GitHub üzerinden özel bildirim).
- Pull request'ler açık — bkz. [CONTRIBUTING.md](CONTRIBUTING.md).

## Lisans

[MIT](LICENSE)
