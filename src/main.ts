import './style.css';
import {
  COLORS,
  COLOR_MASK,
  evaluateQuery,
  FILLS,
  FILL_MASK,
  generateSecret,
  SHAPES,
  SHAPE_MASK,
  type CardBits,
  type GameConfig,
  type Query,
  type QueryOperator,
} from './core';

type Outcome = 'playing' | 'victory';
type LogEntry = { text: string; answer: boolean };
type LeaderboardEntry = {
  nickname: string;
  seed: string;
  questionCount: number;
  elapsedMilliseconds: number;
  createdAt: string;
};

const root = (() => {
  const element = document.querySelector<HTMLDivElement>('#app');
  if (!element) throw new Error('앱을 표시할 영역을 찾을 수 없습니다.');
  return element;
})();
const params = new URLSearchParams(window.location.search);
const randomSeed = () => String(Math.floor(Math.random() * 1_000_000_000));
const validNumber = (value: string | null, min: number, max: number, fallback: number) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};

let seed = params.get('seed') || randomSeed();
let config: GameConfig = {
  slots: validNumber(params.get('slots'), 3, 10, 3),
  attributes: validNumber(params.get('attributes'), 1, 3, 2),
};
let gameStarted = false;
let outcome: Outcome = 'playing';
let loginError = '';
let authMode: 'login' | 'register' = 'login';
let authChecked = false;
let authBusy = false;
let queryCount = 0;
let startedAt = 0;
let finishedAt: number | null = null;
let secret: CardBits[] = [];
let excludedCards = new Set<string>();
let log: LogEntry[] = [];
let guessFeedback = '';
let leaderboard: LeaderboardEntry[] = [];
let leaderboardMessage = '리더보드를 불러오는 중입니다.';
let recordStatus = '';
let recordSubmitted = false;
let currentUsername = '';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function elapsedMilliseconds(): number {
  if (!startedAt) return 0;
  return (finishedAt ?? Date.now()) - startedAt;
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const tenths = Math.floor((milliseconds % 1000) / 100);
  return `${String(minutes).padStart(2, '0')}:${seconds}.${tenths}`;
}

function attributeChoices(): Array<{ label: string; value: number }> {
  return [
    ...COLORS.map((item) => ({ label: item.label, value: item.value })),
    ...(config.attributes >= 2
      ? SHAPES.map((item) => ({ label: item.label, value: item.value }))
      : []),
    ...(config.attributes >= 3
      ? FILLS.map((item) => ({ label: item.label, value: item.value }))
      : []),
  ];
}

function optionList(options: Array<{ label: string; value: number }>): string {
  return options.map((item) => `<option value="${item.value}">${item.label}</option>`).join('');
}

function categoryOptions(): string {
  return [
    ...(config.attributes >= 2 ? [`<option value="${SHAPE_MASK}">도형</option>`] : []),
    `<option value="${COLOR_MASK}">색상</option>`,
    ...(config.attributes >= 3 ? [`<option value="${FILL_MASK}">채움</option>`] : []),
  ].join('');
}

function slotOptions(selected = 0, except = -1): string {
  return Array.from({ length: config.slots }, (_, index) => {
    const disabled = index === except ? ' disabled' : '';
    const isSelected = index === selected ? ' selected' : '';
    return `<option value="${index}"${disabled}${isSelected}>${index + 1}번</option>`;
  }).join('');
}

function renderQueryFields(kind: string): string {
  if (kind === 'RELATION_EQ') {
    return `
      <label>비교할 자리
        <span class="field-pair">
          <select name="first">${slotOptions(0, 1)}</select>
          <span class="pair-word">와</span>
          <select name="second">${slotOptions(1, 0)}</select>
        </span>
      </label>
      <label>비교할 속성
        <select name="group">${categoryOptions()}</select>
      </label>`;
  }

  if (kind === 'COUNT_COMPARE') {
    return `
      <label>관찰 대상
        <select name="attribute">${optionList(attributeChoices())}</select>
      </label>
      <label>연산
        <select name="operator">
          <option value=">=">이상</option><option value="==">같다</option>
          <option value="!=">다르다</option><option value=">">초과</option>
          <option value="<">미만</option>
        </select>
      </label>
      <label>비교 수량
        <select name="count">${Array.from({ length: config.slots + 1 }, (_, n) =>
          `<option value="${n}">${n}개</option>`,
        ).join('')}</select>
      </label>`;
  }

  return `
    <label>확인할 자리
      <select name="slot">${slotOptions()}</select>
    </label>
    <label>확인할 속성
      <select name="attribute">${optionList(attributeChoices())}</select>
    </label>`;
}

