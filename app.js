'use strict';

// ── PDF.js worker ──────────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── Stop words ─────────────────────────────────────────────────────────────
const STOP_EN = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'is','are','was','were','be','been','being','have','has','had','do','does',
  'did','will','would','could','should','may','might','must','shall','can',
  'this','that','these','those','it','its','i','we','you','he','she','they',
  'my','your','his','her','our','their','not','no','so','as','if','from',
  'into','through','during','before','after','above','below','between','out',
  'up','down','about','than','more','also','just','now','then','when','where',
  'which','who','what','how','all','any','both','each','few','most','other',
  'some','such','very','still','even','here','there','us','me','him','her',
]);

const STOP_KO = new Set([
  '이','가','은','는','을','를','의','에','에서','에게','께','로','으로',
  '와','과','이나','나','도','만','까지','부터','한테','께서','이고','이며',
  '이지만','하지만','그러나','그리고','또한','또는','혹은','및','그래서',
  '따라서','그러므로','이렇게','저렇게','이런','저런','그런','이것','저것',
  '그것','이곳','저곳','그곳','이때','그때','모든','각각','여러','어떤',
  '어느','같은','것','수','있다','없다','하다','되다','이다','아니다',
  '있는','없는','하는','되는','라는','라고','이라는','이라고','대한',
  '위한','통해','통한','관한','관련','대해','대하여','따른','따라',
]);

// ── TextRank ───────────────────────────────────────────────────────────────

function cleanText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitSentences(text) {
  // Replace sentence-ending punctuation + whitespace with delimiter
  const delimited = text.replace(/([.!?。？！]+)\s+/g, '$1\n');
  const parts = delimited.split('\n');

  return parts
    .map(s => s.trim())
    .filter(s => {
      if (s.length < 15) return false;
      // Must contain at least one Korean or Latin letter
      return /[가-힣a-zA-Z]/.test(s);
    });
}

function tokenize(sentence) {
  return sentence
    .toLowerCase()
    .replace(/[^\w\s가-힣]/g, ' ')
    .split(/\s+/)
    .filter(w => {
      if (w.length < 2) return false;
      if (STOP_EN.has(w)) return false;
      if (STOP_KO.has(w)) return false;
      // Skip pure numbers
      if (/^\d+$/.test(w)) return false;
      return true;
    });
}

function cosineSim(a, b) {
  if (a.length === 0 || b.length === 0) return 0;

  const freqA = new Map();
  const freqB = new Map();
  for (const w of a) freqA.set(w, (freqA.get(w) ?? 0) + 1);
  for (const w of b) freqB.set(w, (freqB.get(w) ?? 0) + 1);

  let dot = 0, magA = 0, magB = 0;
  for (const [w, c] of freqA) {
    dot  += c * (freqB.get(w) ?? 0);
    magA += c * c;
  }
  for (const [, c] of freqB) magB += c * c;

  return magA > 0 && magB > 0 ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

function pageRank(graph, iterations = 60, d = 0.85) {
  const n = graph.length;

  // Row-normalize (out-edges)
  const norm = graph.map(row => {
    const sum = row.reduce((a, b) => a + b, 0);
    return sum > 0 ? row.map(v => v / sum) : row;
  });

  let scores = new Array(n).fill(1 / n);

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Array(n).fill((1 - d) / n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        next[j] += d * norm[i][j] * scores[i];
      }
    }
    scores = next;
  }

  return scores;
}

/**
 * Run TextRank on text and return top numSentences sentences.
 * Returns { sentences: string[], total: number }
 */
function textRank(rawText, numSentences) {
  const text = cleanText(rawText);
  const sentences = splitSentences(text);

  if (sentences.length === 0) {
    throw new Error(
      '텍스트에서 문장을 추출할 수 없습니다. 스캔된 이미지 기반 PDF는 지원하지 않습니다.'
    );
  }

  if (sentences.length <= numSentences) {
    return { sentences, total: sentences.length };
  }

  const tokens = sentences.map(tokenize);
  const n = sentences.length;

  const graph = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i === j ? 0 : cosineSim(tokens[i], tokens[j])
    )
  );

  const scores = pageRank(graph);

  const selected = scores
    .map((score, idx) => ({ score, idx }))
    .sort((a, b) => b.score - a.score)
    .slice(0, numSentences)
    .sort((a, b) => a.idx - b.idx);   // restore original document order

  return {
    sentences: selected.map(r => sentences[r.idx]),
    total: sentences.length,
  };
}

