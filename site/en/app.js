(function(){
  'use strict';

  const MAX_CHARS = 500000;    // hard cap on text processed
  const SOFT_WARN = 200000;    // performance warning threshold
  const MAX_TXT_BYTES = 5 * 1024 * 1024;   // 5MB for .txt
  const MAX_DOC_BYTES = 20 * 1024 * 1024;  // 20MB for .docx/.pdf
  const MAX_PDF_PAGES = 500;   // anti "PDF bomb" cap

  // Self-hosted: no third-party runtime dependency. Files come from the
  // official npm packages (mammoth@1.11.0 / pdfjs-dist@6.1.200), served
  // same-origin — no SRI needed, no CDN to allow in the CSP.
  const MAMMOTH_URL = '/vendor/mammoth.browser.min.js';
  const PDFJS_URL = '/vendor/pdf.min.mjs';
  const PDFJS_WORKER_URL = '/vendor/pdf.worker.min.mjs';

  const $ = id => document.getElementById(id);
  const input = $('input'), localeSelect = $('localeSelect'), wpmSelect = $('wpmSelect');
  const capLabel = $('capLabel'), warnBanner = $('warnBanner');

  const SUPPORTS_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
  if (!SUPPORTS_SEGMENTER){
    warnBanner.textContent = 'This browser doesn\u2019t support Intl.Segmenter. Falling back to whitespace-based approximation (less accurate for CJK/Thai/Lao/Khmer).';
    warnBanner.classList.add('show');
  }

  // ---- script detection by Unicode range (no external libs, no network calls) ----
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
    en:{name:'Latin · generic', glyphs:['A','a','É','&'], rtl:false, charBased:false},
    es:{name:'Latin · Spanish', glyphs:['A','ñ','¿','Á'], rtl:false, charBased:false},
    ja:{name:'Japanese · Han + Kana', glyphs:['字','あ','ア','漢'], rtl:false, charBased:true},
    zh:{name:'Chinese · Han', glyphs:['字','文','语','中'], rtl:false, charBased:true},
    ko:{name:'Korean · Hangul', glyphs:['한','글','국','어'], rtl:false, charBased:true},
    th:{name:'Thai', glyphs:['ก','ฎ','ท','๐'], rtl:false, charBased:true},
    lo:{name:'Lao', glyphs:['ກ','ຂ','ງ','ລ'], rtl:false, charBased:true},
    km:{name:'Khmer', glyphs:['ក','ខ','គ','ឃ'], rtl:false, charBased:true},
    my:{name:'Burmese', glyphs:['က','ခ','ဂ','ဃ'], rtl:false, charBased:true},
    ar:{name:'Arabic', glyphs:['ا','ب','ت','ث'], rtl:true, charBased:false},
    he:{name:'Hebrew', glyphs:['א','ב','ג','ד'], rtl:true, charBased:false},
    hi:{name:'Hindi · Devanagari', glyphs:['क','ख','ग','ह'], rtl:false, charBased:false},
    ru:{name:'Russian · Cyrillic', glyphs:['А','Б','В','Я'], rtl:false, charBased:false},
    el:{name:'Greek', glyphs:['Α','Β','Γ','Ω'], rtl:false, charBased:false},
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

  // ---- analysis core, shared between the synchronous fallback and the Worker ----
  // (serialised to plain text so it can also be injected into the Worker; see WORKER_SRC)
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

  // Main-thread fallback — a real function, not generated via eval/Function()
  // (avoids depending on 'unsafe-eval' in the host's CSP; only used if the Worker fails).
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

  // ---- Isolated Worker: counting never blocks the UI thread ----
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
      if (r.reqId !== latestReqId) return; // discard stale responses (user kept typing)
      lastResult = r;
      render(r);
    };
    worker.onerror = (err) => {
      console.error('Analysis worker failed, degrading to main thread:', err.message);
      workerReady = false;
    };
    workerReady = true;
  } catch(err){
    console.warn('Web Worker unavailable, using synchronous calculation on the main thread.', err);
  }
  $('engineLabel').textContent = 'Intl.Segmenter · ' + (workerReady ? 'Worker' : 'main thread');

  // ---- render (always via textContent — never innerHTML with user text) ----
  function setSpecimen(locale, auto){
    const spec = SPECIMENS[locale] || SPECIMENS.en;
    const glyphsBox = $('specimenGlyphs');
    glyphsBox.innerHTML = '';
    spec.glyphs.forEach(g => {
      const span = document.createElement('span');
      span.textContent = g; // static curated glyphs, never derived from user input
      glyphsBox.appendChild(span);
    });
    $('specimenName').textContent = spec.name;
    $('specimenLocale').textContent = (auto ? 'auto \u2192 ' : 'manual \u2192 ') + locale + ' · dir ' + (spec.rtl ? 'rtl' : 'ltr');
    document.getElementById('input').dir = spec.rtl ? 'rtl' : 'auto';
  }

  function fmt(n){ return n.toLocaleString('en-GB'); }

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

  // ---- main loop with debounce ----
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
      warnBanner.textContent = 'Large text (' + fmt(text.length) + ' chars) \u2014 calculation may take a few extra milliseconds.';
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

  // Lazy-load: third-party code only enters the page if the user actually
  // imports that file type (minimal attack surface by default).
  let mammothLoadPromise = null;
  function loadMammoth(){
    if (window.mammoth) return Promise.resolve();
    if (mammothLoadPromise) return mammothLoadPromise;
    mammothLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MAMMOTH_URL; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load the .docx engine (mammoth.js).'));
      document.head.appendChild(s);
    });
    return mammothLoadPromise;
  }

  function withTimeout(promise, ms, label){
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' took longer than ' + (ms/1000) + 's — aborted.')), ms))
    ]);
  }

  // Scans only the ZIP's Central Directory (metadata, no decompression)
  // to detect zip bombs before calling mammoth.extractRawText().
  // Pentest finding: a 50KB .docx can decode to 50MB+ in memory
  // without this guard (mammoth imposes no size limit of its own).
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
    if (eocdOffset === -1) return {risky:false, reason:'no-eocd'}; // mammoth's own parser will reject it

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
        return {risky:true, reason:'zip64 with unbounded size \u2014 unusual for a real .docx'};
      }
      totalUncompressed += uncompSize;
      const ratio = compSize > 0 ? uncompSize / compSize : (uncompSize > 0 ? Infinity : 0);
      if (ratio > MAX_RATIO && uncompSize > 1024 * 1024){
        return {risky:true, reason:'compression ratio ' + ratio.toFixed(0) + ':1 (' + (uncompSize/1024/1024).toFixed(1) + 'MB) \u2014 zip bomb pattern'};
      }
      offset += 46 + nameLen + extraLen + commentLen;
    }
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED){
      return {risky:true, reason:'total uncompressed content ' + (totalUncompressed/1024/1024).toFixed(1) + 'MB exceeds the limit'};
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
    setFileStatus('Loading .docx engine\u2026');
    await loadMammoth();
    setFileStatus('Analysing file structure\u2026');
    const buf = await file.arrayBuffer();
    const risk = checkZipBombRisk(buf);
    if (risk.risky){
      throw new Error('.docx file rejected for security reasons: ' + risk.reason);
    }
    setFileStatus('Extracting text\u2026');
    // extractRawText: document.xml text only \u2014 never processes macros/VBA or embedded OLE objects.
    const res = await withTimeout(window.mammoth.extractRawText({arrayBuffer: buf}), 15000, '.docx extraction');
    input.value = res.value.slice(0, MAX_CHARS);
    setFileStatus('Imported \u2713' + (res.messages && res.messages.length ? ' (with formatting warnings)' : ''));
  }

  async function handlePdf(file){
    setFileStatus('Loading .pdf engine\u2026');
    const pdfjsLib = await loadPdfjs();
    setFileStatus('Extracting text\u2026');
    const buf = await file.arrayBuffer();
    // getDocument + getTextContent: text-extraction layer only. Never loads the
    // viewer/canvas or the embedded JavaScript sandbox (pdf.sandbox.mjs is never imported),
    // so any /JavaScript or /OpenAction in the PDF is never executed (verified by fuzzing).
    const doc = await withTimeout(pdfjsLib.getDocument({data: buf, isEvalSupported: false}).promise, 15000, 'PDF opening');
    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
    const out = [];
    for (let i = 1; i <= pageCount; i++){
      // pentest finding: a hostile Flate content stream can take several
      // seconds to process per page \u2014 each page gets its own timeout.
      const page = await withTimeout(doc.getPage(i), 15000, 'Loading page ' + i);
      const content = await withTimeout(page.getTextContent(), 15000, 'Extracting text from page ' + i);
      out.push(content.items.map(it => it.str).join(' '));
      if (i % 15 === 0) setFileStatus('Extracting text\u2026 page ' + i + '/' + pageCount);
    }
    input.value = out.join('\n\n').slice(0, MAX_CHARS);
    setFileStatus(doc.numPages > MAX_PDF_PAGES
      ? ('Truncated to ' + MAX_PDF_PAGES + ' of ' + doc.numPages + ' pages.')
      : 'Imported \u2713');
  }


  $('btnImport').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const name = file.name.toLowerCase();
    setFileStatus('Reading file\u2026');
    try {
      if (name.endsWith('.txt') || file.type === 'text/plain'){
        if (file.size > MAX_TXT_BYTES) throw new Error('.txt file > 5 MB.');
        input.value = (await file.text()).slice(0, MAX_CHARS);
        setFileStatus('Imported \u2713');
      } else if (name.endsWith('.docx')){
        if (file.size > MAX_DOC_BYTES) throw new Error('.docx file > 20 MB.');
        await handleDocx(file);
      } else if (name.endsWith('.pdf')){
        if (file.size > MAX_DOC_BYTES) throw new Error('.pdf file > 20 MB.');
        await handlePdf(file);
      } else {
        throw new Error('Unsupported format \u2014 use .txt, .docx or .pdf.');
      }
      process();
    } catch(err){
      console.error(err);
      setFileStatus(err.message || 'Error importing the file.', true);
    }
  });

  $('btnCopy').addEventListener('click', async () => {
    if (!lastResult) return;
    const payload = JSON.stringify(lastResult, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      const btn = $('btnCopy'); const orig = btn.textContent;
      btn.textContent = 'Copied \u2713'; setTimeout(() => btn.textContent = orig, 1200);
    } catch(_) { alert('Could not copy to clipboard.'); }
  });

  $('btnDownload').addEventListener('click', () => {
    if (!lastResult) return;
    const r = lastResult;
    const report = [
      'TEXT REPORT', '='.repeat(40),
      'Script/locale: ' + r.locale,
      'Words: ' + r.words,
      'Characters: ' + r.chars,
      'Characters excl. spaces: ' + r.charsNS,
      'Sentences: ' + r.sentences,
      'Paragraphs: ' + r.paras,
      'Unique words: ' + r.unique,
      'Lexical density: ' + r.density + '%',
      'Average word length: ' + r.avgLen,
      'Reading time: ' + r.readMin + ' min',
      'Speaking time: ' + r.speakMin + ' min',
      '', 'Top tokens:',
      ...r.top.map(([w,c]) => '  ' + w + ' — ' + c),
    ].join('\n');
    const blob = new Blob([report], {type:'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'text-report.txt';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

  process();
})();
