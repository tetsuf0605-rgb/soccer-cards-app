/**
 * 製品（チェックリスト）とGBの画面。
 *
 *   一覧      … checklists/ と gb/ のファイル名を並べる（起動時に取った一覧）
 *   製品ビュー … チェックリスト閲覧＋所持照合（写真判定運用仕様 §7-3・スキーマ仕様 §10）
 *   GBビュー  … ブレイクのスポットと、そこで引いたカード（同 §9-4）
 *
 * 中身は開いたときに個別GETする（保存同期方式仕様 §4）。大型製品のチェックリストを
 * 起動ごとに引かないため。取得と localStorage への取り置きは呼び出し側（app.js）。
 *
 * 照合・解釈の純粋ロジックは checklist.js / gb.js が持ち、ここは描画と操作だけ。
 */
import { el, setMessage, formatFeature, priceLine } from './render.js';
import {
  MATCH_STATUS,
  applicableVariations,
  denominatorLabel,
  kindLabel,
  matchChecklist,
  parallelsClipboardText,
  readChecklist,
  statusLabel,
} from './checklist.js';
import {
  assignCardsToSpots, cardKindLabel, formatLabel, gbStatusLabel,
  readGb, spotTeams, spotTypeLabel, targetsInBreak,
} from './gb.js';
import { readTargets, teamLabel } from './refdata.js';

const TABS = [
  { id: 'checklists', label: '製品' },
  { id: 'gb', label: 'GB' },
];

const els = {
  tabs: document.getElementById('library-tabs'),
  message: document.getElementById('library-message'),
  list: document.getElementById('library-list'),

  checklistHead: document.getElementById('checklist-head'),
  copyParallels: document.getElementById('btn-copy-parallels'),
  copyMessage: document.getElementById('checklist-copy-message'),
  checklistFilters: document.getElementById('checklist-filters'),
  checklistMessage: document.getElementById('checklist-message'),
  checklistCards: document.getElementById('checklist-cards'),

  gbHead: document.getElementById('gb-head'),
  gbBody: document.getElementById('gb-body'),
  gbMessage: document.getElementById('gb-message'),
};

/** 製品名などの見出し1行（ラベル＋値）。 */
function kv(dl, label, value) {
  if (value === null || value === undefined || value === '') return;
  dl.append(el('dt', null, label));
  dl.append(el('dd', null, String(value)));
}

function statusBadge(status) {
  return el('span', `badge badge--status badge--${status}`, statusLabel(status));
}

/**
 * @param {{
 *   getRefs: () => object,
 *   getRows: () => Array,
 *   getTargets: () => object|null,
 *   getTeamIndex: () => object,
 *   loadChecklist: (productKey: string) => Promise<object>,
 *   loadGb: (breakId: string) => Promise<object>,
 *   showView: (name: string) => void,
 *   onRegister: (checklist: object, row: object, variation: string) => void,
 *   onOpenCard: (cardId: string) => void,
 *   canWrite: () => boolean,
 * }} deps
 */