// ── File extraction ────────────────────────────────────────────────────────

async function extractPDF(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ');
    pages.push(pageText);
  }

  return pages.join('\n\n');
}

async function extractDOCX(file) {
  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
}

// ── DOM references ─────────────────────────────────────────────────────────
const dropZone      = document.getElementById('dropZone');
const fileInput     = document.getElementById('fileInput');
const fileInfo      = document.getElementById('fileInfo');
const fileNameEl    = document.getElementById('fileName');
const fileTypeBadge = document.getElementById('fileTypeBadge');
const removeBtn     = document.getElementById('removeBtn');
const sentenceSlider= document.getElementById('sentenceSlider');
const sentenceCount = document.getElementById('sentenceCount');
const summarizeBtn  = document.getElementById('summarizeBtn');
const resultCard    = document.getElementById('resultCard');
const resultContent = document.getElementById('resultContent');
const resultMetaEl  = document.getElementById('resultMeta');
const loadingEl     = document.getElementById('loading');
const errorCard     = document.getElementById('errorCard');
const errorMsg      = document.getElementById('errorMessage');
const copyBtn       = document.getElementById('copyBtn');

let currentFile = null;

// ── Slider ─────────────────────────────────────────────────────────────────
function updateSlider() {
  const min = +sentenceSlider.min;
  const max = +sentenceSlider.max;
  const val = +sentenceSlider.value;
  const pct = ((val - min) / (max - min)) * 100;
  sentenceSlider.style.setProperty('--fill', `${pct}%`);
  sentenceCount.textContent = val;
  sentenceSlider.setAttribute('aria-valuenow', val);
}

sentenceSlider.addEventListener('input', updateSlider);
updateSlider();

// ── Drag & drop ────────────────────────────────────────────────────────────
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

['dragleave', 'dragend'].forEach(ev =>
  dropZone.addEventListener(ev, () => dropZone.classList.remove('drag-over'))
);

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

fileInput.addEventListener('change', e => {
  if (e.target.files[0]) setFile(e.target.files[0]);
});

// ── File management ────────────────────────────────────────────────────────
function setFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (!['pdf', 'docx'].includes(ext)) {
    showError('PDF 또는 DOCX 파일만 지원합니다.');
    return;
  }

  currentFile = file;
  fileNameEl.textContent = file.name;
  fileTypeBadge.textContent = ext.toUpperCase();
  dropZone.hidden = true;
  fileInfo.hidden = false;
  summarizeBtn.disabled = false;
  hideResult();
  hideError();
}

removeBtn.addEventListener('click', () => {
  currentFile = null;
  fileInput.value = '';
  dropZone.hidden = false;
  fileInfo.hidden = true;
  summarizeBtn.disabled = true;
  hideResult();
  hideError();
});

// ── Summarize ──────────────────────────────────────────────────────────────
summarizeBtn.addEventListener('click', summarize);

