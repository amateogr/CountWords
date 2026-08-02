(function(){
  'use strict';

  const MAX_CHARS = 500000;    // límite duro de proceso de texto
  const SOFT_WARN = 200000;    // aviso de rendimiento
  const MAX_TXT_BYTES = 5 * 1024 * 1024;   // 5MB para .txt
  const MAX_DOC_BYTES = 20 * 1024 * 1024;  // 20MB para .docx/.pdf
  const MAX_PDF_PAGES = 500;   // cota anti "PDF bomb"

  // Self-hosted: sin dependencia de terceros en runtime. Los ficheros vienen
  // del paquete oficial de npm (mammoth@1.11.0 / pdfjs-dist@6.1.200), servidos
  // same-origin — ya no hace falta SRI ni abrir el CSP a un CDN externo.
  const MAMMOTH_URL = '/vendor/mammoth.browser.min.js';
  const PDFJS_URL = '/vendor/pdf.min.mjs';
  const PDFJS_WORKER_URL = '/vendor/pdf.worker.min.mjs';

  const $ = id => document.getElementById(id);
  const input = $('input'), localeSelect = $('localeSelect'), wpmSelect = $('wpmSelect');
  const capLabel = $('capLabel'), warnBanner = $('warnBanner');

  const SUPPORTS_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
  if (!SUPPORTS_SEGMENTER){
    warnBanner.textContent = 'Este navegador no soporta Intl.Segmenter. Usando aproximación por espacios en blanco (menos precisa para CJK/Thai/Lao/Khmer).';
    warnBanner.classList.add('show');
  }

  // ---- detección de escritura por rango Unicode (sin libs externas, sin llamadas de red) ----
  const SCRIPT_RANGES = [
    ['han', /[\u4E00-\u9FFF\u3400-\u4DBF]/g],
    ['hiragana', /[\u3040-\u309F]/g],
    ['katakana', /[\u30A0-\u30FF]/g],
    ['hangul', /[\uAC00-\uD7A3]/g],
    ['thai', /[\u0E00-\u0E7F]/g],
    ['lao', /[\u0E80-\u0EFF]/g],
    ['khmer', /[\u1780-\u17FF]/g],
    ['myanmar', /[\u1000-\u109F]/g],
    ['arabic', /[\u0600-\u06FF\u0750-\u077F]/g],
    ['hebrew', /[\u0590-\u05FF]/g],
    ['devanagari', /[\u0900-\u097F]/g],
    ['cyrillic', /[\u0400-\u04FF]/g],
    ['greek', /[\u0370-\u03FF]/g],
    ['latin', /[A-Za-zÀ-ÖØ-öø-ÿĀ-ɏ]/g],
  ];

  const SPECIMENS = {
    en:{name:'Latino · genérico', glyphs:['A','a','É','&'], rtl:false, charBased:false},
    es:{name:'Latino · español', glyphs:['A','ñ','¿','Á'], rtl:false, charBased:false},
    ja:{name:'Japonés · Han + Kana', glyphs:['字','あ','ア','漢'], rtl:false, charBased:true},
    zh:{name:'Chino · Han', glyphs:['字','文','语','中'], rtl:false, charBased:true},
    ko:{name:'Coreano · Hangul', glyphs:['한','글','국','어'], rtl:false, charBased:true},
    th:{name:'Tailandés', glyphs:['ก','ฎ','ท','๐'], rtl:false, charBased:true},
    lo:{name:'Lao', glyphs:['ກ','ຂ','ງ','ລ'], rtl:false, charBased:true},
    km:{name:'Jemer', glyphs:['ក','ខ','គ','ឃ'], rtl:false, charBased:true},
    my:{name:'Birmano', glyphs:['က','ခ','ဂ','ဃ'], rtl:false, charBased:true},
    ar:{name:'Árabe', glyphs:['ا','ب','ت','ث'], rtl:true, charBased:false},
    he:{name:'Hebreo', glyphs:['א','ב','ג','ד'], rtl:true, charBased:false},
    hi:{name:'Hindi · Devanagari', glyphs:['क','ख','ग','ह'], rtl:false, charBased:false},
    ru:{name:'Ruso · cirílico', glyphs:['А','Б','В','Я'], rtl:false, charBased:false},
    el:{name:'Griego', glyphs:['Α','Β','Γ','Ω'], rtl:false, charBased:false},
  };

  function detectLocale(sample){
    const counts = {};
    for (const [name, re] of SCRIPT_RANGES){
      const m = sample.match(re);
      counts[name] = m ? m.length : 0;
    }
    if (counts.hiragana > 0 || counts.katakana > 0) return 'ja';
    if (counts.han > 3) return 'zh';
    if (counts.hangul > 3) return 'ko';
    if (counts.thai > 3) return 'th';
    if (counts.lao > 3) return 'lo';
    if (counts.khmer > 3) return 'km';
    if (counts.myanmar > 3) return 'my';
    if (counts.arabic > 3) return 'ar';
    if (counts.hebrew > 3) return 'he';
    if (counts.devanagari > 3) return 'hi';
    if (counts.cyrillic > 3) return 'ru';
    if (counts.greek > 3) return 'el';
    return 'en';
  }

  // ---- núcleo de análisis, compartido entre el fallback síncrono y el Worker ----
  // (se serializa a texto plano para inyectarse también dentro del Worker; ver WORKER_SRC)
  const ANALYZE_CORE_SRC = [
    'function analyzeCore(text, locale, wpmFactor, charBased, supportsSegmenter){',
    '  if (!text){',
    '    return {words:0, chars:0, charsNS:0, sentences:0, paras:0, unique:0, density:0, avgLen:0, readMin:0, speakMin:0, top:[]};',
    '  }',
    '  var words = 0, chars = 0, sentences = 0, uniqueSet = new Set(), totalWordLen = 0;',
    '  var freq = new Map();',
    '  if (supportsSegmenter){',
    '    var graphemeSeg = new Intl.Segmenter(locale, {granularity:"grapheme"});',
    '    var g; for (g of graphemeSeg.segment(text)) chars++;',
    '    var wordSeg = new Intl.Segmenter(locale, {granularity:"word"});',
    '    var w; for (w of wordSeg.segment(text)){',
    '      if (w.isWordLike){',
    '        words++;',
    '        totalWordLen += [...w.segment].length;',
    '        var key = w.segment.toLowerCase();',
    '        uniqueSet.add(key);',
    '        freq.set(key, (freq.get(key) || 0) + 1);',
    '      }',
    '    }',
    '    var sentSeg = new Intl.Segmenter(locale, {granularity:"sentence"});',
    '    var s; for (s of sentSeg.segment(text)){ if (s.segment.trim().length > 0) sentences++; }',
    '  } else {',
    '    chars = [...text].length;',
    '    var tokens = text.trim().split(/\\s+/).filter(Boolean);',
    '    words = tokens.length;',
    '    for (var i=0;i<tokens.length;i++){',
    '      var t = tokens[i];',
    '      totalWordLen += t.length;',
    '      var k2 = t.toLowerCase();',
    '      uniqueSet.add(k2);',
    '      freq.set(k2, (freq.get(k2) || 0) + 1);',
    '    }',
    '    sentences = (text.match(/[.!?¡¿。！？]+/g) || []).length || (text.trim() ? 1 : 0);',
    '  }',
    '  var charsNS = chars - (text.match(/\\s/g) || []).length;',
    '  var paras = text.split(/\\n\\s*\\n+/).map(function(p){return p.trim();}).filter(Boolean).length || (text.trim() ? 1 : 0);',
    '  var unique = uniqueSet.size;',
    '  var density = words ? Math.round((unique / words) * 100) : 0;',
    '  var avgLen = words ? +(totalWordLen / words).toFixed(1) : 0;',
    '  var readBase = charBased ? (charsNS / 300) : (words / 200);',
    '  var readMin = Math.max(readBase / wpmFactor, (words || charsNS) ? 0.1 : 0);',
    '  var speakMin = Math.max((words || charsNS * 0.5) / 130, 0);',
    '  var top = [...freq.entries()].sort(function(a,b){return b[1]-a[1];}).slice(0, 6);',
    '  return {words:words, chars:chars, charsNS:charsNS, sentences:sentences, paras:paras, unique:unique,',
    '    density:density, avgLen:avgLen,',
    '    readMin: Math.ceil(readMin) || (text.trim() ? 1 : 0),',
    '    speakMin: Math.ceil(speakMin) || (text.trim() ? 1 : 0), top:top};',
    '}'
  ].join('\n');

  // Fallback en hilo principal — función real, no generada vía eval/Function()
  // (evita depender de 'unsafe-eval' en la CSP del host; solo se usa si el Worker falla).
  function analyzeSync(text, locale, wpmFactor, charBased, supportsSegmenter){
    if (!text){
      return {words:0, chars:0, charsNS:0, sentences:0, paras:0, unique:0, density:0, avgLen:0, readMin:0, speakMin:0, top:[]};
    }
    let words = 0, chars = 0, sentences = 0, uniqueSet = new Set(), totalWordLen = 0;
    const freq = new Map();
    if (supportsSegmenter){
      const graphemeSeg = new Intl.Segmenter(locale, {granularity:'grapheme'});
      for (const _ of graphemeSeg.segment(text)) chars++;
      const wordSeg = new Intl.Segmenter(locale, {granularity:'word'});
      for (const {segment, isWordLike} of wordSeg.segment(text)){
        if (isWordLike){
          words++;
          totalWordLen += [...segment].length;
          const key = segment.toLowerCase();
          uniqueSet.add(key);
          freq.set(key, (freq.get(key) || 0) + 1);
        }
      }
      const sentSeg = new Intl.Segmenter(locale, {granularity:'sentence'});
      for (const {segment} of sentSeg.segment(text)){
        if (segment.trim().length > 0) sentences++;
      }
    } else {
      chars = [...text].length;
      const tokens = text.trim().split(/\s+/).filter(Boolean);
      words = tokens.length;
      for (const t of tokens){
        totalWordLen += t.length;
        const key = t.toLowerCase();
        uniqueSet.add(key);
        freq.set(key, (freq.get(key) || 0) + 1);
      }
      sentences = (text.match(/[.!?¡¿。！？]+/g) || []).length || (text.trim() ? 1 : 0);
    }
    const charsNS = chars - (text.match(/\s/g) || []).length;
    const paras = text.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean).length || (text.trim() ? 1 : 0);
    const unique = uniqueSet.size;
    const density = words ? Math.round((unique / words) * 100) : 0;
    const avgLen = words ? +(totalWordLen / words).toFixed(1) : 0;
    const readBase = charBased ? (charsNS / 300) : (words / 200);
    const readMin = Math.max(readBase / wpmFactor, (words || charsNS) ? 0.1 : 0);
    const speakMin = Math.max((words || charsNS * 0.5) / 130, 0);
    const top = [...freq.entries()].sort((a,b) => b[1]-a[1]).slice(0, 6);
    return {words, chars, charsNS, sentences, paras, unique, density, avgLen,
      readMin: Math.ceil(readMin) || (text.trim() ? 1 : 0),
      speakMin: Math.ceil(speakMin) || (text.trim() ? 1 : 0), top};
  }

  // ---- Worker aislado: el conteo nunca bloquea el hilo de UI ----
  const WORKER_SRC = ANALYZE_CORE_SRC + '\n' + [
    'self.onmessage = function(e){',
    '  var d = e.data;',
    '  var supportsSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";',
    '  var r = analyzeCore(d.text, d.locale, d.wpmFactor, d.charBased, supportsSegmenter);',
    '  r.reqId = d.reqId; r.locale = d.locale;',
    '  self.postMessage(r);',
    '};'
  ].join('\n');

  let worker = null, workerReady = false, reqCounter = 0, latestReqId = 0;
  try {
    const blob = new Blob([WORKER_SRC], {type:'application/javascript'});
    worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = (e) => {
      const r = e.data;
      if (r.reqId !== latestReqId) return; // descarta respuestas obsoletas (usuario siguió tecleando)
      lastResult = r;
      render(r);
    };
    worker.onerror = (err) => {
      console.error('Worker de análisis falló, degradando a hilo principal:', err.message);
      workerReady = false;
    };
    workerReady = true;
  } catch(err){
    console.warn('Web Worker no disponible, usando cálculo síncrono en hilo principal.', err);
  }
  $('engineLabel').textContent = 'Intl.Segmenter · ' + (workerReady ? 'Worker' : 'hilo principal');

  // ---- render (siempre vía textContent — nunca innerHTML con texto del usuario) ----
  function setSpecimen(locale, auto){
    const spec = SPECIMENS[locale] || SPECIMENS.en;
    const glyphsBox = $('specimenGlyphs');
    glyphsBox.innerHTML = '';
    spec.glyphs.forEach(g => {
      const span = document.createElement('span');
      span.textContent = g; // glifos estáticos curados, no derivados del input
      glyphsBox.appendChild(span);
    });
    $('specimenName').textContent = spec.name;
    $('specimenLocale').textContent = (auto ? 'auto → ' : 'manual → ') + locale + ' · dir ' + (spec.rtl ? 'rtl' : 'ltr');
    document.getElementById('input').dir = spec.rtl ? 'rtl' : 'auto';
  }

  function fmt(n){ return n.toLocaleString('es-ES'); }

  function render(r){
    $('statWords').textContent = fmt(r.words);
    $('statChars').textContent = fmt(r.chars);
    $('statCharsNS').textContent = fmt(r.charsNS);
    $('statSentences').textContent = fmt(r.sentences);
    $('statParas').textContent = fmt(r.paras);
    $('statUnique').textContent = fmt(r.unique);
    $('statDensity').textContent = r.density + '%';
    $('statAvgLen').textContent = r.avgLen;
    $('statReadTime').textContent = r.readMin + ' min';
    $('statSpeakTime').textContent = r.speakMin + ' min';

    const freqList = $('freqList');
    freqList.innerHTML = '';
    const maxCount = r.top.length ? r.top[0][1] : 1;
    r.top.forEach(([word, count]) => {
      const row = document.createElement('div');
      row.className = 'freq-row';

      const w = document.createElement('div');
      w.className = 'w'; w.textContent = word;

      const track = document.createElement('div');
      track.className = 'freq-bar-track';
      const bar = document.createElement('div');
      bar.className = 'freq-bar';
      bar.style.width = Math.max(6, Math.round((count / maxCount) * 100)) + '%';
      track.appendChild(bar);

      const n = document.createElement('div');
      n.className = 'n'; n.textContent = count;

      row.appendChild(w); row.appendChild(track); row.appendChild(n);
      freqList.appendChild(row);
    });
  }

  // ---- ciclo principal con debounce ----
  let debounceTimer = null;
  let lastResult = null;

  function process(){
    let text = input.value;
    if (text.length > MAX_CHARS){
      text = text.slice(0, MAX_CHARS);
      input.value = text;
    }

    capLabel.textContent = fmt(text.length) + ' / ' + fmt(MAX_CHARS);
    capLabel.classList.toggle('warn', text.length > SOFT_WARN);
    warnBanner.classList.toggle('show', text.length > SOFT_WARN && SUPPORTS_SEGMENTER);
    if (text.length > SOFT_WARN && SUPPORTS_SEGMENTER){
      warnBanner.textContent = 'Texto grande (' + fmt(text.length) + ' car.) — el cálculo puede tardar unos milisegundos más.';
    }

    const manual = localeSelect.value !== 'auto';
    const sample = text.slice(0, 4000);
    const locale = manual ? localeSelect.value : detectLocale(sample);
    setSpecimen(locale, !manual);

    const wpmFactor = parseFloat(wpmSelect.value);
    const spec = SPECIMENS[locale] || SPECIMENS.en;
    latestReqId = ++reqCounter;

    if (workerReady){
      worker.postMessage({text, locale, wpmFactor, charBased: spec.charBased, reqId: latestReqId});
    } else {
      const r = analyzeSync(text, locale, wpmFactor, spec.charBased, SUPPORTS_SEGMENTER);
      r.locale = locale;
      lastResult = r;
      render(r);
    }
  }

  function debouncedProcess(){
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(process, 150);
  }

  input.addEventListener('input', debouncedProcess);
  localeSelect.addEventListener('change', process);
  wpmSelect.addEventListener('change', process);

  $('btnClear').addEventListener('click', () => { input.value = ''; process(); input.focus(); });

  function setFileStatus(msg, isError){
    const el = $('fileStatus');
    el.textContent = msg || '';
    el.classList.toggle('err', !!isError);
  }

  // Carga perezosa: el código de terceros solo entra en la página si el usuario
  // realmente importa ese tipo de archivo (superficie de ataque mínima por defecto).
  let mammothLoadPromise = null;
  function loadMammoth(){
    if (window.mammoth) return Promise.resolve();
    if (mammothLoadPromise) return mammothLoadPromise;
    mammothLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MAMMOTH_URL; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('No se pudo cargar el motor .docx (mammoth.js).'));
      document.head.appendChild(s);
    });
    return mammothLoadPromise;
  }

  function withTimeout(promise, ms, label){
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' tardó más de ' + (ms/1000) + 's — abortado.')), ms))
    ]);
  }

  // Escanea solo el Central Directory del ZIP (metadatos, sin descomprimir nada)
  // para detectar zip bombs antes de invocar a mammoth.extractRawText().
  // Hallazgo de pentest: un .docx de 50KB puede decodificar a 50MB+ en memoria
  // sin este guard (mammoth no impone límite propio de tamaño descomprimido).
  function checkZipBombRisk(arrayBuffer, opts = {}){
    const MAX_TOTAL_UNCOMPRESSED = opts.maxTotal ?? 60 * 1024 * 1024; // 60MB
    const MAX_RATIO = opts.maxRatio ?? 300;
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50;
    let eocdOffset = -1;
    const searchStart = Math.max(0, bytes.length - 22 - 65535);
    for (let i = bytes.length - 22; i >= searchStart; i--){
      if (view.getUint32(i, true) === EOCD_SIG){ eocdOffset = i; break; }
    }
    if (eocdOffset === -1) return {risky:false, reason:'no-eocd'}; // lo rechazará el propio parser de mammoth

    let offset = view.getUint32(eocdOffset + 16, true);
    const cdEntryCount = view.getUint16(eocdOffset + 10, true);
    let totalUncompressed = 0;

    for (let n = 0; n < cdEntryCount; n++){
      if (offset + 46 > bytes.length) break;
      if (view.getUint32(offset, true) !== CD_SIG) break;
      const compSize = view.getUint32(offset + 20, true);
      const uncompSize = view.getUint32(offset + 24, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);

      if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF){
        return {risky:true, reason:'zip64 con tamaño no acotado — inusual en un .docx real'};
      }
      totalUncompressed += uncompSize;
      const ratio = compSize > 0 ? uncompSize / compSize : (uncompSize > 0 ? Infinity : 0);
      if (ratio > MAX_RATIO && uncompSize > 1024 * 1024){
        return {risky:true, reason:'ratio de compresión ' + ratio.toFixed(0) + ':1 (' + (uncompSize/1024/1024).toFixed(1) + 'MB) — patrón de zip bomb'};
      }
      offset += 46 + nameLen + extraLen + commentLen;
    }
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED){
      return {risky:true, reason:'contenido descomprimido total ' + (totalUncompressed/1024/1024).toFixed(1) + 'MB supera el límite'};
    }
    return {risky:false, reason:'ok'};
  }

  let pdfjsLibPromise = null;
  function loadPdfjs(){
    if (pdfjsLibPromise) return pdfjsLibPromise;
    pdfjsLibPromise = import(/* webpackIgnore: true */ PDFJS_URL).then(lib => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return lib;
    });
    return pdfjsLibPromise;
  }

  async function handleDocx(file){
    setFileStatus('Cargando motor .docx…');
    await loadMammoth();
    setFileStatus('Analizando estructura del archivo…');
    const buf = await file.arrayBuffer();
    const risk = checkZipBombRisk(buf);
    if (risk.risky){
      throw new Error('Archivo .docx rechazado por seguridad: ' + risk.reason);
    }
    setFileStatus('Extrayendo texto…');
    // extractRawText: solo texto de document.xml — no procesa macros/VBA ni objetos OLE incrustados.
    const res = await withTimeout(window.mammoth.extractRawText({arrayBuffer: buf}), 15000, 'Extracción .docx');
    input.value = res.value.slice(0, MAX_CHARS);
    setFileStatus('Importado ✓' + (res.messages && res.messages.length ? ' (con avisos de formato)' : ''));
  }

  async function handlePdf(file){
    setFileStatus('Cargando motor .pdf…');
    const pdfjsLib = await loadPdfjs();
    setFileStatus('Extrayendo texto…');
    const buf = await file.arrayBuffer();
    // getDocument + getTextContent: solo capa de extracción de texto. No se carga el
    // visor/canvas ni la sandbox de JavaScript embebido (pdf.sandbox.mjs nunca se importa),
    // así que cualquier /JavaScript o /OpenAction del PDF queda sin ejecutar (verificado con fuzzing).
    const doc = await withTimeout(pdfjsLib.getDocument({data: buf, isEvalSupported: false}).promise, 15000, 'Apertura del PDF');
    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
    const out = [];
    for (let i = 1; i <= pageCount; i++){
      // hallazgo de pentest: un content stream Flate hostil puede tardar varios
      // segundos en procesarse por página — cada página tiene su propio cortafuegos de tiempo.
      const page = await withTimeout(doc.getPage(i), 15000, 'Carga de página ' + i);
      const content = await withTimeout(page.getTextContent(), 15000, 'Extracción de texto de página ' + i);
      out.push(content.items.map(it => it.str).join(' '));
      if (i % 15 === 0) setFileStatus('Extrayendo texto… página ' + i + '/' + pageCount);
    }
    input.value = out.join('\n\n').slice(0, MAX_CHARS);
    setFileStatus(doc.numPages > MAX_PDF_PAGES
      ? ('Truncado a ' + MAX_PDF_PAGES + ' de ' + doc.numPages + ' páginas.')
      : 'Importado ✓');
  }


  $('btnImport').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const name = file.name.toLowerCase();
    setFileStatus('Leyendo archivo…');
    try {
      if (name.endsWith('.txt') || file.type === 'text/plain'){
        if (file.size > MAX_TXT_BYTES) throw new Error('Archivo .txt > 5 MB.');
        input.value = (await file.text()).slice(0, MAX_CHARS);
        setFileStatus('Importado ✓');
      } else if (name.endsWith('.docx')){
        if (file.size > MAX_DOC_BYTES) throw new Error('Archivo .docx > 20 MB.');
        await handleDocx(file);
      } else if (name.endsWith('.pdf')){
        if (file.size > MAX_DOC_BYTES) throw new Error('Archivo .pdf > 20 MB.');
        await handlePdf(file);
      } else {
        throw new Error('Formato no admitido — usa .txt, .docx o .pdf.');
      }
      process();
    } catch(err){
      console.error(err);
      setFileStatus(err.message || 'Error al importar el archivo.', true);
    }
  });

  $('btnCopy').addEventListener('click', async () => {
    if (!lastResult) return;
    const payload = JSON.stringify(lastResult, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      const btn = $('btnCopy'); const orig = btn.textContent;
      btn.textContent = 'Copiado ✓'; setTimeout(() => btn.textContent = orig, 1200);
    } catch(_) { alert('No se pudo copiar al portapapeles.'); }
  });

  $('btnDownload').addEventListener('click', () => {
    if (!lastResult) return;
    const r = lastResult;
    const report = [
      'INFORME DE TEXTO', '='.repeat(40),
      'Escritura/locale: ' + r.locale,
      'Palabras: ' + r.words,
      'Caracteres: ' + r.chars,
      'Caracteres sin espacios: ' + r.charsNS,
      'Oraciones: ' + r.sentences,
      'Párrafos: ' + r.paras,
      'Palabras únicas: ' + r.unique,
      'Densidad léxica: ' + r.density + '%',
      'Longitud media de palabra: ' + r.avgLen,
      'Tiempo de lectura: ' + r.readMin + ' min',
      'Tiempo de habla: ' + r.speakMin + ' min',
      '', 'Top tokens:',
      ...r.top.map(([w,c]) => '  ' + w + ' — ' + c),
    ].join('\n');
    const blob = new Blob([report], {type:'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'informe-texto.txt';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

  process();
})();