export function createLibrary(deps) {
  const state = {
    tab: 'checklists',
    /** 開いている製品（readChecklist の結果） */
    checklist: null,
    /** 開いているGB（readGb の結果） */
    gb: null,
    /** そのGBの製品のチェックリスト（狙い選手に何が出るかを出すため。無いこともある） */
    gbChecklist: null,
    /** 所持照合の区分フィルタ。空なら全部出す */
    statuses: [],
    /** 展開している行の cardNo */
    expanded: null,
    busy: false,
  };

  /* ===== 一覧 ===== */

  function renderTabs() {
    els.tabs.replaceChildren(...TABS.map((tab) => {
      const button = el('button', 'segmented__item', tab.label);
      button.type = 'button';
      button.dataset.tab = tab.id;
      button.setAttribute('aria-pressed', String(state.tab === tab.id));
      return button;
    }));
  }

  function renderList() {
    const refs = deps.getRefs();
    const entries = state.tab === 'gb' ? (refs.gb ?? []) : (refs.checklists ?? []);
    const what = state.tab === 'gb' ? 'GB' : '製品';

    els.list.replaceChildren(...entries.map((entry) => {
      const li = el('li');
      const button = el('button', 'library__item');
      button.type = 'button';
      button.dataset.key = entry.key;
      button.append(el('span', 'library__key', entry.key));
      button.append(el('span', 'library__meta', `${(entry.size ?? 0).toLocaleString('ja-JP')} B`));
      li.append(button);
      return li;
    }));

    if (entries.length === 0) {
      setMessage(els.message, state.busy
        ? '読み込み中…'
        : `${what}はまだありません（${state.tab === 'gb' ? 'gb/' : 'checklists/'} が未作成）。`
          + 'PCの dev/ スクリプトで作ると、ここに出ます。');
    } else {
      setMessage(els.message, `${entries.length}件`);
    }
  }

  function render() {
    renderTabs();
    renderList();
  }

  function open() {
    setMessage(els.copyMessage, '');
    render();
    deps.showView('library');
  }

  /* ===== 製品ビュー（チェックリスト閲覧＋所持照合） ===== */

  function renderChecklistHead() {
    const checklist = state.checklist;
    const head = el('div', 'detail__head');
    head.append(el('h2', 'detail__name', checklist.series || checklist.productKey));
    head.append(el('p', 'detail__name-en', [checklist.maker, checklist.season].filter(Boolean).join('・')));

    const badges = el('div', 'badges');
    badges.append(el('span', 'badge', `パラレル ${checklist.variations.length}種`));
    badges.append(el('span', 'badge', `カード ${checklist.cards.length}件`));
    badges.append(el('span', 'badge', `網羅 ${checklist.coverage} / ${checklist.cardsCoverage}`));
    if (checklist.confirmedAt) badges.append(el('span', 'badge', `確認 ${checklist.confirmedAt}`));

    const root = el('div');
    root.append(head, badges);

    if (checklist.sources.length > 0) {
      const list = el('ul', 'sources');
      for (const source of checklist.sources) {
        const item = el('li');
        const link = el('a', null, source);
        link.href = source;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        item.append(link);
        list.append(item);
      }
      root.append(el('h3', 'section-title', '出典'), list);
    }

    // パラレル一覧（判定チャットに貼るのはコピーボタン。ここは目で見る用）
    root.append(el('h3', 'section-title', 'パラレル'));
    const variations = el('ul', 'variations');
    for (const variation of checklist.variations) {
      const item = el('li', 'variations__item');
      // 限定版（Hobby / Asia 等）があれば名前に添える（写真判定運用仕様 §3-3）
      item.append(el('span', 'variations__name',
        variation.exclusive ? `${variation.name}（${variation.exclusive}）` : variation.name));
      item.append(el('span', 'variations__meta', denominatorLabel(variation.denominator)));
      variations.append(item);
    }
    if (checklist.variations.length === 0) {
      variations.append(el('li', 'hint', 'パラレルが登録されていません。'));
    }
    root.append(variations);

    els.checklistHead.replaceChildren(root);
  }

  /** 区分フィルタのチップ（件数つき）。 */
  function renderChecklistFilters(counts) {
    els.checklistFilters.replaceChildren(...MATCH_STATUS.map((status) => {
      const button = el('button', 'chip');
      button.type = 'button';
      button.dataset.status = status;
      button.setAttribute('aria-pressed', String(state.statuses.includes(status)));
      button.append(el('span', null, statusLabel(status)));
      button.append(el('span', 'chip__count', String(counts[status] ?? 0)));
      return button;
    }));
  }

  /** 1行ぶんのパラレル明細（展開したときだけ作る）。 */
  function buildParallels(entry) {
    const body = el('div', 'cl-row__body');
    const writable = deps.canWrite();

    if (entry.match.byVariation.length === 0) {
      body.append(el('p', 'hint', 'この行にパラレルが登録されていません（チェックリスト側の未整備）。'));
    }

    for (const variation of entry.match.byVariation) {
      const line = el('div', 'cl-par');
      line.append(el('span', 'cl-par__name', variation.name));
      line.append(statusBadge(variation.status));

      if (variation.rows.length > 0) {
        // 所持しているパラレルは、そのカードの詳細へ飛べるようにする
        for (const row of variation.rows) {
          const open = el('button', 'btn btn--ghost cl-par__btn', priceLine(row.card).text);
          open.type = 'button';
          open.dataset.cardId = row.card.id;
          line.append(open);
        }
      } else if (writable) {
        const register = el('button', 'btn btn--ghost cl-par__btn', 'このカードを登録');
        register.type = 'button';
        register.dataset.register = entry.row.cardNo;
        register.dataset.variation = variation.name;
        line.append(register);
      }
      body.append(line);
    }

    if (!writable) {
      body.append(el('p', 'hint', '登録はオンラインで再読込してからになります。'));
    }
    return body;
  }

  function buildChecklistRow(entry) {
    const { row, match } = entry;
    const li = el('li', 'cl-row');

    const head = el('button', 'cl-row__head');
    head.type = 'button';
    head.dataset.cardNo = row.cardNo;
    head.setAttribute('aria-expanded', String(state.expanded === row.cardNo));

    const top = el('div', 'cl-row__top');
    top.append(el('span', 'cl-row__no', row.cardNo));
    top.append(el('span', 'cl-row__name', row.nameEn));
    top.append(statusBadge(match.status));
    head.append(top);

    head.append(el('p', 'cl-row__meta', [
      row.team,
      kindLabel(row.kind),
      (row.features ?? []).map(formatFeature).join('・') || null,
      `パラレル ${applicableVariations(state.checklist, row).length}種`,
    ].filter(Boolean).join('・')));

    if (Array.isArray(row.nameEnOthers) && row.nameEnOthers.length > 0) {
      head.append(el('p', 'cl-row__meta', `他の選手: ${row.nameEnOthers.join(' / ')}`));
    }
    if (match.nameMismatch) {
      head.append(el('p', 'cl-row__warn', '同じ番号で名前が違うカードを持っています（データ品質の確認を）'));
    }
    li.append(head);

    if (state.expanded === row.cardNo) li.append(buildParallels(entry));
    return li;
  }

  function renderChecklistCards() {
    const { entries, counts } = matchChecklist(state.checklist, deps.getRows());
    renderChecklistFilters(counts);

    const shown = state.statuses.length === 0
      ? entries
      : entries.filter((entry) => state.statuses.includes(entry.match.status));

    els.checklistCards.replaceChildren(...shown.map(buildChecklistRow));

    if (state.checklist.cards.length === 0) {
      setMessage(els.checklistMessage,
        'この製品はカード一覧（cards[]）を持っていません。パラレル一覧のコピーだけ使えます。');
    } else if (shown.length === 0) {
      setMessage(els.checklistMessage, 'この区分に当てはまるカードはありません。');
    } else {
      const owned = counts.owned + counts.otherParallel + counts.candidate;
      setMessage(els.checklistMessage,
        `${shown.length}件 / 全${entries.length}件（何かしら持っている: ${owned}件）`);
    }
  }

  function renderChecklist() {
    renderChecklistHead();
    renderChecklistCards();
  }

  async function openChecklist(productKey) {
    setMessage(els.message, `${productKey} を読み込み中…`);
    try {
      const json = await deps.loadChecklist(productKey);
      state.checklist = readChecklist(json);
      state.statuses = [];
      state.expanded = null;
      setMessage(els.message, '');
      setMessage(els.copyMessage, '');
      renderChecklist();
      deps.showView('checklist');
    } catch (error) {
      setMessage(els.message, error.message, 'error');
    }
  }

  async function copyParallels() {
    if (!state.checklist) return;
    const text = parallelsClipboardText(state.checklist);
    try {
      await navigator.clipboard.writeText(text);
      setMessage(els.copyMessage,
        `パラレル${state.checklist.variations.length}種をコピーしました。判定チャットの冒頭に貼ってください。`, 'ok');
    } catch {
      setMessage(els.copyMessage,
        'クリップボードに書けませんでした。長押しで選択してコピーしてください。', 'error');
    }
  }

  /* ===== GBビュー ===== */

  function buildSpot(entry, index, targetHits) {
    const { spot, rows } = entry;
    const section = el('div', 'spot');

    const head = el('div', 'spot__head');
    head.append(el('span', 'spot__name', spot.name));
    if (typeof spot.priceYen === 'number') {
      head.append(el('span', 'spot__price', `¥${spot.priceYen.toLocaleString('ja-JP')}`));
    }
    section.append(head);
    section.append(el('p', 'spot__meta', [spotTypeLabel(spot.type), spot.spotId].filter(Boolean).join('・')));

    // このスポットで狙い選手が出るなら、スポットを眺めているときに分かるようにする
    const wanted = (targetHits ?? []).filter((hit) => hit.spots.includes(spot));
    if (wanted.length > 0) {
      const line = el('p', 'spot__targets');
      line.append(el('span', 'badge badge--target', '狙い'));
      line.append(el('span', null, wanted
        .map((hit) => `${hit.target.name || hit.target.nameEn}${hit.ambiguous ? '（候補）' : ''}`)
        .join(' / ')));
      section.append(line);
    }

    const teams = spotTeams(index, spot);
    if (teams.length > 0) {
      const chips = el('div', 'chips');
      for (const team of teams) {
        chips.append(el('span', `badge${team.known ? '' : ' badge--unknown'}`, team.label));
      }
      section.append(chips);
    }

    if (spot.playersEn.length > 0) {
      section.append(el('p', 'spot__players', spot.playersEn.join(' / ')));
    }

    if (rows.length > 0) {
      section.append(el('h4', 'spot__sub', `このスポットのカード（${rows.length}枚）`));
      const list = el('ul', 'spot__cards');
      for (const row of rows) {
        const item = el('li');
        const button = el('button', 'btn btn--ghost spot__card');
        button.type = 'button';
        button.dataset.cardId = row.card.id;
        button.textContent = [row.player?.name ?? row.card.id, row.card.variation].filter(Boolean).join('・');
        item.append(button);
        list.append(item);
      }
      section.append(list);
    }
    return section;
  }

  /** 出るカードの一行（「オート 1種（CA-LMA）・シリアルあり 58種 /250〜/1」）。 */
  function kindLine(kind) {
    const nos = kind.cardNos.slice(0, 3).join(', ') + (kind.cardNos.length > 3 ? ' ほか' : '');
    let serial = 'シリアルなし';
    if (kind.serial > 0) {
      // 分母は幅で出す。どのラダーにも 1/1 があるので最少だけでは差が出ない
      const range = kind.max === kind.min ? `/${kind.min}` : `/${kind.max}〜/${kind.min}`;
      serial = `シリアルあり ${kind.serial}種 ${range}`;
    }
    return `${cardKindLabel(kind.kind)} ${kind.count}種（${nos}）・${serial}`;
  }

  /**
   * 「狙い選手がどのスポットから出るか」（GBを買うときの判断材料）。
   * チェックリストが無いと出るカードまでは分からないので、その旨を出す。
   */
  function buildTargets(hits) {
    const section = el('div');
    section.append(el('h3', 'section-title', '狙い選手'));

    const targets = readTargets(deps.getTargets());
    if (targets.length === 0) {
      section.append(el('p', 'hint', '狙い選手が登録されていません（ヘッダーの「★」から追加できます）。'));
      return section;
    }
    if (hits.length === 0) {
      section.append(el('p', 'hint',
        `登録済みの狙い選手${targets.length}人は、このGBのスポットには見当たりません。`));
      section.append(targetsCaveat(targets, hits));
      return section;
    }

    const list = el('ul', 'targets');
    for (const hit of hits) {
      const li = el('li', 'target');
      const body = el('div', 'target__body');
      body.append(el('p', 'target__name', hit.target.name || hit.target.nameEn));
      body.append(el('p', 'target__name-en', hit.target.nameEn));

      for (const spot of hit.spots) {
        const line = el('p', 'target__spot');
        line.append(el('span', 'target__spot-name', spot.name));
        if (typeof spot.priceYen === 'number') {
          line.append(el('span', 'target__spot-price', `¥${spot.priceYen.toLocaleString('ja-JP')}`));
        }
        body.append(line);
      }
      if (hit.ambiguous) {
        body.append(el('p', 'cl-row__warn',
          'このチームは複数のスポットに分かれていて、名指しがないのでどれに入るかは分かりません。'));
      }

      if (hit.kinds.length > 0) {
        const kinds = el('ul', 'target__kinds');
        for (const kind of hit.kinds) kinds.append(el('li', null, kindLine(kind)));
        body.append(kinds);
      } else if (!state.gbChecklist) {
        body.append(el('p', 'hint', 'チェックリストが無いので、出るカードは分かりません。'));
      } else {
        body.append(el('p', 'hint', 'この製品のチェックリストにこの選手のカードがありません。'));
      }

      li.append(body);
      list.append(li);
    }
    section.append(list);
    section.append(targetsCaveat(targets, hits));
    return section;
  }

  /**
   * ここに出なかった狙い選手について、「出ない」と言い切れるかを書く。
   *
   * 判定の根拠はスポットの名指しとチェックリストの cards[] だけ（現所属は使わない。
   * 古い製品では所属が当時と違い、players_info の currentTeam 自体が誤っている例もある）。
   * cards[] が未完成なら「出ない」とは言えないので、そう書く。
   */
  function targetsCaveat(targets, hits) {
    const rest = targets.length - hits.length;
    if (rest <= 0) return el('span', null, '');

    // 1人も出ていないときは直前の行が人数を言っているので、ここでは繰り返さない
    const who = hits.length === 0 ? '' : `残りの狙い選手${rest}人`;

    const checklist = state.gbChecklist;
    if (!checklist) {
      return el('p', 'hint',
        `この製品のチェックリストが無いので、${who ? `${who}は` : ''}`
        + 'スポットの名指しだけで見ています（名指しが無ければ判定できません）。');
    }
    if (checklist.cardsCoverage !== 'full') {
      return el('p', 'hint',
        `チェックリストのカード一覧が未完成（${checklist.cardsCoverage}）なので、`
        + `${who ? `${who}が` : ''}出ないとは言い切れません。`);
    }
    return el('p', 'hint', `${who || '狙い選手'}のカードは、この製品にはありません。`);
  }

  function renderGb() {
    const gb = state.gb;
    const index = deps.getTeamIndex();

    const head = el('div', 'detail__head');
    head.append(el('h2', 'detail__name', gb.breaker || gb.breakId));
    head.append(el('p', 'detail__name-en', gb.breakId));

    const dl = el('dl', 'kv');
    kv(dl, '開催日', gb.date);
    kv(dl, '形式', formatLabel(gb.format));
    kv(dl, '箱数', gb.boxes);
    kv(dl, '状態', gbStatusLabel(gb.status));
    kv(dl, '製品', gb.productKey);
    kv(dl, '評価レポート', gb.evalReport);

    const root = el('div');
    root.append(head, dl);
    root.append(el('p', 'hint',
      '期待値や確率はここには持ちません（FCGBのレポートが正。スキーマ仕様 §9-4）。'));
    els.gbHead.replaceChildren(root);

    const { spots, cards, unassigned } = assignCardsToSpots(gb, index, deps.getRows());
    const targetHits = targetsInBreak(
      gb, state.gbChecklist, readTargets(deps.getTargets()), index,
    );

    const body = el('div');
    const known = deps.getRefs().checklists?.some((entry) => entry.key === gb.productKey);
    if (known) {
      const link = el('button', 'btn', 'この製品のチェックリストを開く');
      link.type = 'button';
      link.dataset.productKey = gb.productKey;
      const actions = el('div', 'actions');
      actions.append(link);
      body.append(actions);
    }

    body.append(buildTargets(targetHits));

    body.append(el('h3', 'section-title', `スポット（${spots.length}件）`));
    for (const entry of spots) body.append(buildSpot(entry, index, targetHits));

    if (unassigned.length > 0) {
      body.append(el('h3', 'section-title', `スポットに結び付かなかったカード（${unassigned.length}枚）`));
      body.append(el('p', 'hint',
        'gbRef はブレイク単位なので、スポットへの割り当てはチーム・選手名からの推測です。'));
      const list = el('ul', 'spot__cards');
      for (const row of unassigned) {
        const item = el('li');
        const button = el('button', 'btn btn--ghost spot__card');
        button.type = 'button';
        button.dataset.cardId = row.card.id;
        button.textContent = [row.player?.name ?? row.card.id, row.card.variation].filter(Boolean).join('・');
        item.append(button);
        list.append(item);
      }
      body.append(list);
    }

    els.gbBody.replaceChildren(body);
    setMessage(els.gbMessage, cards.length === 0
      ? 'このGBで入手したカードはまだ登録されていません（取り込み時に「GBで入手した」で選ぶと結び付きます）。'
      : `このGBのカード: ${cards.length}枚`);
  }

  async function openGb(breakId) {
    setMessage(els.message, `${breakId} を読み込み中…`);
    try {
      const json = await deps.loadGb(breakId);
      state.gb = readGb(json);

      // 狙い選手に「何が出るか」を出すには、その製品のチェックリストが要る。
      // 取れなくてもスポットは出せるので、失敗は握って進む
      state.gbChecklist = null;
      const known = deps.getRefs().checklists?.some((entry) => entry.key === state.gb.productKey);
      if (known) {
        try {
          state.gbChecklist = readChecklist(await deps.loadChecklist(state.gb.productKey));
        } catch {
          state.gbChecklist = null;
        }
      }

      setMessage(els.message, '');
      renderGb();
      deps.showView('gb');
    } catch (error) {
      setMessage(els.message, error.message, 'error');
    }
  }

  /* ===== 書き込みのあとに呼ぶ ===== */

  /** 台帳が変わったら、開いている画面の照合をやり直す。 */
  function refresh() {
    if (state.checklist && !document.getElementById('view-checklist').hidden) renderChecklistCards();
    if (state.gb && !document.getElementById('view-gb').hidden) renderGb();
  }

  /** いま開いている製品（チェックリスト登録の保存先を決めるのに使う）。 */
  function currentChecklist() {
    return state.checklist;
  }

  function backToChecklist(note) {
    if (!state.checklist) {
      open();
      return;
    }
    renderChecklist();
    deps.showView('checklist');
    if (note) setMessage(els.checklistMessage, note, 'ok');
  }

  /* ===== イベント ===== */

  els.tabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    state.tab = button.dataset.tab;
    render();
  });

  els.list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-key]');
    if (!button) return;
    if (state.tab === 'gb') openGb(button.dataset.key);
    else openChecklist(button.dataset.key);
  });

  els.copyParallels.addEventListener('click', copyParallels);

  els.checklistFilters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    const status = button.dataset.status;
    state.statuses = state.statuses.includes(status)
      ? state.statuses.filter((item) => item !== status)
      : [...state.statuses, status];
    renderChecklistCards();
  });

  els.checklistCards.addEventListener('click', (event) => {
    const card = event.target.closest('[data-card-id]');
    if (card) {
      deps.onOpenCard(card.dataset.cardId);
      return;
    }

    const register = event.target.closest('[data-register]');
    if (register) {
      const row = state.checklist.cards.find((item) => item.cardNo === register.dataset.register);
      if (row) deps.onRegister(state.checklist, row, register.dataset.variation);
      return;
    }

    const head = event.target.closest('[data-card-no]');
    if (head) {
      state.expanded = state.expanded === head.dataset.cardNo ? null : head.dataset.cardNo;
      renderChecklistCards();
    }
  });

  els.gbBody.addEventListener('click', (event) => {
    const card = event.target.closest('[data-card-id]');
    if (card) {
      deps.onOpenCard(card.dataset.cardId);
      return;
    }
    const product = event.target.closest('[data-product-key]');
    if (product) openChecklist(product.dataset.productKey);
  });

  return { open, refresh, currentChecklist, backToChecklist };
}