async function summarize() {
  if (!currentFile) return;

  showLoading();
  hideResult();
  hideError();

  try {
    let rawText;
    const ext = currentFile.name.split('.').pop().toLowerCase();

    if (ext === 'pdf') {
      rawText = await extractPDF(currentFile);
    } else {
      rawText = await extractDOCX(currentFile);
    }

    if (!rawText || rawText.trim().length < 80) {
      throw new Error(
        '문서에서 텍스트를 추출할 수 없습니다.\n' +
        '스캔된 이미지 기반 PDF는 지원하지 않으며, 텍스트 레이어가 포함된 파일이 필요합니다.'
      );
    }

    const n = +sentenceSlider.value;
    const { sentences, total } = textRank(rawText, n);

    showResult(sentences, total);
  } catch (err) {
    showError(err.message ?? '요약 중 오류가 발생했습니다.');
  } finally {
    hideLoading();
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function showLoading() {
  loadingEl.hidden = false;
  summarizeBtn.disabled = true;
}

function hideLoading() {
  loadingEl.hidden = true;
  if (currentFile) summarizeBtn.disabled = false;
}

function showResult(sentences, total) {
  resultContent.innerHTML = sentences
    .map((s, i) => `
      <div class="result-sentence" style="animation-delay:${i * 60}ms">
        <span class="sentence-num">${i + 1}</span>
        <span class="sentence-text">${escHtml(s)}</span>
      </div>`)
    .join('');

  resultMetaEl.textContent =
    `전체 ${total}개 문장 중 핵심 ${sentences.length}개 추출`;

  resultCard.hidden = false;
}

function hideResult() {
  resultCard.hidden = true;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorCard.hidden = false;
}

function hideError() {
  errorCard.hidden = true;
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Copy ───────────────────────────────────────────────────────────────────
// ── PDF Split ──────────────────────────────────────────────────────────────

const splitDropZone   = document.getElementById('splitDropZone');
const splitFileInput  = document.getElementById('splitFileInput');
const splitFileInfo   = document.getElementById('splitFileInfo');
const splitFileNameEl = document.getElementById('splitFileName');
const splitPageCountEl= document.getElementById('splitPageCount');
const splitRemoveBtn  = document.getElementById('splitRemoveBtn');
const rangePanel      = document.getElementById('rangePanel');
const npagePanel      = document.getElementById('npagePanel');
const rangeInput      = document.getElementById('rangeInput');
const rangePreview    = document.getElementById('rangePreview');
const npageInput      = document.getElementById('npageInput');
const npagePreview    = document.getElementById('npagePreview');
const splitBtn        = document.getElementById('splitBtn');
const splitLoading    = document.getElementById('splitLoading');
const splitErrorCard  = document.getElementById('splitErrorCard');
const splitErrorMsg   = document.getElementById('splitErrorMsg');
const splitResultCard = document.getElementById('splitResultCard');
const splitResultList = document.getElementById('splitResultList');
const splitResultMeta = document.getElementById('splitResultMeta');
const downloadAllBtn  = document.getElementById('downloadAllBtn');

let splitFile       = null;
let splitTotalPages = 0;
let splitParts      = [];   // { bytes, filename, start, end }

// ── Split drag & drop ──────────────────────────────────────────────────────
splitDropZone.addEventListener('dragover', e => {
  e.preventDefault();
  splitDropZone.classList.add('drag-over');
});
['dragleave', 'dragend'].forEach(ev =>
  splitDropZone.addEventListener(ev, () => splitDropZone.classList.remove('drag-over'))
);
splitDropZone.addEventListener('drop', e => {
  e.preventDefault();
  splitDropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) setSplitFile(file);
});
splitDropZone.addEventListener('click', () => splitFileInput.click());
splitDropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); splitFileInput.click(); }
});
splitFileInput.addEventListener('change', e => {
  if (e.target.files[0]) setSplitFile(e.target.files[0]);
});

splitRemoveBtn.addEventListener('click', () => {
  splitFile       = null;
  splitTotalPages = 0;
  splitParts      = [];
  splitFileInput.value = '';
  splitDropZone.hidden = false;
  splitFileInfo.hidden = true;
  splitBtn.disabled    = true;
  hideSplitResult();
  hideSplitError();
  rangePreview.textContent = '각 범위가 별도 PDF 파일이 됩니다 · 쉼표로 구분';
  rangePreview.className   = 'input-hint';
  npagePreview.textContent = '파일을 먼저 업로드해 주세요';
});

async function setSplitFile(file) {
  if (file.name.split('.').pop().toLowerCase() !== 'pdf') {
    showSplitError('PDF 파일만 지원합니다.');
    return;
  }

  splitFile = file;
  splitFileNameEl.textContent = file.name;
  splitDropZone.hidden = true;
  splitFileInfo.hidden = false;
  splitPageCountEl.textContent = '페이지 계산 중…';
  hideSplitResult();
  hideSplitError();

  try {
    const buffer = await file.arrayBuffer();
    const doc    = await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: true });
    splitTotalPages = doc.getPageCount();
    splitPageCountEl.textContent = `${splitTotalPages}페이지`;
    splitBtn.disabled = false;
    updateNpagePreview();
  } catch {
    showSplitError('PDF를 읽을 수 없습니다. 파일이 손상되었거나 암호화된 PDF입니다.');
    splitDropZone.hidden = false;
    splitFileInfo.hidden = true;
    splitFile = null;
  }
}