function renderCards(guessing = false): string {
  return Array.from({ length: config.slots }, (_, index) => {
    const card = secret[index] ?? 0;
    const shape = SHAPES.find((item) => (card & item.value) !== 0);
    const color = COLORS.find((item) => (card & item.value) !== 0);
    const fill = FILLS.find((item) => (card & item.value) !== 0);
    const selection = (name: string, items: Array<{ label: string; value: number }>, selected: number) =>
      `<label>${name}<select name="${name}-${index}">${items
        .map(
          (item) =>
            `<option value="${item.value}"${item.value === selected ? ' selected' : ''}>${item.label}</option>`,
        )
        .join('')}</select></label>`;

    if (guessing) {
      return `
        <article class="guess-card">
          <span class="slot-number">${String(index + 1).padStart(2, '0')}</span>
          ${config.attributes >= 2 ? selection('도형', SHAPES, shape?.value ?? SHAPES[0].value) : ''}
          ${selection('색상', COLORS, color?.value ?? COLORS[0].value)}
          ${config.attributes >= 3 ? selection('채움', FILLS, fill?.value ?? FILLS[0].value) : ''}
        </article>`;
    }

    return `
      <div class="secret-placeholder">
        <span class="slot-number">${String(index + 1).padStart(2, '0')}</span>
        <span class="lock">?</span><span>미확인</span>
      </div>`;
  }).join('');
}

function renderScratchpad(): string {
  const candidates = COLORS.flatMap((color) =>
    (config.attributes >= 2 ? SHAPES : [undefined]).flatMap((shape) =>
      (config.attributes >= 3 ? FILLS : [undefined]).map((fill) => ({
        bits: color.value | (shape?.value ?? 0) | (fill?.value ?? 0),
        title: [shape?.label, color.label, fill?.label].filter(Boolean).join(' '),
        symbol: shape?.symbol ?? '●',
        color: color.className,
        fill: fill?.label,
      })),
    ),
  );

  return Array.from({ length: config.slots }, (_, slot) => `
    <div class="scratch-row">
      <span class="scratch-slot">${slot + 1}번</span>
      <div class="candidate-grid">
        ${candidates.map((item) => {
          const key = `${slot}:${item.bits}`;
          const marked = excludedCards.has(key);
          const fillSymbol = item.fill === '줄무늬' ? '▥' : item.fill === '윤곽' ? '○' : '●';
          return `<button type="button" class="candidate ${marked ? 'marked' : ''}" data-scratch="${key}" aria-pressed="${marked}" title="${item.title}">
            <span class="${item.color}">${item.symbol}</span>${item.fill ? `<small>${fillSymbol}</small>` : ''}
          </button>`;
        }).join('')}
      </div>
    </div>`).join('');
}

function renderSetup(): string {
  return `
    <main class="setup-layout">
      <section class="intro setup-intro">
        <div><span class="eyebrow">LOGIC / DEDUCTION</span><h1>암호를 <span>해독하세요.</span></h1><p>퍼즐 크기와 속성을 고르고 도전을 시작하세요.</p></div>
      </section>
      <section class="panel setup-panel">
        <div class="panel-heading"><div><span class="eyebrow">NEW PUZZLE</span><h2>퍼즐 설정</h2></div></div>
        <form id="setup-form">
          <label>카드 자리 수
            <select name="slots">${Array.from({ length: 8 }, (_, index) => {
              const value = index + 3;
              return `<option value="${value}"${value === config.slots ? ' selected' : ''}>${value}자리</option>`;
            }).join('')}</select>
          </label>
          <label>속성 종류
            <select name="attributes">${[1, 2, 3].map((value) =>
              `<option value="${value}"${value === config.attributes ? ' selected' : ''}>${value}개${value === 1 ? ' · 색상' : value === 2 ? ' · 색상 + 도형' : ' · 색상 + 도형 + 채움'}</option>`,
            ).join('')}</select>
          </label>
          <p class="setup-note">속성 종류는 색상부터 순서대로 추가됩니다. 시간 제한 없이 질문하고 정답을 제출할 수 있습니다.</p>
          <button class="button primary full" type="submit">퍼즐 시작 <span>→</span></button>
        </form>
      </section>
      <section class="setup-stats"><span>03—10<strong>자리 수 선택</strong></span><span>01—03<strong>속성 종류 선택</strong></span><span>∞<strong>시간 제한 없음</strong></span></section>
    </main>`;
}

