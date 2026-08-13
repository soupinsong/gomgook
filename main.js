'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  screen,
  shell,
  globalShortcut,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
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
  // 'apps'  = 지정한 프로그램이 맨 앞일 때 복사하면 풀이 (그 외 앱은 조용)
  // 'auto'  = 어떤 앱에서든 복사하면 바로 풀이
  // 'hotkey'= 단축키를 눌렀을 때만 풀이
  trigger: 'apps',
  hotkey: 'Ctrl+Shift+Space',
  // 감지할 프로그램(프로세스 이름 일부, 소문자). 삼성 노트 + 대표 PDF 리더.
  apps: ['samsungnotes', 'acrobat', 'acrord32', 'foxit', 'sumatra', 'hwp', 'pdf'],
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
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const merged = mergeSettings(DEFAULT_SETTINGS, parsed);
    // 이 기능 이전 설정('apps' 키 없음) → 새 권장 모드(특정 앱)로 이동
    if (!Object.prototype.hasOwnProperty.call(parsed, 'apps')) {
      merged.trigger = 'apps';
    }
    return merged;
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
// 논문 노트 라이브러리 (userData/papers.json)
//   논문마다 폴더처럼: 풀이 기록(entries) + 누적 용어집(glossary)
// ---------------------------------------------------------------------------
const LIB_PATH = path.join(app.getPath('userData'), 'papers.json');

function loadLibrary() {
  try {
    const j = JSON.parse(fs.readFileSync(LIB_PATH, 'utf8'));
    if (j && Array.isArray(j.papers)) return j;
  } catch {
    /* 새로 시작 */
  }
  return { papers: [], currentId: null };
}

let library = loadLibrary();
let lastEntryId = null;