// ── Method switch ──────────────────────────────────────────────────────────
document.querySelectorAll('input[name="splitMethod"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const isRange = radio.value === 'range';
    rangePanel.hidden  = !isRange;
    npagePanel.hidden  = isRange;
    if (!isRange) updateNpagePreview();
  });
});

// ── Range input preview ────────────────────────────────────────────────────
rangeInput.addEventListener('input', updateRangePreview);

function updateRangePreview() {
  if (!rangeInput.value.trim()) {
    rangePreview.textContent = '각 범위가 별도 PDF 파일이 됩니다 · 쉼표로 구분';
    rangePreview.className   = 'input-hint';
    return;
  }
  try {
    const ranges = parseRanges(rangeInput.value, splitTotalPages || 9999);
    const parts  = ranges.map(([s, e]) => s === e ? `${s}p` : `${s}~${e}p`).join(', ');
    rangePreview.textContent = `파일 ${ranges.length}개 생성 예정 (${parts})`;
    rangePreview.className   = 'input-hint valid';
  } catch (err) {
    rangePreview.textContent = err.message;
    rangePreview.className   = 'input-hint invalid';
  }
}

// ── N-page preview ─────────────────────────────────────────────────────────
npageInput.addEventListener('input', updateNpagePreview);

function updateNpagePreview() {
  const n = parseInt(npageInput.value, 10);
  if (!splitTotalPages || isNaN(n) || n < 1) {
    npagePreview.textContent = '파일을 먼저 업로드해 주세요';
    npagePreview.className   = 'input-hint';
    return;
  }
  const ranges  = buildNPageRanges(n, splitTotalPages);
  const preview = ranges.slice(0, 3).map(([s, e]) => `${s}~${e}p`).join(', ');
  const more    = ranges.length > 3 ? ` … 등 총 ${ranges.length}개` : `(총 ${ranges.length}개)`;
  npagePreview.textContent = `${preview}${more}`;
  npagePreview.className   = 'input-hint valid';
}

// ── Range parsing ──────────────────────────────────────────────────────────
function parseRanges(input, total) {
  const parts = input.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('범위를 입력해 주세요.');

  return parts.map(part => {
    const m = part.match(/^(\d+)(?:[–\-](\d+))?$/);
    if (!m) throw new Error(`잘못된 형식: "${part}" (예: 1-3)`);
    const s = parseInt(m[1], 10);
    const e = m[2] ? parseInt(m[2], 10) : s;
    if (s < 1)      throw new Error(`페이지 번호는 1 이상이어야 합니다 (입력: ${s})`);
    if (e > total)  throw new Error(`페이지 ${e}는 전체 ${total}페이지를 초과합니다`);
    if (s > e)      throw new Error(`시작(${s})이 끝(${e})보다 클 수 없습니다`);
    return [s, e];
  });
}

function buildNPageRanges(n, total) {
  const ranges = [];
  for (let s = 1; s <= total; s += n) {
    ranges.push([s, Math.min(s + n - 1, total)]);
  }
  return ranges;
}

// ── Split execution ────────────────────────────────────────────────────────
splitBtn.addEventListener('click', runSplit);