function renderLogin(): string {
  const registering = authMode === 'register';
  return `
    <main class="setup-layout">
      <section class="intro setup-intro">
        <div><span class="eyebrow">WELCOME TO PPULJIT</span><h1>계정을 <span>${registering ? '만드세요.' : '입력하세요.'}</span></h1><p>아이디와 비밀번호로 계정을 만들고, 어느 기기에서든 로그인하세요.</p></div>
      </section>
      <section class="panel setup-panel login-panel">
        <div class="panel-heading"><div><span class="eyebrow">${registering ? 'CREATE ACCOUNT' : 'ACCOUNT LOGIN'}</span><h2>${registering ? '계정 만들기' : '로그인'}</h2></div></div>
        <form id="auth-form">
          <label>아이디
            <input name="username" minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="username" placeholder="영문·숫자·밑줄 3~20자" required>
          </label>
          <label>비밀번호
            <input name="password" type="password" minlength="8" maxlength="128" autocomplete="${registering ? 'new-password' : 'current-password'}" placeholder="${registering ? '8~128자' : '비밀번호'}" required>
          </label>
          ${loginError ? `<p class="record-status" role="alert">${escapeHtml(loginError)}</p>` : ''}
          <p class="setup-note">비밀번호는 암호화된 해시로 저장되며 원문은 저장하지 않습니다. 아이디는 영문 소문자, 숫자, 밑줄만 사용할 수 있습니다.</p>
          <button class="button primary full" type="submit" ${authBusy ? 'disabled' : ''}>${authBusy ? '처리 중…' : registering ? '계정 만들기' : '로그인'} <span>→</span></button>
        </form>
        <button class="button outline full auth-switch" data-action="switch-auth" ${authBusy ? 'disabled' : ''}>${registering ? '이미 계정이 있나요? 로그인' : '계정이 없나요? 회원가입'}</button>
      </section>
    </main>`;
}

function renderAuthLoading(): string {
  return '<main class="setup-layout"><section class="panel setup-panel"><p class="setup-note">로그인 상태를 확인하는 중입니다.</p></section></main>';
}

function renderModal(): string {
  if (outcome !== 'victory') return '';
  return `
    <div class="modal-backdrop">
      <section class="result-modal" role="dialog" aria-modal="true">
        <span class="eyebrow">PUZZLE SOLVED</span>
        <h2>ppuljit을 해독했습니다</h2>
        <p>${config.slots}자리 · 속성 ${config.attributes}개 퍼즐을 완료했습니다.</p>
        <div class="result-stats">
          <span>질문 횟수<strong>${queryCount}회</strong></span>
          <span>경과 시간<strong>${formatTime(elapsedMilliseconds())}</strong></span>
        </div>
        <form id="record-form">
          <p class="setup-note">리더보드 계정: ${escapeHtml(currentUsername)}</p>
          <button class="button primary full" type="submit" ${recordSubmitted ? 'disabled' : ''}>${recordSubmitted ? '기록 등록 완료' : '기록 등록'}</button>
          ${recordStatus ? `<p class="record-status" role="status">${escapeHtml(recordStatus)}</p>` : ''}
        </form>
        <button class="button primary" data-action="restart">새 퍼즐 설정</button>
        <button class="button outline modal-logout" data-action="logout">로그아웃</button>
      </section>
    </div>`;
}

function renderLeaderboard(): string {
  return `
    <section class="panel leaderboard-panel">
      <div class="panel-heading"><div><span class="eyebrow">LEADERBOARD</span><h2>${config.slots}자리 · 속성 ${config.attributes}개</h2></div><span class="log-count">TOP 10</span></div>
      ${leaderboard.length
        ? `<div class="leaderboard-list">${leaderboard.map((record, index) => `
          <div class="leaderboard-entry">
            <span class="leaderboard-rank">${String(index + 1).padStart(2, '0')}</span>
            <span class="leaderboard-name">${escapeHtml(record.nickname)}</span>
            <span class="leaderboard-score">${record.questionCount}회 · ${formatTime(record.elapsedMilliseconds)}</span>
          </div>`).join('')}</div>`
        : `<p class="empty-log">${escapeHtml(leaderboardMessage)}</p>`}`;
}

