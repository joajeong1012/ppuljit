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
type Screen = 'home' | 'setup';
type LogEntry = { text: string; answer: boolean };
type LeaderboardEntry = {
  id: string;
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
let screen: Screen = 'home';
let gameStarted = false;
let outcome: Outcome = 'playing';
let loginError = '';
let authMode: 'login' | 'register' = 'login';
let authIntent: 'stay' | 'start' | 'record' = 'stay';
let authDialogOpen = false;
let playDialogOpen = false;
let authChecked = false;
let authBusy = false;
let guestPlay = false;
let queryCount = 0;
let startedAt = 0;
let finishedAt: number | null = null;
let secret: CardBits[] = [];
let excludedCards = new Set<string>();
let log: LogEntry[] = [];
let guessFeedback = '';
let leaderboard: LeaderboardEntry[] = [];
let personalRecords: LeaderboardEntry[] = [];
let leaderboardMessage = '리더보드를 불러오는 중입니다.';
let leaderboardRequest = 0;
let recordStatus = '';
let recordSubmitted = false;
let recordPending = false;
let currentUsername = '';
let scratchOpen = false;
let personalRecordsOpen = false;

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
    const card = guessing ? 0 : secret[index] ?? 0;
    const shape = SHAPES.find((item) => (card & item.value) !== 0);
    const color = COLORS.find((item) => (card & item.value) !== 0);
    const fill = FILLS.find((item) => (card & item.value) !== 0);
    const selection = (name: string, items: Array<{ label: string; value: number }>, selected: number) =>
      `<label>${name}<select name="${name}-${index}" required><option value="" selected disabled>선택</option>${items
        .map(
          (item) =>
            `<option value="${item.value}"${item.value === selected ? ' selected' : ''}>${item.label}</option>`,
        )
        .join('')}</select></label>`;

    if (guessing) {
      return `
        <article class="guess-card">
          <span class="slot-number">${String(index + 1).padStart(2, '0')}</span>
          ${config.attributes >= 2 ? selection('도형', SHAPES, shape?.value ?? 0) : ''}
          ${selection('색상', COLORS, color?.value ?? 0)}
          ${config.attributes >= 3 ? selection('채움', FILLS, fill?.value ?? 0) : ''}
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
          return `<button type="button" class="candidate ${marked ? 'marked' : ''}" data-scratch="${key}" aria-label="${slot + 1}번 후보 ${item.title}" aria-pressed="${marked}" title="${item.title}">
            <span class="${item.color}">${item.symbol}</span>${item.fill ? `<small>${fillSymbol}</small>` : ''}
          </button>`;
        }).join('')}
      </div>
      <button type="button" class="scratch-clear" data-clear-scratch="${slot}">초기화</button>
    </div>`).join('');
}

function renderSetup(): string {
  return `
    <main class="setup-layout setup-screen">
      <section class="intro setup-intro">
        <div><span class="eyebrow">새 퍼즐</span><h1>어떤 퍼즐에 <span>도전할까요?</span></h1><p>자리와 속성을 선택한 뒤 질문으로 숨겨진 조합을 찾아보세요.</p></div>
      </section>
      <section class="panel setup-panel">
        <div class="panel-heading"><div><span class="eyebrow">퍼즐 설정</span><h2>도전 조건 선택</h2></div><button class="text-button" type="button" data-action="home">리더보드</button></div>
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
          <p class="setup-note">${guestPlay ? '게스트로 플레이합니다. 완료 후 로그인하면 기록을 등록할 수 있습니다.' : '속성은 색상, 도형, 채움 순서로 추가됩니다. 시간 제한 없이 진행할 수 있습니다.'}</p>
          <button class="button primary full" type="submit">이 조건으로 시작 <span>→</span></button>
        </form>
      </section>
      <section class="panel guide-panel">
        <h2>게임 방법</h2>
        <ol>
          <li><strong>질문하기</strong><span>자리·속성·전체 개수에 대해 예/아니요 답변을 받아요.</span></li>
          <li><strong>후보 지우기</strong><span>소거 메모장에서 불가능한 조합을 눌러 표시해요.</span></li>
          <li><strong>정답 제출</strong><span>모든 자리의 속성을 맞히면 완료 기록이 저장돼요.</span></li>
        </ol>
      </section>
    </main>`;
}

