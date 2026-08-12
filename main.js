'use strict';

const { app, BrowserWindow, ipcMain, clipboard, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

// ---------------------------------------------------------------------------
// 설정 저장/로드 (userData/config.json)
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

const DEFAULT_SETTINGS = {
  // 'gemini' = 무료(구글), 'claude' = 유료(Anthropic). 설정에서 언제든 토글.
  provider: 'gemini',
  gemini: {
    apiKey: '',
    // 별칭(항상 현재 flash를 가리킴). 막혀 있으면 앱이 자동으로 사용 가능한 모델로 교체.
    model: 'gemini-flash-latest',
  },
  claude: {
    apiKey: '',
    model: 'claude-sonnet-4-6',
  },
  level: '고등학교 1학년',
  domains: ['생물학', '정보학(생물정보학)', '유전체학'],
  autoLookup: true,
  minChars: 2,
  maxChars: 4000,
};

// 서비스 종료된 Gemini 모델 → 자동 교체 (저장돼 있던 옛 설정 구제용)
const RETIRED_GEMINI = new Set([
  'gemini-2.0-flash',
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-pro',
]);

// 중첩 객체(gemini/claude)까지 안전하게 병합
function mergeSettings(base, override) {
  const out = { ...base, ...override };
  out.gemini = { ...base.gemini, ...(override.gemini || {}) };
  out.claude = { ...base.claude, ...(override.claude || {}) };
  if (RETIRED_GEMINI.has(out.gemini.model)) {
    out.gemini.model = base.gemini.model; // 최신 기본 모델로 교체
  }
  return out;
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw));
  } catch {
    return mergeSettings(DEFAULT_SETTINGS, {});
  }
}

function saveSettings(next) {
  const merged = mergeSettings(loadSettings(), next);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

let settings = loadSettings();

function resolveKey(provider) {
  if (provider === 'gemini') {
    return settings.gemini.apiKey || process.env.GEMINI_API_KEY || '';
  }
  return settings.claude.apiKey || process.env.ANTHROPIC_API_KEY || '';
}

function currentModel() {
  return settings.provider === 'gemini'
    ? settings.gemini.model
    : settings.claude.model;
}

// ---------------------------------------------------------------------------
// 윈도우
// ---------------------------------------------------------------------------
let win = null;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 380;
  const height = 620;

  win = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    minWidth: 300,
    minHeight: 360,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#1c1f26',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('closed', () => {
    win = null;
  });
}

// ---------------------------------------------------------------------------
// 클립보드 감시
// ---------------------------------------------------------------------------
let lastClipboard = clipboard.readText();
let clipboardTimer = null;

function startClipboardWatch() {
  clipboardTimer = setInterval(() => {
    if (!win) return;
    let text = '';
    try {
      text = clipboard.readText();
    } catch {
      return;
    }
    if (text && text !== lastClipboard) {
      lastClipboard = text;
      const trimmed = text.trim();
      if (trimmed.length >= settings.minChars) {
        win.webContents.send('clipboard-change', {
          text: trimmed.slice(0, settings.maxChars),
          autoLookup: settings.autoLookup,
        });
      }
    }
  }, 400);
}

