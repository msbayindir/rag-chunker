/** Known text drawn into the generated fixtures, so tests can assert on it. */
export const HEADER = 'Klinik Rehber 2026 — Elektrolitler'

export const PAGE1 = {
  title: 'Elektrolit Bozuklukları',
  heading: '1. Hiponatremi',
  paragraphs: [
    'Hiponatremi, serum sodyum konsantrasyonunun 135 mmol/L altına düşmesiyle tanımlanır ve hastanede yatan hastalarda en sık görülen elektrolit bozukluğudur.',
    'Tedavi yaklaşımı hastanın volüm durumuna, semptomların şiddetine ve bozukluğun gelişme hızına göre belirlenir. Akut semptomatik olgularda hipertonik salin önerilir.',
  ],
}

export const PAGE2 = {
  heading: '1.1 Tanı Kriterleri',
  paragraph:
    'Tanı için serum osmolalitesi, idrar osmolalitesi ve idrar sodyum düzeyi birlikte değerlendirilmelidir. Klinik öykü, ilaç kullanımı ve eşlik eden hastalıklar ayrıntılı sorgulanmalıdır.',
  bullets: [
    'Serum sodyumu 135 mmol/L altındadır.',
    'Serum osmolalitesi 275 mOsm/kg altındadır.',
    'İdrar osmolalitesi 100 mOsm/kg üzerindedir.',
  ],
  hyphenated: [
    'Plazma ozmolalitesinin düşük olması hipotonik hiponatremiyi gösterir ve konsantras-',
    'yonun düzeltilmesi yavaş yapılmalıdır.',
  ],
}

export const PAGE3 = {
  heading: '2. Hiperkalemi',
  paragraphs: [
    'Hiperkalemi, serum potasyum düzeyinin 5,5 mmol/L üzerine çıkmasıdır ve kardiyak aritmilere yol açabilir.',
    'Acil tedavide kalsiyum glukonat kardiyak membranı stabilize eder; insülin ve glukoz potasyumu hücre içine taşır.',
  ],
}

/** Rendered into an image (no text layer) on page 4. */
export const SCANNED = {
  heading: '3. Hipokalsemi',
  paragraph:
    'Hipokalsemi tetani, parestezi ve kas krampları ile kendini gösterir. Tedavide kalsiyum ve D vitamini kullanılır.',
}

export const TWO_COLUMN = {
  left: [
    'Sol sütun birinci paragraf böbrek fizyolojisini anlatır ve nefron yapısını özetler.',
    'Sol sütun ikinci paragraf glomerüler filtrasyon hızını açıklar.',
  ],
  right: [
    'Sağ sütun birinci paragraf tübüler geri emilimi anlatır.',
    'Sağ sütun ikinci paragraf idrar konsantrasyon mekanizmasını açıklar.',
  ],
}

export const SIDE_BY_SIDE = {
  intro:
    'Bu sayfa tek sütunlu bir metindir ve iki farklı yanıtı yan yana gösteren bir karşılaştırma kutusu içerir. Kutunun öncesindeki ve sonrasındaki paragraflar sayfanın tüm genişliğini kaplar, böylece sayfa bütün olarak iki sütunlu görünmez.',
  left: 'Sol kutudaki yanıt kısa ve doğrudan bir açıklama yapar, kullanıcının sorusunu tek paragrafta yanıtlar ve ek kaynak önermez.',
  right:
    'Sağ kutudaki yanıt aynı soruyu daha ayrıntılı ele alır, gerekçelerini sıralar ve okuyucuyu güvenilir kaynaklara yönlendirir.',
  outro:
    'Karşılaştırmanın ardından metin yeniden tek sütun olarak devam eder ve iki yanıt arasındaki farkları özetleyen genel bir değerlendirme sunar. Bu paragraf da sayfanın tamamını kaplayacak kadar uzundur.',
}