function renderLogin(): string {
  const registering = authMode === 'register';
  return `
    <div class="modal-backdrop">
      <section class="auth-modal panel" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <div class="panel-heading"><div><span class="eyebrow">${registering ? '계정 만들기' : '로그인'}</span><h2 id="auth-title">${registering ? '계정을 만드세요' : '계정으로 계속하기'}</h2></div><button class="text-button" type="button" data-action="close-auth">닫기</button></div>
        <p class="setup-note">아이디와 비밀번호로 로그인하면 완료 기록이 자동 등록됩니다.</p>
        <form id="auth-form">
          <label>아이디
            <input name="username" minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="username" placeholder="영문·숫자·밑줄 3~20자" required>
          </label>
          <label>비밀번호
            <input name="password" type="password" minlength="8" maxlength="128" autocomplete="${registering ? 'new-password' : 'current-password'}" placeholder="${registering ? '8~128자' : '비밀번호'}" required>
          </label>
          ${loginError ? `<p class="record-status" role="alert">${escapeHtml(loginError)}</p>` : ''}
          <button class="button primary full" type="submit" ${authBusy ? 'disabled' : ''}>${authBusy ? '처리 중…' : registering ? '계정 만들기' : '로그인'} <span>→</span></button>
        </form>
        <button class="button outline full auth-switch" data-action="switch-auth" ${authBusy ? 'disabled' : ''}>${registering ? '이미 계정이 있나요? 로그인' : '계정이 없나요? 회원가입'}</button>
      </section>
    </div>`;
}

function renderHome(): string {
  return `
    <main class="home-layout">
      <section class="home-main">
        <div class="intro home-intro"><div><span class="eyebrow">ppuljit</span><h1>질문으로 <span>암호를 풀어보세요.</span></h1><p>같은 조건의 플레이어와 질문 횟수·완료 시간을 겨뤄요.</p></div></div>
        ${renderLeaderboard(true)}
      </section>
      <aside class="home-side">
        <section class="panel home-play">
          <span class="eyebrow">새 도전</span>
          <h2>직접 퍼즐을 풀어보세요</h2>
          <p>질문과 소거 메모장으로 정답을 추론하세요. 로그인하거나 게스트로 바로 시작할 수 있어요.</p>
          <button class="button primary full" data-action="play" ${authChecked ? '' : 'disabled'}>게임 하기 <span>→</span></button>
        </section>
        <section class="panel guide-panel">
          <h2>게임 방법</h2>
          <ol>
            <li><strong>질문하기</strong><span>숨겨진 카드에 대해 예/아니요 답변을 받아요.</span></li>
            <li><strong>후보 지우기</strong><span>메모장에서 불가능한 조합을 표시해요.</span></li>
            <li><strong>정답 제출</strong><span>질문 수와 시간이 기록 기준이에요.</span></li>
          </ol>
        </section>
      </aside>
    </main>
    ${playDialogOpen ? `
      <div class="modal-backdrop">
        <section class="choice-modal panel" role="dialog" aria-modal="true" aria-labelledby="play-title">
          <div class="panel-heading"><div><span class="eyebrow">게임 시작</span><h2 id="play-title">어떤 방식으로 플레이할까요?</h2></div><button class="text-button" data-action="close-play">닫기</button></div>
          <p class="setup-note">게스트도 바로 플레이할 수 있습니다. 기록은 로그인 후 자동 등록됩니다.</p>
          <button class="button primary full" data-action="play-login">로그인 또는 회원가입</button>
          <button class="button outline full" data-action="play-guest">게스트로 플레이</button>
        </section>
      </div>` : ''}`;
}

function renderModal(): string {
  if (outcome !== 'victory') return '';
  return `
    <div class="modal-backdrop">
      <section class="result-modal" role="dialog" aria-modal="true" aria-labelledby="result-title">
        <span class="eyebrow">퍼즐 완료</span>
        <h2 id="result-title">암호를 해독했습니다!</h2>
        <p>${config.slots}자리 · 속성 ${config.attributes}개 퍼즐을 완료했습니다.</p>
        <div class="result-stats">
          <span>질문 횟수<strong>${queryCount}회</strong></span>
          <span>경과 시간<strong>${formatTime(elapsedMilliseconds())}</strong></span>
        </div>
        <p class="record-status" role="status">${escapeHtml(recordStatus || (currentUsername ? '기록을 자동 등록하고 있습니다.' : '게스트 기록은 로그인 후 등록할 수 있습니다.'))}</p>
        ${!currentUsername
          ? '<button class="button primary full" data-action="record-login">로그인하고 기록 등록</button>'
          : !recordSubmitted && !recordPending
            ? '<button class="button outline full" data-action="record-retry">기록 다시 등록</button>'
            : ''}
        <button class="button primary full" data-action="restart">새 퍼즐 설정</button>
        <button class="button outline full" data-action="home">리더보드로 돌아가기</button>
      </section>
    </div>`;
}