// ---------------------------------------------------------------------------
// 프롬프트
// ---------------------------------------------------------------------------
function buildSystemPrompt() {
  const domains = settings.domains.join(', ');
  return [
    `너는 "딸깍 사전"이야. 사용자는 ${domains} 분야의 논문(주로 영어)을 읽는 학생이고,`,
    `너는 사용자가 드래그해서 복사한 텍스트 조각(단어·구·문장·문단)을 받아 한국어로 풀어 설명해.`,
    ``,
    `항상 아래 순서의 한국어 마크다운으로만 답해. 잡담·인사·서론 없이 바로 시작해:`,
    ``,
    `## 번역`,
    `- 자연스러운 한국어 번역. 이미 한국어면 핵심을 한 줄로 다시 정리.`,
    ``,
    `## 핵심 용어`,
    `- 전문용어마다 "용어 — 이 문맥에서의 뜻 / ${settings.level} 눈높이의 쉬운 설명(비유 활용)" 형식.`,
    `- 이 조각에서 실제로 중요한 용어만 골라. 최대 4~5개.`,
    ``,
    `## 한 줄 정리`,
    `- 이 조각이 결국 무슨 말인지 한 문장으로.`,
    ``,
    `규칙:`,
    `- 설명은 ${settings.level} 수준의 쉬운 말과 비유로. 어려운 말을 또 어려운 말로 풀지 마.`,
    `- 문맥(생물학/정보학/유전체학 중 어디에 가까운지)을 파악해서 그 분야에서의 의미로 설명해.`,
    `- 같은 단어라도 이 분야에서 특수하게 쓰이면 그 쓰임을 알려줘 (예: "expression"=발현).`,
    `- 짧고 밀도 있게. 불필요한 반복 금지.`,
  ].join('\n');
}

function userMessage(text) {
  return `다음 텍스트를 풀어서 설명해줘:\n\n"""${text}"""`;
}

// 문장 안의 특정 단어/구를 "그 문맥에서" 풀이하는 모드
function buildWordSystemPrompt() {
  return [
    `너는 "딸깍 사전"이야. 사용자는 방금 어떤 문장을 보고, 그 안의 특정 단어(또는 구)를 다시 골랐어.`,
    `그 단어가 "이 문장 안에서" 어떤 뜻으로 쓰였는지 콕 집어 설명해. 문장 전체를 다시 번역하지는 마.`,
    ``,
    `아래 순서의 한국어 마크다운으로만, 서론 없이 바로 답해:`,
    ``,
    `## 이 문맥에서의 뜻`,
    `- 이 문장에서 고른 단어가 가리키는 정확한 의미를 한두 줄로.`,
    ``,
    `## 쉬운 풀이`,
    `- ${settings.level} 눈높이의 비유로 풀어서.`,
    ``,
    `## 참고`,
    `- 다른 분야나 일상에서 쓰일 때의 뜻과 어떻게 다른지 (있을 때만, 없으면 생략).`,
    ``,
    `규칙: 짧고 밀도 있게. 고른 단어에만 집중.`,
  ].join('\n');
}

function userMessageWord(word, sentence) {
  return [
    `문장: """${sentence}"""`,
    ``,
    `이 문장 안에서 다음 부분이 어떤 뜻으로 쓰였는지 설명해줘: «${word}»`,
  ].join('\n');
}

function wordCount(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// 예시 이미지 (위키백과 썸네일 → data URL). 키 불필요, 실패해도 조용히 무시.
// ---------------------------------------------------------------------------
async function wikiThumb(lang, term) {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json` +
    `&prop=pageimages&piprop=thumbnail&pithumbsize=320&redirects=1` +
    `&titles=${encodeURIComponent(term)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'TtalkakDict/0.1 (personal study tool)' },
  });
  if (!res.ok) return null;
  const json = await res.json();
  const pages = (json && json.query && json.query.pages) || {};
  for (const key of Object.keys(pages)) {
    const p = pages[key];
    if (p && p.thumbnail && p.thumbnail.source) {
      return { thumb: p.thumbnail.source, title: p.title, lang };
    }
  }
  return null;
}

