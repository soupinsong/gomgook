'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  sourceBox: $('source-box'),
  sourceText: $('source-text'),
  btnLookup: $('btn-lookup'),
  imageBox: $('image-box'),
  imageImg: $('image-img'),
  imageCap: $('image-cap'),
  result: $('result'),
  emptyState: $('empty-state'),
  status: $('status'),
  modelBadge: $('model-badge'),
  // 타이틀바
  btnPin: $('btn-pin'),
  btnSettings: $('btn-settings'),
  btnMin: $('btn-min'),
  btnClose: $('btn-close'),
  // 설정
  panel: $('settings-panel'),
  btnSettingsClose: $('btn-settings-close'),
  inProvider: $('in-provider'),
  blockGemini: $('block-gemini'),
  blockClaude: $('block-claude'),
  inGeminiKey: $('in-gemini-key'),
  inGeminiModel: $('in-gemini-model'),
  btnRefreshModels: $('btn-refresh-models'),
  modelsHint: $('models-hint'),
  inClaudeKey: $('in-claude-key'),
  inClaudeModel: $('in-claude-model'),
  envHintGemini: $('env-hint-gemini'),
  envHintClaude: $('env-hint-claude'),
  inLevel: $('in-level'),
  inAuto: $('in-auto'),
  btnSave: $('btn-save'),
};

let settings = null;
let currentRequestId = 0;
let currentText = '';
let currentContext = null; // 문장 속 단어 모드일 때 부모 문장
let contextSentence = ''; // 최근에 풀이한 '문장'(문맥 기억용)
let rawBuffer = '';

// ---------------------------------------------------------------------------
// 아주 작은 마크다운 → HTML (## 제목, - 목록, **굵게**, `코드`)
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inline(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>');
}

function renderMarkdown(md) {
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('## ')) {
      closeList();
      html += `<h2>${inline(t.slice(3))}</h2>`;
    } else if (t.startsWith('# ')) {
      closeList();
      html += `<h2>${inline(t.slice(2))}</h2>`;
    } else if (t.startsWith('- ') || t.startsWith('* ')) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${inline(t.slice(2))}</li>`;
    } else if (t === '') {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(t)}</p>`;
    }
  }
  closeList();
  return html;
}

function setStatus(text) {
  el.status.textContent = text;
}

// ---------------------------------------------------------------------------
// 원문 박스 표시
// ---------------------------------------------------------------------------
function renderSource(text, context) {
  el.sourceBox.classList.remove('hidden');
  if (context) {
    el.sourceText.innerHTML =
      `<span class="src-word">${escapeHtml(text)}</span>` +
      `<span class="src-note"> — 이 문장 속 뜻</span>` +
      `<div class="src-ctx">"${escapeHtml(context)}"</div>`;
  } else {
    el.sourceText.textContent = text;
  }
}

// ---------------------------------------------------------------------------
// 조회 시작
// ---------------------------------------------------------------------------
function startLookup(text, context) {
  if (!text) return;
  currentText = text;
  currentContext = context || null;
  currentRequestId += 1;
  rawBuffer = '';

  el.emptyState.classList.add('hidden');
  el.imageBox.classList.add('hidden'); // 이전 이미지 감추기
  renderSource(text, context);
  el.result.innerHTML = '<span class="cursor"></span>';
  setStatus(context ? '문맥 풀이 중…' : '풀이 중…');

  window.api.lookup(currentRequestId, text, context);
}

// 선택 텍스트를 보고 '문장 모드' vs '문장 속 단어 모드' 결정
function handleSelection(text) {
  const wc = text.trim().split(/\s+/).filter(Boolean).length;

  // 최근 문장 안의 짧은 조각을 다시 고른 경우 → 문맥 단어 모드
  if (
    contextSentence &&
    wc <= 3 &&
    text !== contextSentence &&
    contextSentence.includes(text)
  ) {
    startLookup(text, contextSentence);
    return;
  }

  // 일반 모드. 문장급(4단어+)이면 문맥으로 기억.
  if (wc >= 4) {
    contextSentence = text;
  }
  startLookup(text, null);
}

// ---------------------------------------------------------------------------
// 스트리밍 수신
// ---------------------------------------------------------------------------
window.api.onChunk(({ requestId, delta }) => {
  if (requestId !== currentRequestId) return;
  rawBuffer += delta;
  el.result.innerHTML = renderMarkdown(rawBuffer) + '<span class="cursor"></span>';
  el.result.scrollTop = el.result.scrollHeight;
});

window.api.onDone(({ requestId }) => {
  if (requestId !== currentRequestId) return;
  el.result.innerHTML = renderMarkdown(rawBuffer);
  setStatus('완료');
});

window.api.onError(({ requestId, message }) => {
  if (requestId !== currentRequestId) return;
  el.result.innerHTML = `<p style="color:var(--danger)">⚠ ${escapeHtml(
    message
  )}</p>`;
  setStatus('오류');
});

// ---------------------------------------------------------------------------
// 클립보드 감지
// ---------------------------------------------------------------------------
window.api.onClipboard(({ text, autoLookup }) => {
  el.emptyState.classList.add('hidden');
  if (autoLookup) {
    handleSelection(text);
  } else {
    currentText = text;
    renderSource(text, null);
    setStatus('복사됨 — “다시 풀이”를 누르세요');
  }
});