function renderLeaderboard(showFilters = false): string {
  const entries = leaderboard.length
    ? `<div class="leaderboard-list">${leaderboard.map((record, index) => `
        <div class="leaderboard-entry">
          <span class="leaderboard-rank">${String(index + 1).padStart(2, '0')}</span>
          <span class="leaderboard-name">${escapeHtml(record.nickname)}</span>
          <span class="leaderboard-score">${record.questionCount}회 · ${formatTime(record.elapsedMilliseconds)}</span>
        </div>`).join('')}</div>`
    : `<p class="empty-log">${escapeHtml(leaderboardMessage)}</p>`;
  const owned = personalRecords.length
    ? `<div class="personal-record-list">${personalRecords.map((record) => `
        <div class="leaderboard-entry">
          <span class="personal-date" title="${escapeHtml(record.createdAt)}">${escapeHtml(record.createdAt.slice(5, 16).replace('T', ' '))}</span>
          <span class="leaderboard-score">${record.questionCount}회 · ${formatTime(record.elapsedMilliseconds)}</span>
          <button class="record-delete" data-delete-record="${escapeHtml(record.id)}" aria-label="내 기록 삭제">삭제</button>
        </div>`).join('')}</div>`
    : `<p class="empty-log">${currentUsername ? '이 조건에 등록한 내 기록이 없습니다.' : '로그인하면 내 기록을 확인하고 삭제할 수 있습니다.'}</p>`;
  return `
    <section class="panel leaderboard-panel">
      <div class="panel-heading"><div><span class="eyebrow">리더보드</span><h2>${config.slots}자리 · 속성 ${config.attributes}개</h2></div><span class="log-count">TOP 10</span></div>
      ${showFilters ? `<div class="leaderboard-filters">
        <label>자리 수<select name="leaderboard-slots">${Array.from({ length: 8 }, (_, index) => index + 3).map((value) => `<option value="${value}"${value === config.slots ? ' selected' : ''}>${value}자리</option>`).join('')}</select></label>
        <label>속성 수<select name="leaderboard-attributes">${[1, 2, 3].map((value) => `<option value="${value}"${value === config.attributes ? ' selected' : ''}>${value}개</option>`).join('')}</select></label>
      </div>` : ''}
      ${entries}
      <details class="personal-records" ${personalRecordsOpen ? 'open' : ''}>
        <summary>내 기록 <span>${personalRecords.length}</span></summary>
        ${owned}
      </details>
    </section>`;
}