function renderGame(): string {
  return `
    <main class="layout">
      <section class="game-column">
        <div class="intro">
          <div><span class="eyebrow">LOGIC / DEDUCTION</span><h1>암호를 <span>해독하세요.</span></h1><p>질문으로 단서를 모으고, 숨겨진 카드 조합을 찾아내세요.</p></div>
          <div class="stage-pill"><span>PUZZLE</span><strong>${config.slots}<small> SLOTS</small></strong></div>
        </div>
        <section class="panel board-panel">
          <div class="panel-heading"><div><span class="eyebrow">SECRET MATRIX</span><h2>숨겨진 카드</h2></div><span class="slot-count">${config.slots} SLOTS · ${config.attributes} ATTRIBUTES</span></div>
          <div class="secret-row">${renderCards()}</div>
          <div class="board-hint"><span class="live-dot"></span>정답 카드는 질문으로만 확인할 수 있습니다</div>
        </section>
        <section class="panel query-panel">
          <div class="panel-heading"><div><span class="eyebrow">ASK A QUESTION</span><h2>무엇을 알아볼까요?</h2></div><span class="query-hint">질문 제한 없음</span></div>
          <form id="query-form">
            <div class="query-type-row">
              <label class="query-type"><input type="radio" name="kind" value="POSITION_CHECK" checked><span><b>자리 확인</b><small>YES / NO</small></span></label>
              <label class="query-type"><input type="radio" name="kind" value="RELATION_EQ"><span><b>속성 비교</b><small>YES / NO</small></span></label>
              <label class="query-type"><input type="radio" name="kind" value="COUNT_COMPARE"><span><b>전체 집계</b><small>YES / NO</small></span></label>
            </div>
            <div class="query-fields">${renderQueryFields('POSITION_CHECK')}</div>
            <button class="button primary full" type="submit" ${outcome === 'victory' ? 'disabled' : ''}>질문하기 <span>→</span></button>
          </form>
        </section>
        <details class="panel scratch-panel">
          <summary><span><span class="eyebrow">SCRATCHPAD</span><strong>소거 메모장</strong></span><span class="summary-hint">후보를 눌러 제외 표시 <b>＋</b></span></summary>
          <div class="scratch-content">${renderScratchpad()}</div>
        </details>
      </section>
      <aside class="side-column">
        <section class="panel hud-panel">
          <div class="panel-heading"><div><span class="eyebrow">YOUR SESSION</span><h2>현재 기록</h2></div><span class="live-dot"></span></div>
          <div class="hud-stats"><span>경과 시간<strong id="timer">${formatTime(elapsedMilliseconds())}</strong></span><span>질문 횟수<strong id="question-count">${queryCount}<small> 회</small></strong></span></div>
          <div class="session-note">시간 제한이 없습니다. 질문 횟수와 완료 시간을 기록합니다.</div>
        </section>
        <section class="panel guess-panel">
          <div class="panel-heading"><div><span class="eyebrow">FINAL ANSWER</span><h2>정답 제출</h2></div><span class="guess-icon">⌁</span></div>
          <p class="panel-copy">각 위치의 속성을 선택해 조합을 제출하세요. 오답 제출은 질문 횟수에 포함됩니다.</p>
          <form id="guess-form">
            <div class="guess-grid">${renderCards(true)}</div>
            <button class="button outline full" type="submit" ${outcome === 'victory' ? 'disabled' : ''}>조합 제출 <span>→</span></button>
            ${guessFeedback ? `<p class="guess-feedback">${escapeHtml(guessFeedback)}</p>` : ''}
          </form>
        </section>
        <section class="panel log-panel">
          <div class="panel-heading"><div><span class="eyebrow">INTEL FEED</span><h2>질문 기록</h2></div><span class="log-count">${String(log.length).padStart(2, '0')}</span></div>
          <div class="log-list">${log.length ? log.slice().reverse().map((item, index) => `
            <div class="log-entry"><span class="log-index">${String(log.length - index).padStart(2, '0')}</span><span class="log-text">${escapeHtml(item.text)}</span><strong class="${item.answer ? 'yes' : 'no'}">${item.answer ? 'YES' : 'NO'}</strong></div>
          `).join('') : '<p class="empty-log">아직 질문이 없습니다.<br>첫 단서를 찾아보세요.</p>'}</div>
        </section>
        ${renderLeaderboard()}
      </aside>
    </main>
    ${renderModal()}`;
}