// 예시 이미지 수신
window.api.onImage(({ requestId, dataUrl, title, pageUrl }) => {
  if (requestId !== currentRequestId) return;
  el.imageImg.src = dataUrl;
  el.imageCap.innerHTML = `출처: 위키백과 · <a id="img-link">${escapeHtml(
    title
  )}</a>`;
  const link = document.getElementById('img-link');
  if (link) link.addEventListener('click', () => window.api.openExternal(pageUrl));
  el.imageBox.classList.remove('hidden');
});

// ---------------------------------------------------------------------------
// 버튼
// ---------------------------------------------------------------------------
el.btnLookup.addEventListener('click', () => handleSelection(currentText));
el.btnClose.addEventListener('click', () => window.api.close());
el.btnMin.addEventListener('click', () => window.api.minimize());
el.btnPin.addEventListener('click', async () => {
  const pinned = await window.api.togglePin();
  el.btnPin.classList.toggle('pin-off', !pinned);
  el.btnPin.title = pinned ? '항상 위 고정: 켜짐' : '항상 위 고정: 꺼짐';
});

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------
function syncProviderBlocks() {
  const isGemini = el.inProvider.value === 'gemini';
  el.blockGemini.classList.toggle('hidden', !isGemini);
  el.blockClaude.classList.toggle('hidden', isGemini);
}

// 내 키로 실제 사용 가능한 Gemini 모델을 불러와 드롭다운 채우기
async function refreshGeminiModels() {
  el.modelsHint.textContent = '불러오는 중…';
  const r = await window.api.listGeminiModels();
  if (!r.ok) {
    el.modelsHint.textContent = r.error || '불러오기 실패';
    return;
  }
  if (!r.models.length) {
    el.modelsHint.textContent = '사용 가능한 모델을 찾지 못했어요.';
    return;
  }
  const cur = el.inGeminiModel.value || settings.gemini.model;
  const ids = r.models.map((m) => m.id);
  el.inGeminiModel.innerHTML = '';
  for (const m of r.models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.label} (${m.id})`;
    el.inGeminiModel.appendChild(opt);
  }
  el.inGeminiModel.value = ids.includes(cur) ? cur : ids[0];
  el.modelsHint.textContent = `${r.models.length}개 사용 가능`;
}

function openSettings() {
  el.inProvider.value = settings.provider;
  el.inGeminiKey.value = settings.gemini.apiKey || '';
  el.inGeminiModel.value = settings.gemini.model;
  el.inClaudeKey.value = settings.claude.apiKey || '';
  el.inClaudeModel.value = settings.claude.model;
  el.inLevel.value = settings.level;
  el.inAuto.checked = settings.autoLookup;
  el.envHintGemini.textContent = settings.hasEnvGemini
    ? '환경변수 GEMINI_API_KEY 감지됨 (비워두면 이 값 사용)'
    : '';
  el.envHintClaude.textContent = settings.hasEnvClaude
    ? '환경변수 ANTHROPIC_API_KEY 감지됨 (비워두면 이 값 사용)'
    : '';
  syncProviderBlocks();
  el.modelsHint.textContent = '';
  el.panel.classList.remove('hidden');
  // Gemini + 키가 있으면 실제 사용 가능한 모델을 자동으로 불러옴
  if (settings.provider === 'gemini' && (settings.gemini.apiKey || settings.hasEnvGemini)) {
    refreshGeminiModels();
  }
}

el.inProvider.addEventListener('change', () => {
  syncProviderBlocks();
  if (el.inProvider.value === 'gemini') refreshGeminiModels();
});
el.btnRefreshModels.addEventListener('click', refreshGeminiModels);

// 모델이 막혀 자동 교체되면 배지·상태 갱신
window.api.onModelChanged(({ model }) => {
  if (settings) {
    settings.gemini.model = model;
    settings.activeModel = model;
  }
  el.modelBadge.textContent = model;
  setStatus(`모델을 ${model} 로 자동 변경했어요`);
});
el.btnSettings.addEventListener('click', openSettings);
el.btnSettingsClose.addEventListener('click', () =>
  el.panel.classList.add('hidden')
);

el.btnSave.addEventListener('click', async () => {
  settings = await window.api.saveSettings({
    provider: el.inProvider.value,
    gemini: {
      apiKey: el.inGeminiKey.value.trim(),
      model: el.inGeminiModel.value,
    },
    claude: {
      apiKey: el.inClaudeKey.value.trim(),
      model: el.inClaudeModel.value,
    },
    level: el.inLevel.value.trim() || '고등학교 1학년',
    autoLookup: el.inAuto.checked,
  });
  el.modelBadge.textContent = settings.activeModel;
  el.panel.classList.add('hidden');
  setStatus('설정 저장됨');
});

// ---------------------------------------------------------------------------
// 초기화
// ---------------------------------------------------------------------------
(async function init() {
  settings = await window.api.getSettings();
  el.modelBadge.textContent = settings.activeModel;
  const hasKey =
    settings.provider === 'gemini'
      ? settings.gemini.apiKey || settings.hasEnvGemini
      : settings.claude.apiKey || settings.hasEnvClaude;
  if (!hasKey) {
    setStatus('API 키 필요 — 설정(⚙)에서 입력');
    openSettings();
  }
})();
