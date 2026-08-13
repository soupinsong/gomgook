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
  followup: $('followup'),
  followupInput: $('followup-input'),
  followupSend: $('followup-send'),
  status: $('status'),
  modelBadge: $('model-badge'),
  // 타이틀바
  btnTrigger: $('btn-trigger'),
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
  inTrigger: $('in-trigger'),
  inHotkey: $('in-hotkey'),
  fieldHotkey: $('field-hotkey'),
  inApps: $('in-apps'),
  fieldApps: $('field-apps'),
  appsSkipped: $('apps-skipped'),
  inLevel: $('in-level'),
  btnSave: $('btn-save'),
};

let settings = null;
let currentRequestId = 0;
let currentText = '';
let currentContext = null; // 문장 속 단어 모드일 때 부모 문장
let contextSentence = ''; // 최근에 풀이한 '문장'(문맥 기억용)
let currentAnswerEl = null; // 지금 스트리밍 중인 답변 DOM
let currentAnswerRaw = ''; // 그 답변의 마크다운 버퍼
let isStreaming = false;
let threadActive = false; // 첫 풀이가 한 번이라도 끝났는지

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

// 감지 방식에 따라 타이틀바 버튼·안내문 갱신 (3가지 모드)
function updateTriggerUI(trigger) {
  const hotkey = (settings && settings.hotkey) || 'Ctrl+Shift+Space';
  if (trigger === 'auto') {
    el.btnTrigger.textContent = '📋';
    el.btnTrigger.title = '감지: 아무 앱에서나 복사 (눌러서 다음 모드로)';
    el.emptyState.innerHTML =
      '<p>🌿 어느 앱에서든 <b>복사(Ctrl+C)</b>만 하면</p>' +
      '<p>바로 번역하고 쉽게 풀어 드릴게요.</p>';
  } else if (trigger === 'hotkey') {
    el.btnTrigger.textContent = '⌨';
    el.btnTrigger.title = '감지: 단축키만 (눌러서 다음 모드로)';
    el.emptyState.innerHTML =
      `<p>🌿 텍스트를 <b>복사(Ctrl+C)</b>한 다음</p>` +
      `<p><b>${escapeHtml(hotkey)}</b> 를 눌러 주세요.</p>` +
      `<p style="opacity:.65;font-size:12px;margin-top:12px">다른 앱에서 복사할 땐 조용히 있을게요.</p>`;
  } else {
    // apps
    el.btnTrigger.textContent = '📖';
    el.btnTrigger.title = '감지: 특정 앱에서만 (눌러서 다음 모드로)';
    el.emptyState.innerHTML =
      '<p>🌿 <b>삼성 노트·PDF 리더</b>에서</p>' +
      '<p><b>복사(Ctrl+C)</b>하면 바로 풀어 드릴게요.</p>' +
      '<p style="opacity:.65;font-size:12px;margin-top:12px">카톡·브라우저 등에서 복사할 땐 조용히 있을게요.</p>';
  }
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
// 답변 블록 생성/스트리밍 관리
// ---------------------------------------------------------------------------
function beginAnswerBlock() {
  const div = document.createElement('div');
  div.className = 'answer';
  div.innerHTML = '<span class="cursor"></span>';
  el.result.appendChild(div);
  currentAnswerEl = div;
  currentAnswerRaw = '';
  isStreaming = true;
  el.followupSend.disabled = true;
  el.result.scrollTop = el.result.scrollHeight;
}

function endStreaming(statusText) {
  isStreaming = false;
  el.followupSend.disabled = false;
  setStatus(statusText);
}

// ---------------------------------------------------------------------------
// 조회 시작 (새 선택 → 대화 초기화)
// ---------------------------------------------------------------------------
function startLookup(text, context) {
  if (!text) return;
  currentText = text;
  currentContext = context || null;
  currentRequestId += 1;
  threadActive = false;

  el.emptyState.classList.add('hidden');
  el.imageBox.classList.add('hidden'); // 이전 이미지 감추기
  el.followup.classList.add('hidden'); // 첫 답 끝나면 다시 표시
  el.result.innerHTML = ''; // 대화 스레드 초기화
  renderSource(text, context);
  beginAnswerBlock();
  setStatus(context ? '문맥 풀이 중…' : '풀이 중…');

  window.api.lookup(currentRequestId, text, context);
}

// ---------------------------------------------------------------------------
// 추가 질문 (대화 이어가기)
// ---------------------------------------------------------------------------
function askFollowup() {
  const q = el.followupInput.value.trim();
  if (!q || isStreaming || !threadActive) return;
  currentRequestId += 1;

  // 내 질문 말풍선
  const bubble = document.createElement('div');
  bubble.className = 'q-bubble';
  bubble.textContent = q;
  el.result.appendChild(bubble);

  beginAnswerBlock();
  el.followupInput.value = '';
  setStatus('답하는 중…');

  window.api.ask(currentRequestId, q);
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
  if (requestId !== currentRequestId || !currentAnswerEl) return;
  currentAnswerRaw += delta;
  currentAnswerEl.innerHTML =
    renderMarkdown(currentAnswerRaw) + '<span class="cursor"></span>';
  el.result.scrollTop = el.result.scrollHeight;
});