function renderGame(): string {
  return `
    <main class="layout">
      <section class="game-column">
        <div class="intro">
          <div><span class="eyebrow">게임 진행</span><h1>암호를 <span>해독하세요.</span></h1><p>질문으로 단서를 모으고, 숨겨진 카드 조합을 찾아내세요.</p></div>
          <div class="stage-pill"><span>자리 수</span><strong>${config.slots}<small> 자리</small></strong></div>
        </div>
        <section class="panel board-panel">
          <div class="panel-heading"><div><span class="eyebrow">숨겨진 조합</span><h2>숨겨진 카드</h2></div><span class="slot-count">${config.slots}자리 · 속성 ${config.attributes}개</span></div>
          <div class="secret-row" style="grid-template-columns: repeat(${config.slots}, minmax(0, 1fr))">${renderCards()}</div>
          <div class="board-hint"><span class="live-dot"></span>정답 카드는 질문으로만 확인할 수 있습니다</div>
        </section>
        <section class="panel query-panel">
          <div class="panel-heading"><div><span class="eyebrow">질문</span><h2>무엇을 알아볼까요?</h2></div><span class="query-hint">횟수 제한 없음</span></div>
          <form id="query-form">
            <div class="query-type-row">
              <label class="query-type"><input type="radio" name="kind" value="POSITION_CHECK" checked><span><b>자리 확인</b><small>특정 자리의 속성 찾기</small></span></label>
              <label class="query-type"><input type="radio" name="kind" value="RELATION_EQ"><span><b>속성 비교</b><small>두 자리의 속성 비교</small></span></label>
              <label class="query-type"><input type="radio" name="kind" value="COUNT_COMPARE"><span><b>전체 집계</b><small>조건에 맞는 카드 수</small></span></label>
            </div>
            <div class="query-fields">${renderQueryFields('POSITION_CHECK')}</div>
            <button class="button primary full" type="submit" ${outcome === 'victory' ? 'disabled' : ''}>질문하기 <span>→</span></button>
          </form>
          <div class="answer-feedback ${log.length ? (log[log.length - 1].answer ? 'answer-yes' : 'answer-no') : ''}" aria-live="polite">
            <span>가장 최근 답변</span>
            ${log.length
              ? `<strong>${log[log.length - 1].answer ? '예' : '아니요'}</strong><p>${escapeHtml(log[log.length - 1].text)}</p>`
              : '<strong>질문을 시작해 보세요</strong><p>답변이 여기에 크게 표시됩니다.</p>'}
          </div>
        </section>
        <details class="panel scratch-panel" ${scratchOpen ? 'open' : ''}>
          <summary><span><span class="eyebrow">소거 메모장</span><strong>가능성이 낮은 후보를 표시하세요</strong></span><span class="summary-hint">눌러서 제외 · 취소 가능 <b>＋</b></span></summary>
          <div class="scratch-tools"><span>각 줄은 카드 자리, 각 기호는 속성 조합입니다.</span><button type="button" class="text-button" data-clear-scratch="all">전체 초기화</button></div>
          <div class="scratch-content">${renderScratchpad()}</div>
        </details>
      </section>
      <aside class="side-column">
        <section class="panel hud-panel">
          <div class="panel-heading"><div><span class="eyebrow">진행 현황</span><h2>현재 기록</h2></div><span class="live-dot"></span></div>
          <div class="hud-stats"><span>경과 시간<strong id="timer">${formatTime(elapsedMilliseconds())}</strong></span><span>질문 횟수<strong id="question-count">${queryCount}<small> 회</small></strong></span></div>
          <div class="session-note">시간 제한이 없습니다. 질문 횟수와 완료 시간을 기록합니다.</div>
        </section>
        <section class="panel guess-panel">
          <div class="panel-heading"><div><span class="eyebrow">정답</span><h2>정답 제출</h2></div><span class="guess-icon">⌁</span></div>
          <p class="panel-copy">각 위치의 속성을 선택해 조합을 제출하세요. 오답 제출은 질문 횟수에 포함됩니다.</p>
          <form id="guess-form">
            <div class="guess-grid" style="grid-template-columns: repeat(${config.slots === 3 ? 3 : 2}, minmax(0, 1fr))">${renderCards(true)}</div>
            <button class="button outline full" type="submit" ${outcome === 'victory' ? 'disabled' : ''}>조합 제출 <span>→</span></button>
            ${guessFeedback ? `<p class="guess-feedback">${escapeHtml(guessFeedback)}</p>` : ''}
          </form>
        </section>
        <section class="panel log-panel">
          <div class="panel-heading"><div><span class="eyebrow">질문 기록</span><h2>지금까지의 답변</h2></div><span class="log-count">${String(log.length).padStart(2, '0')}</span></div>
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
      <div class="top-meta">
        ${gameStarted || screen === 'setup' ? '<button class="nav-button" data-action="home">리더보드</button>' : ''}
        ${loginError ? `<span class="header-error" role="alert">${escapeHtml(loginError)}</span>` : ''}
        ${currentUsername
          ? `<span class="user-chip">${escapeHtml(currentUsername)}</span><button class="logout-button" data-action="logout">로그아웃</button>`
          : authChecked
            ? '<button class="nav-button" data-action="open-auth">로그인</button>'
            : '<span class="user-chip">계정 확인 중</span>'}
        ${gameStarted ? '<button class="icon-button" data-action="share" aria-label="결과 공유" title="결과 공유">↗</button>' : ''}
      </div>
    </header>
    ${gameStarted ? renderGame() : screen === 'setup' ? renderSetup() : renderHome()}
    ${authDialogOpen ? renderLogin() : ''}`;
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
  personalRecords = [];
  leaderboardMessage = '리더보드를 불러오는 중입니다.';
  recordStatus = '';
  recordSubmitted = false;
  recordPending = false;
  scratchOpen = false;
  render();
  void loadLeaderboard();
}