async function runSplit() {
  if (!splitFile) return;

  const method = document.querySelector('input[name="splitMethod"]:checked').value;
  let ranges;

  try {
    if (method === 'range') {
      ranges = parseRanges(rangeInput.value, splitTotalPages);
    } else {
      const n = parseInt(npageInput.value, 10);
      if (isNaN(n) || n < 1) throw new Error('1 이상의 숫자를 입력해 주세요.');
      ranges = buildNPageRanges(n, splitTotalPages);
    }
  } catch (err) {
    showSplitError(err.message);
    return;
  }

  showSplitLoading();
  hideSplitResult();
  hideSplitError();

  try {
    const buffer  = await splitFile.arrayBuffer();
    const srcDoc  = await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: true });
    const baseName = splitFile.name.replace(/\.pdf$/i, '');

    splitParts = [];
    for (let i = 0; i < ranges.length; i++) {
      const [s, e]  = ranges[i];
      const newDoc  = await PDFLib.PDFDocument.create();
      const indices = Array.from({ length: e - s + 1 }, (_, k) => s - 1 + k);
      const copied  = await newDoc.copyPages(srcDoc, indices);
      copied.forEach(p => newDoc.addPage(p));
      const bytes   = await newDoc.save();
      const pad     = String(i + 1).padStart(2, '0');
      splitParts.push({ bytes, filename: `${baseName}_part${pad}.pdf`, start: s, end: e });
    }

    showSplitResult(splitParts, splitTotalPages);
  } catch (err) {
    showSplitError(err.message || 'PDF 분할 중 오류가 발생했습니다.');
  } finally {
    hideSplitLoading();
  }
}

// ── Split UI helpers ───────────────────────────────────────────────────────
function showSplitLoading() {
  splitLoading.hidden = true;
  // brief delay so DOM can repaint before heavy computation
  splitLoading.hidden = false;
  splitBtn.disabled   = true;
}

function hideSplitLoading() {
  splitLoading.hidden = true;
  if (splitFile) splitBtn.disabled = false;
}

function showSplitResult(parts, total) {
  splitResultMeta.textContent = `총 ${total}페이지 → ${parts.length}개 파일`;

  splitResultList.innerHTML = parts
    .map((p, i) => {
      const pageLabel = p.start === p.end ? `${p.start}페이지` : `${p.start} ~ ${p.end}페이지`;
      const kb        = (p.bytes.byteLength / 1024).toFixed(0);
      return `
        <div class="split-item" style="animation-delay:${i * 50}ms">
          <div class="split-item-icon">PDF</div>
          <div class="split-item-info">
            <div class="split-item-name">${escHtml(p.filename)}</div>
            <div class="split-item-pages">${pageLabel} · ${kb} KB</div>
          </div>
          <button class="download-btn" data-index="${i}" aria-label="${escHtml(p.filename)} 다운로드">
            <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M2 11v1.5A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            다운로드
          </button>
        </div>`;
    })
    .join('');

  splitResultList.querySelectorAll('.download-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const part = splitParts[+btn.dataset.index];
      downloadBlob(new Blob([part.bytes], { type: 'application/pdf' }), part.filename);
    });
  });

  splitResultCard.hidden = false;
}

function hideSplitResult()  { splitResultCard.hidden = true; }
function showSplitError(msg){ splitErrorMsg.textContent = msg; splitErrorCard.hidden = false; }
function hideSplitError()   { splitErrorCard.hidden = true; }

// ── Download all as ZIP ────────────────────────────────────────────────────
downloadAllBtn.addEventListener('click', async () => {
  if (!splitParts.length) return;
  downloadAllBtn.textContent = '압축 중…';
  downloadAllBtn.disabled    = true;
  try {
    const zip = new JSZip();
    splitParts.forEach(p => zip.file(p.filename, p.bytes));
    const blob     = await zip.generateAsync({ type: 'blob' });
    const baseName = splitFile?.name.replace(/\.pdf$/i, '') ?? 'document';
    downloadBlob(blob, `${baseName}_split.zip`);
  } finally {
    downloadAllBtn.innerHTML = `
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 11v1.5A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      전체 ZIP`;
    downloadAllBtn.disabled = false;
  }
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Copy ───────────────────────────────────────────────────────────────────
copyBtn.addEventListener('click', async () => {
  const sentences = [...resultContent.querySelectorAll('.sentence-text')]
    .map(el => el.textContent)
    .join('\n\n');

  try {
    await navigator.clipboard.writeText(sentences);
    copyBtn.classList.add('copied');
    copyBtn.innerHTML = `
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <polyline points="3,8 6.5,12 13,5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      복사됨`;
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.innerHTML = `
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
          <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" stroke-width="1.4"/>
        </svg>
        복사`;
    }, 2000);
  } catch {
    // Clipboard API not available (HTTP or iframe)
    showError('클립보드 복사가 지원되지 않는 환경입니다. 텍스트를 직접 선택하여 복사해 주세요.');
  }
});