/** tables.pdf: a ruled grid with spans, a rules-only (booktabs) table, an aligned table and a table split over two pages. */
export const TABLES = {
  caption1: 'Tablo 1. Serum elektrolitleri için referans aralıkları',
  ruled: {
    // Two header rows: "Parametre" and "Birim" span both, "Referans aralığı" spans two columns.
    header: [
      ['Parametre', 'Birim', 'Referans aralığı', ''],
      ['', '', 'Alt sınır', 'Üst sınır'],
    ],
    rows: [
      ['Sodyum', 'mmol/L', '135', '145'],
      ['Potasyum', 'mmol/L', '3,5', '5,1'],
      ['Klor', 'mmol/L', '98', '107'],
      ['İyonize kalsiyum', 'mmol/L', '1,12', '1,32'],
    ],
  },
  afterRuled:
    'Referans aralıkları laboratuvara göre küçük farklar gösterebilir; sonuçlar klinik tablo ile birlikte yorumlanmalıdır.',
  caption3: 'Tablo 3. Model karşılaştırması',
  rules: {
    header: ['Ad', 'Boy', 'Puan'],
    rows: [
      ['Llama', '7B', '45,3'],
      ['Qwen', '9B', '51,0'],
      ['Phi', '4B', '38,7'],
    ],
  },
  caption2: 'Tablo 2. Günlük sıvı dengesi',
  aligned: {
    header: ['Gün', 'Alınan (mL)', 'Çıkarılan (mL)'],
    rows: [
      ['1', '2400', '2100'],
      ['2', '2200', '2300'],
      ['3', '2500', '2450'],
      ['4', '2100', '2000'],
      ['5', '2300', '2250'],
    ],
  },
  afterAligned: 'Sıvı dengesi günlük olarak kaydedilir ve belirgin sapmalarda tedavi planı gözden geçirilir.',
  continued: {
    header: ['İlaç', 'Doz', 'Sıklık'],
    firstPage: [
      ['Metformin', '500 mg', 'Günde 2 kez'],
      ['Gliklazid', '30 mg', 'Günde 1 kez'],
      ['Sitagliptin', '100 mg', 'Günde 1 kez'],
      ['Empagliflozin', '10 mg', 'Günde 1 kez'],
      ['Pioglitazon', '15 mg', 'Günde 1 kez'],
    ],
    secondPage: [
      ['İnsülin glargin', '10 Ü', 'Gece 1 kez'],
      ['İnsülin aspart', '4 Ü', 'Öğünlerde'],
      ['Liraglutid', '0,6 mg', 'Günde 1 kez'],
      ['Akarboz', '50 mg', 'Günde 3 kez'],
      ['Repaglinid', '0,5 mg', 'Öğünlerde'],
    ],
  },
  afterContinued: 'Dozlar böbrek işlevine göre ayarlanır ve tedavi düzenli aralıklarla değerlendirilir.',
}

export const DOCX = {
  h1: 'Böbrek Fonksiyonları',
  p1: 'Böbrekler sıvı ve elektrolit dengesini düzenleyen başlıca organlardır.',
  h2: 'Glomerüler Filtrasyon',
  p2: 'Glomerüler filtrasyon hızı böbrek fonksiyonunun en önemli göstergesidir.',
  table: [
    ['Parametre', 'Normal Değer'],
    ['GFR', '90-120 mL/dk'],
    ['Kreatinin', '0,6-1,2 mg/dL'],
  ],
}

export const PPTX = {
  slide1: {
    title: 'Sıvı Dengesi',
    bullets: ['Total vücut suyu', 'Hücre içi sıvı', 'Hücre dışı sıvı'],
    notes: 'Konuşmacı notu: sıvı kompartmanlarını açıklayın.',
  },
  slide2: {
    title: 'Elektrolit Değerleri',
    table: [
      ['Elektrolit', 'Aralık'],
      ['Sodyum', '135-145'],
      ['Potasyum', '3,5-5,0'],
    ],
  },
}