async function submitRecord(): Promise<void> {
  if (outcome !== 'victory' || !currentUsername || recordPending || recordSubmitted) return;
  recordPending = true;
  recordStatus = '리더보드에 기록을 등록하고 있습니다.';
  render();
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
    recordStatus = '리더보드에 기록을 등록했습니다.';
    await loadLeaderboard();
  } catch (error) {
    console.error('리더보드 기록을 등록하지 못했습니다.', error);
    recordStatus = error instanceof Error ? error.message : '기록 등록에 실패했습니다.';
  } finally {
    recordPending = false;
    render();
  }
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
    let submitAfterAuth = false;
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
      guestPlay = false;
      authDialogOpen = false;
      if (authIntent === 'start') screen = 'setup';
      submitAfterAuth = authIntent === 'record' && outcome === 'victory';
      loginError = '';
    } catch (error) {
      console.error('계정 요청을 처리하지 못했습니다.', error);
      loginError = error instanceof Error ? error.message : '계정 요청을 처리하지 못했습니다.';
    } finally {
      authBusy = false;
      render();
      if (submitAfterAuth) void submitRecord();
      else void loadLeaderboard();
    }
  });

  root.querySelector<HTMLButtonElement>('[data-action="switch-auth"]')?.addEventListener('click', () => {
    authMode = authMode === 'register' ? 'login' : 'register';
    loginError = '';
    render();
  });

  root.querySelector<HTMLButtonElement>('[data-action="open-auth"]')?.addEventListener('click', () => {
    authIntent = 'stay';
    authDialogOpen = true;
    authMode = 'login';
    loginError = '';
    render();
  });
  root.querySelector<HTMLButtonElement>('[data-action="close-auth"]')?.addEventListener('click', () => {
    authDialogOpen = false;
    loginError = '';
    render();
  });
  root.querySelector<HTMLButtonElement>('[data-action="play"]')?.addEventListener('click', () => {
    if (currentUsername) {
      screen = 'setup';
      guestPlay = false;
    } else {
      playDialogOpen = true;
    }
    render();
  });
  root.querySelector<HTMLButtonElement>('[data-action="close-play"]')?.addEventListener('click', () => {
    playDialogOpen = false;
    render();
  });
  root.querySelector<HTMLButtonElement>('[data-action="play-login"]')?.addEventListener('click', () => {
    playDialogOpen = false;
    authDialogOpen = true;
    authIntent = 'start';
    authMode = 'login';
    loginError = '';
    render();
  });
  root.querySelector<HTMLButtonElement>('[data-action="play-guest"]')?.addEventListener('click', () => {
    playDialogOpen = false;
    guestPlay = true;
    screen = 'setup';
    render();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-action="home"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (gameStarted && outcome === 'playing' && !window.confirm('진행 중인 퍼즐을 나가면 기록되지 않습니다. 리더보드로 돌아갈까요?')) {
        return;
      }
      gameStarted = false;
      screen = 'home';
      playDialogOpen = false;
      authDialogOpen = false;
      outcome = 'playing';
      guestPlay = false;
      const url = new URL(window.location.href);
      url.searchParams.delete('seed');
      url.searchParams.delete('slots');
      url.searchParams.delete('attributes');
      window.history.replaceState(null, '', url);
      render();
      void loadLeaderboard();
    });
  });

  root.querySelectorAll<HTMLSelectElement>('[name="leaderboard-slots"], [name="leaderboard-attributes"]').forEach((select) => {
    select.addEventListener('change', () => {
      if (select.name === 'leaderboard-slots') config.slots = Number(select.value);
      else config.attributes = Number(select.value);
      leaderboard = [];
      personalRecords = [];
      leaderboardMessage = '리더보드를 불러오는 중입니다.';
      render();
      void loadLeaderboard();
    });
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
    scratchOpen = root.querySelector<HTMLDetailsElement>('.scratch-panel')?.open ?? false;
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
      recordStatus = currentUsername ? '' : '게스트 완료 기록은 로그인 후 등록할 수 있습니다.';
    } else {
      queryCount += 1;
      log.push({ text: '정답 조합 오답 제출', answer: false });
      guessFeedback = '정답이 아닙니다. 단서를 더 모아보세요.';
    }
    render();
    if (outcome === 'victory' && currentUsername) void submitRecord();
  });

  root.querySelector<HTMLDetailsElement>('.scratch-panel')?.addEventListener('toggle', (event) => {
    scratchOpen = (event.currentTarget as HTMLDetailsElement).open;
  });
  root.querySelector<HTMLDetailsElement>('.personal-records')?.addEventListener('toggle', (event) => {
    personalRecordsOpen = (event.currentTarget as HTMLDetailsElement).open;
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
  root.querySelectorAll<HTMLButtonElement>('[data-clear-scratch]').forEach((button) => {
    button.addEventListener('click', () => {
      const slot = button.dataset.clearScratch;
      for (const key of excludedCards) {
        if (slot === 'all' || key.startsWith(`${slot}:`)) excludedCards.delete(key);
      }
      root.querySelectorAll<HTMLButtonElement>('[data-scratch]').forEach((candidate) => {
        const marked = excludedCards.has(candidate.dataset.scratch ?? '');
        candidate.classList.toggle('marked', marked);
        candidate.setAttribute('aria-pressed', String(marked));
      });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-delete-record]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.deleteRecord;
      if (!id || !window.confirm('이 리더보드 기록을 삭제할까요?')) return;
      try {
        const response = await fetch(`/api/records?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!response.ok) {
          const body: unknown = response.headers.get('content-type')?.includes('application/json')
            ? await response.json()
            : null;
          const message =
            typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
              ? body.error
              : '기록을 삭제하지 못했습니다.';
          throw new Error(message);
        }
        await loadLeaderboard();
      } catch (error) {
        console.error('리더보드 기록을 삭제하지 못했습니다.', error);
        window.alert(error instanceof Error ? error.message : '기록을 삭제하지 못했습니다.');
      }
    });
  });
  root.querySelector<HTMLButtonElement>('[data-action="record-login"]')?.addEventListener('click', () => {
    authIntent = 'record';
    authDialogOpen = true;
    authMode = 'login';
    loginError = '';
    render();
  });
  root.querySelector<HTMLButtonElement>('[data-action="record-retry"]')?.addEventListener('click', () => {
    void submitRecord();
  });

  root.querySelectorAll<HTMLButtonElement>('[data-action="restart"]').forEach((button) => {
    button.addEventListener('click', () => {
      gameStarted = false;
      outcome = 'playing';
      screen = 'setup';
      seed = randomSeed();
      const url = new URL(window.location.href);
      url.searchParams.delete('seed');
      url.searchParams.delete('slots');
      url.searchParams.delete('attributes');
      window.history.replaceState(null, '', url);
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
      screen = 'home';
      outcome = 'playing';
      guestPlay = false;
      queryCount = 0;
      startedAt = 0;
      finishedAt = null;
      secret = [];
      log = [];
      excludedCards = new Set();
      recordStatus = '';
      recordSubmitted = false;
      recordPending = false;
      loginError = '';
      render();
      void loadLeaderboard();
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
    typeof record.id === 'string' &&
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
  const requestId = ++leaderboardRequest;
  const requestedConfig = { ...config };
  try {
    const search = new URLSearchParams({
      slots: String(requestedConfig.slots),
      attributes: String(requestedConfig.attributes),
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
      !payload.records.every(isLeaderboardEntry) ||
      !('personalRecords' in payload) ||
      !Array.isArray(payload.personalRecords) ||
      !payload.personalRecords.every(isLeaderboardEntry)
    ) {
      throw new Error('리더보드 응답 형식이 올바르지 않습니다.');
    }
    if (requestId !== leaderboardRequest) return;
    leaderboard = payload.records;
    personalRecords = payload.personalRecords;
    leaderboardMessage = leaderboard.length ? '' : '아직 등록된 기록이 없습니다.';
  } catch (error) {
    if (requestId !== leaderboardRequest) return;
    console.error('리더보드를 불러오지 못했습니다.', error);
    leaderboard = [];
    personalRecords = [];
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
    void loadLeaderboard();
  }
}

window.setInterval(() => {
  const timer = root.querySelector<HTMLElement>('#timer');
  if (timer && outcome === 'playing') timer.textContent = formatTime(elapsedMilliseconds());
}, 100);

render();
void restoreSession();