function saveLibrary() {
  try {
    fs.writeFileSync(LIB_PATH, JSON.stringify(library, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function genId() {
  return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function newPaper(title) {
  return {
    id: genId(),
    title: title || '새 논문',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    glossary: [], // [{term, meaning}]
    entries: [], // [{id, time, mode, text, context, answer, followups:[{q,a}]}]
  };
}

function ensureCurrentPaper() {
  if (!library.papers.length) {
    const p = newPaper('기본 노트');
    library.papers.push(p);
    library.currentId = p.id;
    saveLibrary();
  }
  if (!library.currentId || !library.papers.find((p) => p.id === library.currentId)) {
    library.currentId = library.papers[0].id;
    saveLibrary();
  }
  return library.papers.find((p) => p.id === library.currentId);
}

function currentPaper() {
  return ensureCurrentPaper();
}

// 답변에서 "용어 — 뜻" 뽑아 논문 용어집에 누적 (추가 AI 호출 없이 파싱)
function extractGlossary(answer, mode, text) {
  const out = [];
  const lines = String(answer || '').split('\n');
  let section = '';
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith('## ')) {
      section = t.slice(3);
      continue;
    }
    const isTermSection = /핵심 용어/.test(section);
    const isWordSection = /이 문맥에서의 뜻/.test(section);
    if ((t.startsWith('- ') || t.startsWith('* ')) && (isTermSection || isWordSection)) {
      const body = t.slice(2).trim().replace(/\*\*/g, '');
      if (isWordSection && mode === 'word') {
        // 단어 모드: 고른 단어 = term, 이 줄 = 뜻
        const meaning = body.split(/\s*\/\s*/)[0].trim();
        if (text && meaning) out.push({ term: text.trim(), meaning: meaning.slice(0, 140) });
      } else {
        const m = body.split(/\s[—–-]\s|:\s/);
        if (m.length >= 2) {
          const term = m[0].trim();
          const meaning = body.slice(body.indexOf(m[1])).trim();
          if (term && meaning && term.length <= 40) {
            out.push({ term, meaning: meaning.slice(0, 140) });
          }
        }
      }
    }
  }
  return out;
}

function mergeGlossary(paper, items) {
  for (const it of items) {
    const key = it.term.toLowerCase();
    const ex = paper.glossary.find((g) => g.term.toLowerCase() === key);
    if (ex) ex.meaning = it.meaning;
    else paper.glossary.push(it);
  }
  if (paper.glossary.length > 400) paper.glossary = paper.glossary.slice(-400);
}

function saveEntry(text, context, answer) {
  const p = currentPaper();
  const mode = context ? 'word' : 'sentence';
  const entry = {
    id: genId(),
    time: Date.now(),
    mode,
    text,
    context: context || '',
    answer,
    followups: [],
  };
  p.entries.push(entry);
  mergeGlossary(p, extractGlossary(answer, mode, text));
  p.updatedAt = Date.now();
  lastEntryId = entry.id;
  saveLibrary();
}

function appendFollowup(question, answer) {
  const p = currentPaper();
  const e =
    p.entries.find((x) => x.id === lastEntryId) || p.entries[p.entries.length - 1];
  if (e) {
    e.followups.push({ q: question, a: answer });
    p.updatedAt = Date.now();
    saveLibrary();
  }
}

// 지금 논문의 누적 지식을 프롬프트에 넣을 맥락 문자열
function paperContextText() {
  const p = currentPaper();
  const parts = [];
  if (p.glossary && p.glossary.length) {
    const g = p.glossary
      .slice(-50)
      .map((x) => `${x.term}=${x.meaning}`)
      .join(' · ');
    parts.push(`[이미 정리한 용어] ${g}`);
  }
  const recent = (p.entries || [])
    .slice(-8)
    .map((e) => e.text)
    .filter(Boolean)
    .map((s) => (s.length > 60 ? s.slice(0, 60) + '…' : s));
  if (recent.length) parts.push(`[최근 본 문장/단어] ${recent.join(' / ')}`);
  if (!parts.length) return '';
  return (
    `\n\n지금 사용자는 "${p.title}" 논문을 한 문장씩 읽는 중이야. ` +
    `아래 맥락을 참고해서 앞뒤 흐름을 잇고, 이미 정의한 용어는 같은 뜻으로 일관되게 설명해:\n` +
    parts.join('\n')
  );
}

function papersMeta() {
  return {
    currentId: library.currentId,
    papers: library.papers
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({
        id: p.id,
        title: p.title,
        count: p.entries.length,
        terms: p.glossary.length,
        updatedAt: p.updatedAt,
      })),
  };
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
// 맨 앞(포커스) 프로그램 감지 — 특정 앱에서만 자동 풀이하려고. UWP(스토어앱)도 처리.
// ---------------------------------------------------------------------------
const FG_PS = [
  'Add-Type -Language CSharp -TypeDefinition @"',
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class FG {',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
  '  [DllImport("user32.dll")] static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);',
  '  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr l);',
  '  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr l);',
  '  public static int Pid() {',
  '    IntPtr h = GetForegroundWindow();',
  '    uint pid; GetWindowThreadProcessId(h, out pid);',
  '    uint real = pid;',
  '    EnumChildWindows(h, (c, l) => {',
  '      var sb = new StringBuilder(256); GetClassName(c, sb, 256);',
  '      if (sb.ToString() == "Windows.UI.Core.CoreWindow") {',
  '        uint cpid; GetWindowThreadProcessId(c, out cpid);',
  '        real = cpid; return false;',
  '      }',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return (int)real;',
  '  }',
  '}',
  '"@',
  '$p = [FG]::Pid()',
  '(Get-Process -Id $p).ProcessName',
].join('\r\n');

let fgScriptPath = null;
function ensureFgScript() {
  if (fgScriptPath) return fgScriptPath;
  try {
    const p = path.join(app.getPath('userData'), 'fg.ps1');
    fs.writeFileSync(p, FG_PS, 'utf8');
    fgScriptPath = p;
  } catch {
    fgScriptPath = null;
  }
  return fgScriptPath;
}

function getForegroundApp() {
  return new Promise((resolve) => {
    const script = ensureFgScript();
    if (!script) return resolve(null);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const name = String(stdout || '').trim();
        resolve(name || null);
      }
    );
  });
}

function appAllowed(name) {
  if (!name) return false; // 감지 실패 → 조용히 skip
  const lower = name.toLowerCase();
  return (settings.apps || []).some((a) => a && lower.includes(String(a).toLowerCase()));
}

// ---------------------------------------------------------------------------
// 클립보드 감시
// ---------------------------------------------------------------------------
let lastClipboard = clipboard.readText();
let clipboardTimer = null;
let fgBusy = false;
let lastSkippedApp = '';

function emitLookup(trimmed) {
  win.webContents.send('clipboard-change', {
    text: trimmed.slice(0, settings.maxChars),
    autoLookup: true,
  });
}

async function handleClipboardChange(trimmed) {
  if (settings.trigger === 'auto') {
    emitLookup(trimmed);
    return;
  }
  if (settings.trigger === 'apps') {
    if (fgBusy) return;
    fgBusy = true;
    const name = await getForegroundApp();
    fgBusy = false;
    if (appAllowed(name)) {
      emitLookup(trimmed);
    } else {
      lastSkippedApp = name || '';
      if (win) win.webContents.send('app-skipped', { name: name || '' });
    }
  }
  // 'hotkey' 모드는 여기서 아무것도 안 함 (단축키가 처리)
}

function startClipboardWatch() {
  clipboardTimer = setInterval(() => {
    if (!win) return;
    if (settings.trigger === 'hotkey') return; // 폴링 불필요
    let text = '';
    try {
      text = clipboard.readText();
    } catch {
      return;
    }
    if (text && text !== lastClipboard) {
      lastClipboard = text;
      const trimmed = text.trim();
      if (trimmed.length >= settings.minChars) handleClipboardChange(trimmed);
    }
  }, 400);
}

// 전역 단축키: 눌렀을 때 클립보드의 텍스트를 풀이
function applyHotkey() {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
  if (settings.trigger !== 'hotkey' || !settings.hotkey) return true;
  try {
    return globalShortcut.register(settings.hotkey, () => {
      if (!win) return;
      let text = '';
      try {
        text = clipboard.readText();
      } catch {
        /* ignore */
      }
      const t = (text || '').trim();
      win.showInactive(); // 최소화돼 있으면 다시 보이게 (포커스는 뺏지 않음)
      if (t.length >= settings.minChars) {
        win.webContents.send('hotkey-lookup', { text: t.slice(0, settings.maxChars) });
      } else {
        win.webContents.send('hotkey-empty');
      }
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 프롬프트
// ---------------------------------------------------------------------------
// 고정 페르소나(멀티턴 내내 유지). 형식 지시는 각 첫 메시지에 담는다.
function buildSystemPrompt() {
  const domains = settings.domains.join(', ');
  return [
    `너는 "딸깍 사전"이야. ${domains} 분야의 논문(주로 영어)을 읽는 학생을 돕는다.`,
    `모든 답은 한국어로, ${settings.level} 눈높이의 쉬운 말과 비유로 설명해. 어려운 말을 또 어려운 말로 풀지 마.`,
    `문맥(생물학/정보학/유전체학 중 어디에 가까운지)을 파악해서 그 분야에서의 의미로 설명하고,`,
    `같은 단어라도 이 분야에서 특수하게 쓰이면 그 쓰임을 알려줘 (예: "expression"=발현).`,
    `이어지는 추가 질문에는 앞의 내용을 기억한 채로, 물어본 것에 바로 답해줘.`,
    `잡담·인사·불필요한 반복 없이 짧고 밀도 있게. 마크다운을 써.`,
  ].join('\n');
}

// 일반 모드 첫 메시지 (형식 포함) — 영어 초보용 직독직해 + 의역 함께
function userMessage(text) {
  return [
    `다음 텍스트를 영어 초보자도 이해하도록 아래 형식으로 풀어줘:`,
    ``,
    `## 직독직해`,
    `- 영어 어순 그대로, 끊어읽는 단위로 "«영어 구» → 한국어 뜻" 처럼 짚어줘. 문장 구조가 눈에 보이게.`,
    `- 이미 한국어 텍스트면 이 항목은 생략.`,
    `## 의역`,
    `- 자연스러운 한국어 번역 한 문장.`,
    `## 핵심 용어`,
    `- 중요한 전문용어마다 "용어 — 이 문맥에서의 뜻 / 쉬운 설명" (최대 4~5개).`,
    `## 한 줄 정리`,
    `- 결국 무슨 말인지 한 문장으로.`,
    ``,
    `"""${text}"""`,
  ].join('\n');
}

// 문장 속 단어 모드 첫 메시지 (형식 포함)
function userMessageWord(word, sentence) {
  return [
    `문장: """${sentence}"""`,
    ``,
    `이 문장 안에서 «${word}»가 어떤 뜻으로 쓰였는지 아래 형식으로 설명해줘. 문장 전체 번역은 반복하지 마.`,
    ``,
    `## 이 문맥에서의 뜻`,
    `- 이 문장에서 «${word}»가 가리키는 정확한 의미 (한두 줄).`,
    `## 쉬운 풀이`,
    `- 비유를 곁들여서.`,
    `## 참고`,
    `- 다른 분야·일상에서의 뜻과 어떻게 다른지 (있을 때만).`,
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
// Gemini (무료) 스트리밍 — turns 전체를 받아 멀티턴 지원. 성공 시 전체 답 반환.
// ---------------------------------------------------------------------------
async function streamGemini(event, requestId, apiKey, system, turns, retried) {
  const model = settings.gemini.model;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

  const generationConfig = { maxOutputTokens: 2000, temperature: 0.3 };
  if (model.includes('2.5')) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: turns.map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.content }],
    })),
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
    return null;
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
        settings = saveSettings({ gemini: { ...settings.gemini, model: best } });
        event.sender.send('model-changed', { model: best });
        return streamGemini(event, requestId, apiKey, system, turns, true);
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
    return null;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
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
          if (delta) {
            full += delta;
            event.sender.send('lookup-chunk', { requestId, delta });
          }
        } catch {
          /* 부분 JSON 무시 */
        }
      }
    }
    return full;
  } catch {
    event.sender.send('lookup-error', {
      requestId,
      message: '응답을 받는 중 문제가 생겼어요. 다시 시도해 주세요.',
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claude (유료) 스트리밍 — turns 전체를 받아 멀티턴 지원. 성공 시 전체 답 반환.
// ---------------------------------------------------------------------------
async function streamClaude(event, requestId, apiKey, system, turns) {
  const client = new Anthropic({ apiKey });
  let full = '';
  try {
    const stream = client.messages.stream({
      model: settings.claude.model,
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      system,
      messages: turns.map((t) => ({
        role: t.role === 'assistant' ? 'assistant' : 'user',
        content: t.content,
      })),
    });

    stream.on('text', (delta) => {
      full += delta;
      event.sender.send('lookup-chunk', { requestId, delta });
    });

    await stream.finalMessage();
    return full;
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
    return null;
  }
}

// ---------------------------------------------------------------------------
// 대화 상태 (한 창 = 한 대화). 새 조회 때 초기화, 추가 질문은 이어붙임.
// ---------------------------------------------------------------------------
let convo = { system: '', turns: [] };

async function converse(event, requestId) {
  const provider = settings.provider;
  const apiKey = resolveKey(provider);
  if (!apiKey) {
    const name = provider === 'gemini' ? 'Gemini' : 'Claude';
    event.sender.send('lookup-error', {
      requestId,
      message: `${name} API 키가 없습니다. 설정(⚙)에서 키를 입력해 주세요.`,
    });
    return null;
  }
  const full =
    provider === 'gemini'
      ? await streamGemini(event, requestId, apiKey, convo.system, convo.turns, false)
      : await streamClaude(event, requestId, apiKey, convo.system, convo.turns);

  if (full != null) {
    convo.turns.push({ role: 'assistant', content: full });
    event.sender.send('lookup-done', { requestId });
  }
  return full;
}

// 새 조회 (문장/단어 선택) — 답을 현재 논문 노트에 저장
async function runLookup(event, requestId, text, context) {
  // 페르소나 + 이 논문에서 누적한 용어·맥락
  const system = buildSystemPrompt() + paperContextText();
  const firstUser =
    context && context !== text
      ? userMessageWord(text, context)
      : userMessage(text);
  convo = { system, turns: [{ role: 'user', content: firstUser }] };

  // 용어(짧은 선택)면 위키백과 예시 이미지도 병렬로 조회 (실패해도 무시)
  if (wordCount(text) <= 4) {
    fetchWikiImage(text).then((img) => {
      if (img) event.sender.send('lookup-image', { requestId, ...img });
    });
  }

  const full = await converse(event, requestId);
  if (full != null) {
    saveEntry(text, context && context !== text ? context : '', full);
    event.sender.send('paper-updated', papersMeta());
  }
}

// 추가 질문 (이전 대화 맥락 유지) — 답을 직전 기록에 이어 저장
async function runAsk(event, requestId, question) {
  if (!convo.turns.length) {
    event.sender.send('lookup-error', {
      requestId,
      message: '먼저 단어나 문장을 풀이해 주세요.',
    });
    return;
  }
  convo.turns.push({ role: 'user', content: question });
  const full = await converse(event, requestId);
  if (full != null) {
    appendFollowup(question, full);
    event.sender.send('paper-updated', papersMeta());
  }
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
    lastSkippedApp,
  };
}

ipcMain.handle('get-settings', () => settingsForRenderer());

ipcMain.handle('save-settings', (_e, next) => {
  settings = saveSettings(next);
  applyHotkey();
  return settingsForRenderer();
});

ipcMain.handle('toggle-trigger', () => {
  const order = ['apps', 'auto', 'hotkey'];
  const next = order[(order.indexOf(settings.trigger) + 1) % order.length];
  settings = saveSettings({ trigger: next });
  applyHotkey();
  return next;
});

ipcMain.on('lookup', (event, { requestId, text, context }) => {
  runLookup(event, requestId, text, context);
});

ipcMain.on('ask', (event, { requestId, question }) => {
  runAsk(event, requestId, question);
});

// ── 논문 노트 라이브러리 IPC ──
ipcMain.handle('lib-list', () => {
  ensureCurrentPaper();
  return papersMeta();
});

ipcMain.handle('lib-create', (_e, title) => {
  const p = newPaper((title || '').trim() || '새 논문');
  library.papers.push(p);
  library.currentId = p.id;
  lastEntryId = null;
  saveLibrary();
  return papersMeta();
});

ipcMain.handle('lib-select', (_e, id) => {
  if (library.papers.find((p) => p.id === id)) {
    library.currentId = id;
    lastEntryId = null;
    saveLibrary();
  }
  return papersMeta();
});

ipcMain.handle('lib-rename', (_e, { id, title }) => {
  const p = library.papers.find((x) => x.id === id);
  if (p) {
    p.title = (title || '').trim() || p.title;
    p.updatedAt = Date.now();
    saveLibrary();
  }
  return papersMeta();
});

ipcMain.handle('lib-delete', (_e, id) => {
  library.papers = library.papers.filter((p) => p.id !== id);
  if (library.currentId === id) library.currentId = null;
  lastEntryId = null;
  ensureCurrentPaper();
  saveLibrary();
  return papersMeta();
});

ipcMain.handle('lib-get', (_e, id) => {
  const p = library.papers.find((x) => x.id === id) || currentPaper();
  return { id: p.id, title: p.title, glossary: p.glossary, entries: p.entries };
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
  ensureCurrentPaper();
  createWindow();
  startClipboardWatch();
  applyHotkey();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
});

app.on('window-all-closed', () => {
  if (clipboardTimer) clearInterval(clipboardTimer);
  if (process.platform !== 'darwin') app.quit();
});