async function toDataUrl(imgUrl) {
  const res = await fetch(imgUrl, {
    headers: { 'User-Agent': 'TtalkakDict/0.1 (personal study tool)' },
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || 'image/jpeg';
  if (buf.byteLength > 900 * 1024) return null; // 너무 크면 skip
  return `data:${ct};base64,${buf.toString('base64')}`;
}

async function fetchWikiImage(term) {
  try {
    let hit = await wikiThumb('ko', term);
    if (!hit) hit = await wikiThumb('en', term);
    if (!hit) return null;
    const dataUrl = await toDataUrl(hit.thumb);
    if (!dataUrl) return null;
    return {
      dataUrl,
      title: hit.title,
      pageUrl: `https://${hit.lang}.wikipedia.org/wiki/${encodeURIComponent(
        hit.title
      )}`,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gemini: 이 키로 실제 사용 가능한 모델 목록
// ---------------------------------------------------------------------------
async function fetchGeminiModelList(key) {
  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      { headers: { 'x-goog-api-key': key } }
    );
    if (!res.ok) {
      let msg = `모델 목록 오류 (${res.status})`;
      try {
        const j = JSON.parse(await res.text());
        if (j && j.error && j.error.message) msg = j.error.message;
      } catch {
        /* keep default */
      }
      return { ok: false, error: msg, models: [] };
    }
    const json = await res.json();
    const rank = (id) =>
      id.includes('flash-lite') ? 0 : id.includes('flash') ? 1 : id.includes('pro') ? 2 : 3;
    const models = (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => {
        const id = String(m.name || '').replace(/^models\//, '');
        return { id, label: m.displayName || id };
      })
      .filter((m) => m.id.startsWith('gemini') && !/embedding|aqa|image|tts/i.test(m.id))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    return { ok: true, models };
  } catch {
    return { ok: false, error: '네트워크 연결을 확인해 주세요.', models: [] };
  }
}

function isModelUnavailable(status, rawMsg) {
  return (
    status === 404 ||
    /no longer available|not available|not found|update your code|is not supported/i.test(
      rawMsg || ''
    )
  );
}

// ---------------------------------------------------------------------------
// Gemini (무료) 스트리밍
// ---------------------------------------------------------------------------
async function runGeminiLookup(event, requestId, apiKey, systemPrompt, userText, retried) {
  const model = settings.gemini.model;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

  const generationConfig = { maxOutputTokens: 2000, temperature: 0.3 };
  // 2.5 계열은 기본으로 '생각'을 해서 느려질 수 있어 딸깍 속도용으로 끔
  if (model.includes('2.5')) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig,
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
    });
  } catch {
    event.sender.send('lookup-error', {
      requestId,
      message: '네트워크 연결을 확인해 주세요.',
    });
    return;
  }

  if (!res.ok) {
    let raw = '';
    try {
      raw = JSON.parse(await res.text())?.error?.message || '';
    } catch {
      /* ignore */
    }

    // 모델이 막혀 있으면 → 사용 가능한 모델로 자동 교체 후 1회 재시도
    if (!retried && isModelUnavailable(res.status, raw)) {
      const list = await fetchGeminiModelList(apiKey);
      const best = list.ok && list.models[0] ? list.models[0].id : null;
      if (best && best !== model) {
        settings = saveSettings({
          gemini: { ...settings.gemini, model: best },
        });
        event.sender.send('model-changed', { model: best });
        return runGeminiLookup(event, requestId, apiKey, systemPrompt, userText, true);
      }
    }

    let message = `Gemini 오류 (${res.status})`;
    if (res.status === 400 && /api key/i.test(raw)) {
      message = 'Gemini API 키가 올바르지 않습니다. 설정에서 확인해 주세요.';
    } else if (res.status === 429) {
      message = '무료 할당량을 잠시 초과했어요. 잠깐 뒤 다시 시도해 주세요.';
    } else if (raw) {
      message = raw;
    }
    event.sender.send('lookup-error', { requestId, message });
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const json = JSON.parse(data);
          const parts = json?.candidates?.[0]?.content?.parts || [];
          const delta = parts.map((p) => p.text || '').join('');
          if (delta) event.sender.send('lookup-chunk', { requestId, delta });
        } catch {
          /* 부분 JSON 무시 */
        }
      }
    }
    event.sender.send('lookup-done', { requestId });
  } catch {
    event.sender.send('lookup-error', {
      requestId,
      message: '응답을 받는 중 문제가 생겼어요. 다시 시도해 주세요.',
    });
  }
}