window.api.onDone(({ requestId }) => {
  if (requestId !== currentRequestId || !currentAnswerEl) return;
  currentAnswerEl.innerHTML = renderMarkdown(currentAnswerRaw);
  threadActive = true;
  el.followup.classList.remove('hidden');
  endStreaming('완료');
  el.followupInput.focus();
  el.result.scrollTop = el.result.scrollHeight;
});

window.api.onError(({ requestId, message }) => {
  if (requestId !== currentRequestId || !currentAnswerEl) return;
  currentAnswerEl.innerHTML = `<p style="color:var(--danger)">⚠ ${escapeHtml(
    message
  )}</p>`;
  // 대화가 이미 진행 중이었다면 추가 질문은 계속 가능하게
  if (threadActive) el.followup.classList.remove('hidden');
  endStreaming('오류');
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

// 단축키로 풀이 요청
window.api.onHotkeyLookup(({ text }) => {
  el.emptyState.classList.add('hidden');
  handleSelection(text);
});
window.api.onHotkeyEmpty(() => {
  setStatus('복사된 텍스트가 없어요 — 먼저 Ctrl+C 로 복사하세요');
});

// 'apps' 모드에서 감지 대상이 아닌 앱에서 복사됨 → 어떤 앱인지 알려줌
window.api.onAppSkipped(({ name }) => {
  if (settings) settings.lastSkippedApp = name || '';
  if (name) {
    setStatus(`${name} 은(는) 감지 대상이 아니에요 (설정에서 추가 가능)`);
  }
  renderSkippedHint();
});

// 설정 열려있을 때 "최근 건너뛴 앱: X [추가]" 표시
function renderSkippedHint() {
  if (!el.appsSkipped) return;
  const name = settings && settings.lastSkippedApp;
  if (!name) {
    el.appsSkipped.textContent = '';
    return;
  }
  el.appsSkipped.innerHTML =
    `최근 건너뛴 앱: <b>${escapeHtml(name)}</b> · <a id="add-skipped">목록에 추가</a>`;
  const a = document.getElementById('add-skipped');
  if (a)
    a.addEventListener('click', () => {
      const cur = el.inApps.value.trim();
      const item = name.toLowerCase();
      const list = cur ? cur.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (!list.map((s) => s.toLowerCase()).includes(item)) list.push(item);
      el.inApps.value = list.join(', ');
      el.appsSkipped.textContent = `추가됨: ${name} (저장을 눌러 적용)`;
    });
}

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
el.followupSend.addEventListener('click', askFollowup);
el.followupInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    askFollowup();
  }
});
el.btnClose.addEventListener('click', () => window.api.close());
el.btnMin.addEventListener('click', () => window.api.minimize());
el.btnPin.addEventListener('click', async () => {
  const pinned = await window.api.togglePin();
  el.btnPin.classList.toggle('pin-off', !pinned);
  el.btnPin.title = pinned ? '항상 위 고정: 켜짐' : '항상 위 고정: 꺼짐';
});
el.btnTrigger.addEventListener('click', async () => {
  const trigger = await window.api.toggleTrigger();
  if (settings) settings.trigger = trigger;
  updateTriggerUI(trigger);
  setStatus(trigger === 'auto' ? '복사 자동 감지 켜짐' : '단축키 모드 (조용함)');
});

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------
function syncProviderBlocks() {
  const isGemini = el.inProvider.value === 'gemini';
  el.blockGemini.classList.toggle('hidden', !isGemini);
  el.blockClaude.classList.toggle('hidden', isGemini);
}

function syncTriggerFields() {
  const t = el.inTrigger.value;
  el.fieldHotkey.classList.toggle('hidden', t !== 'hotkey');
  el.fieldApps.classList.toggle('hidden', t !== 'apps');
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
  el.inTrigger.value = settings.trigger;
  el.inHotkey.value = settings.hotkey || 'Ctrl+Shift+Space';
  el.inApps.value = (settings.apps || []).join(', ');
  syncTriggerFields();
  renderSkippedHint();
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
el.inTrigger.addEventListener('change', syncTriggerFields);

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
    trigger: el.inTrigger.value,
    hotkey: el.inHotkey.value.trim() || 'Ctrl+Shift+Space',
    apps: el.inApps.value
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  });
  el.modelBadge.textContent = settings.activeModel;
  updateTriggerUI(settings.trigger);
  el.panel.classList.add('hidden');
  setStatus('설정 저장됨');
});

// ---------------------------------------------------------------------------
// 초기화
// ---------------------------------------------------------------------------
(async function init() {
  settings = await window.api.getSettings();
  el.modelBadge.textContent = settings.activeModel;
  updateTriggerUI(settings.trigger);
  const hasKey =
    settings.provider === 'gemini'
      ? settings.gemini.apiKey || settings.hasEnvGemini
      : settings.claude.apiKey || settings.hasEnvClaude;
  if (!hasKey) {
    setStatus('API 키 필요 — 설정(⚙)에서 입력');
    openSettings();
  }
})();