function render(): void {
  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="./" aria-label="ppuljit 홈"><span class="brand-mark">p</span><span>ppuljit</span></a>
      <div class="top-meta">${loginError && currentUsername ? `<span class="header-error" role="alert">${escapeHtml(loginError)}</span>` : ''}${currentUsername ? `<span class="user-chip">${escapeHtml(currentUsername)}</span>${outcome !== 'victory' ? '<button class="logout-button" data-action="logout">로그아웃</button>' : ''}` : ''}${gameStarted ? `<span class="seed-label">SEED <strong>${escapeHtml(seed)}</strong></span><button class="icon-button" data-action="share" aria-label="결과 공유" title="결과 공유">↗</button>` : ''}</div>
    </header>
    ${gameStarted ? renderGame() : !authChecked ? renderAuthLoading() : currentUsername ? renderSetup() : renderLogin()}
    <footer><span>ppuljit <i>·</i> A LOGIC DEDUCTION GAME</span><button data-action="restart">${gameStarted ? '설정 변경' : '새 시드'}</button></footer>`;
  bindEvents();
}

function startGame(form: HTMLFormElement): void {
  const values = new FormData(form);
  config = { slots: Number(values.get('slots')), attributes: Number(values.get('attributes')) };
  const url = new URL(window.location.href);
  url.searchParams.set('seed', seed);
  url.searchParams.set('slots', String(config.slots));
  url.searchParams.set('attributes', String(config.attributes));
  window.history.replaceState(null, '', url);
  secret = generateSecret(seed, config);
  gameStarted = true;
  outcome = 'playing';
  queryCount = 0;
  startedAt = Date.now();
  finishedAt = null;
  excludedCards = new Set();
  log = [];
  guessFeedback = '';
  leaderboard = [];
  leaderboardMessage = '리더보드를 불러오는 중입니다.';
  recordStatus = '';
  recordSubmitted = false;
  render();
  void loadLeaderboard();
}

function bindEvents(): void {
  root.querySelector<HTMLFormElement>('#auth-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const username = String(form.get('username') ?? '');
    const password = String(form.get('password') ?? '');
    authBusy = true;
    loginError = '';
    render();
    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: authMode, username, password }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
            ? payload.error
            : '계정 요청을 처리하지 못했습니다.';
        throw new Error(message);
      }
      if (typeof payload !== 'object' || payload === null || !('username' in payload) || typeof payload.username !== 'string') {
        throw new Error('로그인 응답 형식이 올바르지 않습니다.');
      }
      currentUsername = payload.username;
      authChecked = true;
    } catch (error) {
      console.error('계정 요청을 처리하지 못했습니다.', error);
      loginError = error instanceof Error ? error.message : '계정 요청을 처리하지 못했습니다.';
    } finally {
      authBusy = false;
      render();
    }
  });

  root.querySelector<HTMLButtonElement>('[data-action="switch-auth"]')?.addEventListener('click', () => {
    authMode = authMode === 'register' ? 'login' : 'register';
    loginError = '';
    render();
  });

  root.querySelector<HTMLFormElement>('#setup-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    startGame(event.currentTarget as HTMLFormElement);
  });

  root.querySelectorAll<HTMLInputElement>('input[name="kind"]').forEach((input) => {
    input.addEventListener('change', () => {
      const fields = root.querySelector<HTMLDivElement>('.query-fields');
      if (fields) fields.innerHTML = renderQueryFields(input.value);
    });
  });

  root.querySelector<HTMLFormElement>('#query-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (outcome !== 'playing') return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const kind = String(form.get('kind'));
    let query: Query;
    let text: string;

    if (kind === 'RELATION_EQ') {
      const first = Number(form.get('first'));
      const second = Number(form.get('second'));
      if (first === second) return;
      const group = Number(form.get('group'));
      const groupName = group === SHAPE_MASK ? '도형' : group === COLOR_MASK ? '색상' : '채움';
      query = { type: 'RELATION_EQ', compareIndices: [first, second], attributeGroupMask: group };
      text = `${first + 1}번과 ${second + 1}번의 ${groupName}이 같은가?`;
    } else if (kind === 'COUNT_COMPARE') {
      const mask = Number(form.get('attribute'));
      const operator = String(form.get('operator')) as QueryOperator;
      const compareValue = Number(form.get('count'));
      const label = choicesLabel(mask);
      const operatorLabel: Record<QueryOperator, string> = {
        '==': '같은가?',
        '!=': '다른가?',
        '>': '초과인가?',
        '<': '미만인가?',
        '>=': '이상인가?',
      };
      query = { type: 'COUNT_COMPARE', mask, operator, compareValue };
      text = `전체 ${label} 카드가 ${compareValue}개 ${operatorLabel[operator]}`;
    } else {
      const slotIndex = Number(form.get('slot'));
      const mask = Number(form.get('attribute'));
      query = { type: 'POSITION_CHECK', slotIndex, mask };
      text = `${slotIndex + 1}번 카드에 ${choicesLabel(mask)}이(가) 있는가?`;
    }

    log.push({ text, answer: evaluateQuery(secret, query) });
    queryCount += 1;
    render();
  });

  root.querySelector<HTMLFormElement>('#guess-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (outcome !== 'playing') return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const guess = Array.from({ length: config.slots }, (_, index) =>
      (config.attributes >= 2 ? Number(form.get(`도형-${index}`)) : 0) |
      Number(form.get(`색상-${index}`)) |
      (config.attributes >= 3 ? Number(form.get(`채움-${index}`)) : 0),
    );

    if (guess.every((card, index) => card === secret[index])) {
      outcome = 'victory';
      finishedAt = Date.now();
      guessFeedback = '';
    } else {
      queryCount += 1;
      log.push({ text: '정답 조합 오답 제출', answer: false });
      guessFeedback = '정답이 아닙니다. 단서를 더 모아보세요.';
    }
    render();
  });

  root.querySelector<HTMLFormElement>('#record-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (outcome !== 'victory' || recordSubmitted) return;
    if (!currentUsername) {
      recordStatus = '기록을 등록하려면 먼저 로그인하세요.';
      render();
      return;
    }

    try {
      const response = await fetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seed,
          slots: config.slots,
          attributes: config.attributes,
          questionCount: queryCount,
          elapsedMilliseconds: elapsedMilliseconds(),
        }),
      });
      if (!response.ok) {
        const body: unknown = response.headers.get('content-type')?.includes('application/json')
          ? await response.json()
          : null;
        const message =
          typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
            ? body.error
            : '기록 등록에 실패했습니다.';
        throw new Error(message);
      }
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('기록 API가 없습니다. npm run dev:local로 실행하세요.');
      }
      recordSubmitted = true;
      recordStatus = '기록이 등록되었습니다.';
      await loadLeaderboard();
      render();
    } catch (error) {
      console.error('리더보드 기록을 등록하지 못했습니다.', error);
      recordStatus = error instanceof Error ? error.message : '기록 등록에 실패했습니다.';
      render();
    }
  });

  root.querySelectorAll<HTMLButtonElement>('[data-scratch]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.scratch;
      if (!key) return;
      if (excludedCards.has(key)) excludedCards.delete(key);
      else excludedCards.add(key);
      button.classList.toggle('marked');
      button.setAttribute('aria-pressed', String(excludedCards.has(key)));
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-action="restart"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (gameStarted) {
        gameStarted = false;
        outcome = 'playing';
        seed = randomSeed();
        const url = new URL(window.location.href);
        url.searchParams.delete('seed');
        url.searchParams.delete('slots');
        url.searchParams.delete('attributes');
        window.history.replaceState(null, '', url);
      } else {
        seed = randomSeed();
      }
      render();
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-action="logout"]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (gameStarted && outcome === 'playing' && !window.confirm('로그아웃하면 진행 중인 퍼즐이 초기화됩니다. 로그아웃할까요?')) {
        return;
      }

      try {
        const response = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'logout' }),
        });
        if (!response.ok) throw new Error('로그아웃하지 못했습니다. 다시 시도하세요.');
      } catch (error) {
        console.error('로그아웃 요청을 처리하지 못했습니다.', error);
        loginError = error instanceof Error ? error.message : '로그아웃하지 못했습니다.';
        render();
        return;
      }

      currentUsername = '';
      gameStarted = false;
      outcome = 'playing';
      queryCount = 0;
      startedAt = 0;
      finishedAt = null;
      secret = [];
      log = [];
      excludedCards = new Set();
      recordStatus = '';
      recordSubmitted = false;
      loginError = '';
      render();
    });
  });
  root.querySelector<HTMLButtonElement>('[data-action="share"]')?.addEventListener('click', shareResult);
}

function choicesLabel(mask: number): string {
  return attributeChoices().find((item) => item.value === mask)?.label ?? '';
}

function isLeaderboardEntry(value: unknown): value is LeaderboardEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.nickname === 'string' &&
    typeof record.seed === 'string' &&
    typeof record.questionCount === 'number' &&
    Number.isInteger(record.questionCount) &&
    typeof record.elapsedMilliseconds === 'number' &&
    Number.isFinite(record.elapsedMilliseconds) &&
    typeof record.createdAt === 'string'
  );
}

async function loadLeaderboard(): Promise<void> {
  try {
    const search = new URLSearchParams({
      slots: String(config.slots),
      attributes: String(config.attributes),
      limit: '10',
    });
    const response = await fetch(`/api/records?${search}`);
    if (!response.ok) throw new Error('리더보드를 불러오지 못했습니다.');
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('리더보드 API가 없습니다. npm run dev:local로 실행하세요.');
    }
    const payload: unknown = await response.json();
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('records' in payload) ||
      !Array.isArray(payload.records) ||
      !payload.records.every(isLeaderboardEntry)
    ) {
      throw new Error('리더보드 응답 형식이 올바르지 않습니다.');
    }
    leaderboard = payload.records;
    leaderboardMessage = leaderboard.length ? '' : '아직 등록된 기록이 없습니다.';
  } catch (error) {
    console.error('리더보드를 불러오지 못했습니다.', error);
    leaderboard = [];
    leaderboardMessage = error instanceof Error ? error.message : '리더보드를 불러오지 못했습니다.';
  }
  render();
}

async function shareResult(): Promise<void> {
  const text = [
    `🧩 ppuljit #${seed}`,
    `🧠 퍼즐: ${config.slots}자리 · 속성 ${config.attributes}개`,
    `🏆 ${outcome === 'victory' ? '클리어 완료' : '도전 중'}`,
    `🔍 질문 횟수: ${queryCount}회`,
    `⏱️ 경과 시간: ${formatTime(elapsedMilliseconds())}`,
    `👉 도전하기: ${window.location.origin}${window.location.pathname}?seed=${encodeURIComponent(seed)}&slots=${config.slots}&attributes=${config.attributes}`,
  ].join('\n');

  try {
    await navigator.clipboard.writeText(text);
    const button = root.querySelector<HTMLButtonElement>('[data-action="share"]');
    if (button) {
      button.textContent = '✓';
      window.setTimeout(() => {
        if (button.isConnected) button.textContent = '↗';
      }, 1600);
    }
  } catch (error) {
    console.error('공유 문구를 클립보드에 복사하지 못했습니다.', error);
    window.prompt('공유 문구를 복사하세요.', text);
  }
}

async function restoreSession(): Promise<void> {
  try {
    const response = await fetch('/api/auth');
    if (response.status !== 401) {
      if (!response.ok) throw new Error('로그인 상태를 확인하지 못했습니다.');
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('계정 API가 없습니다. npm run dev:local로 실행하세요.');
      }
      const payload: unknown = await response.json();
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('username' in payload) ||
        typeof payload.username !== 'string'
      ) {
        throw new Error('로그인 응답 형식이 올바르지 않습니다.');
      }
      currentUsername = payload.username;
    }
  } catch (error) {
    console.error('로그인 상태를 확인하지 못했습니다.', error);
    loginError = error instanceof Error ? error.message : '로그인 상태를 확인하지 못했습니다.';
  } finally {
    authChecked = true;
    render();
  }
}

window.setInterval(() => {
  const timer = root.querySelector<HTMLElement>('#timer');
  if (timer && outcome === 'playing') timer.textContent = formatTime(elapsedMilliseconds());
}, 100);

render();
void restoreSession();