// ---------------------------------------------------------------------------
// Claude (유료) 스트리밍
// ---------------------------------------------------------------------------
async function runClaudeLookup(event, requestId, apiKey, systemPrompt, userText) {
  const client = new Anthropic({ apiKey });
  try {
    const stream = client.messages.stream({
      model: settings.claude.model,
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    });

    stream.on('text', (delta) => {
      event.sender.send('lookup-chunk', { requestId, delta });
    });

    await stream.finalMessage();
    event.sender.send('lookup-done', { requestId });
  } catch (err) {
    let message = err && err.message ? err.message : String(err);
    if (err instanceof Anthropic.AuthenticationError) {
      message = 'Claude API 키가 올바르지 않습니다. 설정에서 확인해 주세요.';
    } else if (err instanceof Anthropic.RateLimitError) {
      message = '요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요.';
    } else if (err instanceof Anthropic.APIConnectionError) {
      message = '네트워크 연결을 확인해 주세요.';
    }
    event.sender.send('lookup-error', { requestId, message });
  }
}

async function runLookup(event, requestId, text, context) {
  const provider = settings.provider;
  const apiKey = resolveKey(provider);
  if (!apiKey) {
    const name = provider === 'gemini' ? 'Gemini' : 'Claude';
    event.sender.send('lookup-error', {
      requestId,
      message: `${name} API 키가 없습니다. 설정(⚙)에서 키를 입력해 주세요.`,
    });
    return;
  }

  // 문장 안 단어 재선택 모드 vs 일반 모드
  let systemPrompt;
  let userText;
  if (context && context !== text) {
    systemPrompt = buildWordSystemPrompt();
    userText = userMessageWord(text, context);
  } else {
    systemPrompt = buildSystemPrompt();
    userText = userMessage(text);
  }

  // 용어(짧은 선택)면 위키백과 예시 이미지도 병렬로 조회 (실패해도 무시)
  if (wordCount(text) <= 4) {
    fetchWikiImage(text).then((img) => {
      if (img) event.sender.send('lookup-image', { requestId, ...img });
    });
  }

  if (provider === 'gemini') {
    return runGeminiLookup(event, requestId, apiKey, systemPrompt, userText);
  }
  return runClaudeLookup(event, requestId, apiKey, systemPrompt, userText);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function settingsForRenderer() {
  return {
    ...settings,
    hasEnvGemini: !!process.env.GEMINI_API_KEY,
    hasEnvClaude: !!process.env.ANTHROPIC_API_KEY,
    activeModel: currentModel(),
  };
}

ipcMain.handle('get-settings', () => settingsForRenderer());

ipcMain.handle('save-settings', (_e, next) => {
  settings = saveSettings(next);
  return settingsForRenderer();
});

ipcMain.on('lookup', (event, { requestId, text, context }) => {
  runLookup(event, requestId, text, context);
});

ipcMain.handle('list-gemini-models', async () => {
  const key = settings.gemini.apiKey || process.env.GEMINI_API_KEY || '';
  if (!key) {
    return { ok: false, error: 'Gemini API 키를 먼저 입력·저장해 주세요.', models: [] };
  }
  return fetchGeminiModelList(key);
});

ipcMain.on('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) {
    shell.openExternal(url);
  }
});

ipcMain.on('window-close', () => {
  if (win) win.close();
});
ipcMain.on('window-minimize', () => {
  if (win) win.minimize();
});

let pinned = true;
ipcMain.handle('toggle-pin', () => {
  pinned = !pinned;
  if (win) win.setAlwaysOnTop(pinned, 'screen-saver');
  return pinned;
});

// ---------------------------------------------------------------------------
// 앱 라이프사이클
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  createWindow();
  startClipboardWatch();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (clipboardTimer) clearInterval(clipboardTimer);
  if (process.platform !== 'darwin') app.quit();
});
