/**
 * チップ絞り込みのUI（スキーマ仕様 §1「ボタン式絞り込み（チップ）」）。
 *
 * 区分と判定条件は query.js の CHIP_GROUPS が持つ。ここはその描画と、
 * チームの選び方だけを担う。絞り込みの状態（filters）は呼び出し側が持ち、
 * 変更は onChange で返す。
 *
 * チームは teams.json に159件あり、所持カードに出てくるものだけでも100件を
 * 超える。全部チップで並べるとiPhoneでは探せないので、
 *   - 所持枚数の多い上位だけをチップに出す（選択中のチームは必ず残す）
 *   - それ以外は「チームを選ぶ」の検索シートから選ぶ
 * の2段にしている。
 */
import { el } from './render.js';
import { CHIP_GROUPS, hasActiveFilters } from './query.js';
import { TEAM_MODES, teamFacets, searchTeamFacets, teamLabel } from './refdata.js';

/** チップに出す上位チーム数。これより下は検索シートから選ぶ。 */
const TOP_TEAM_CHIPS = 8;

/** 検索シートに一度に出す件数（iPhoneで延々スクロールさせない）。 */
const SHEET_LIMIT = 40;

const els = {
  panel: document.getElementById('filter-panel'),
  toggle: document.getElementById('btn-filters'),
  groups: document.getElementById('filter-groups'),
  teamModes: document.getElementById('filter-team-modes'),
  teamChips: document.getElementById('filter-team-chips'),
  teamNote: document.getElementById('filter-team-note'),
  pick: document.getElementById('btn-team-pick'),
  reset: document.getElementById('btn-filter-reset'),
  sheet: document.getElementById('team-sheet'),
  sheetSearch: document.getElementById('team-sheet-search'),
  sheetList: document.getElementById('team-sheet-list'),
  sheetClose: document.getElementById('btn-team-sheet-close'),
};

/** トグルボタン1つ。押されている状態は aria-pressed で持つ（CSSもこれを見る）。 */
function chip(label, pressed, dataset, count) {
  const button = el('button', 'chip');
  button.type = 'button';
  button.setAttribute('aria-pressed', String(pressed));
  Object.assign(button.dataset, dataset);
  button.append(el('span', null, label));
  if (typeof count === 'number') button.append(el('span', 'chip__count', String(count)));
  return button;
}

/**
 * @param {{
 *   getFilters: () => object,
 *   getTeamIndex: () => object,
 *   getFacetRows: () => Array,
 *   onChange: (filters: object) => void,
 *   onReset: () => void,
 * }} deps
 */
export function createFilterBar(deps) {
  /** 検索シートの絞り込み語（開いている間だけ保持）。 */
  let sheetQuery = '';

  function filters() {
    return deps.getFilters();
  }

  /** 1区分の選択を入れ替える（同一区分内はOR。選択を空にすると条件なし）。 */
  function toggleValue(groupId, value) {
    const current = filters()[groupId] ?? [];
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    deps.onChange({ ...filters(), [groupId]: next });
  }

  function toggleTeam(teamId) {
    const current = filters().teams ?? [];
    const next = current.includes(teamId)
      ? current.filter((item) => item !== teamId)
      : [...current, teamId];
    deps.onChange({ ...filters(), teams: next });
  }

  /* ===== 描画 ===== */

  function renderGroups() {
    const state = filters();
    els.groups.replaceChildren(...CHIP_GROUPS.map((group) => {
      const row = el('div', 'filters__row');
      row.append(el('span', 'filters__label', group.label));
      const list = el('div', 'chips');
      const selected = state[group.id] ?? [];
      for (const option of group.options) {
        list.append(chip(option.label, selected.includes(option.value), {
          group: group.id,
          value: option.value,
        }));
      }
      row.append(list);
      return row;
    }));
  }

  function renderTeamModes() {
    const state = filters();
    els.teamModes.replaceChildren(...TEAM_MODES.map((mode) => {
      const button = el('button', 'segmented__item', mode.label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(state.teamMode === mode.id));
      button.title = mode.hint;
      button.dataset.teamMode = mode.id;
      return button;
    }));
  }

  /** チップに出すチーム: 上位 + 選択中（選択中が下位でも消えないように）。 */
  function visibleFacets(facets) {
    const selected = filters().teams ?? [];
    const top = facets.slice(0, TOP_TEAM_CHIPS);
    const shownIds = new Set(top.map(({ team }) => team.id));
    const extra = facets.filter(({ team }) => selected.includes(team.id) && !shownIds.has(team.id));
    return [...top, ...extra];
  }

  function renderTeams() {
    const index = deps.getTeamIndex();
    const state = filters();

    if (!index || index.isEmpty) {
      els.teamChips.replaceChildren();
      els.teamNote.textContent = 'teams.json を読み込めていないため、チームで絞り込めません。';
      els.pick.disabled = true;
      return;
    }

    const facets = teamFacets(index, deps.getFacetRows(), state.teamMode);
    els.pick.disabled = facets.length === 0;

    els.teamChips.replaceChildren(...visibleFacets(facets).map(({ team, count }) => (
      chip(teamLabel(team), (state.teams ?? []).includes(team.id), { teamId: team.id }, count)
    )));

    const hidden = Math.max(0, facets.length - TOP_TEAM_CHIPS);
    const selected = (state.teams ?? []).length;
    els.teamNote.textContent = facets.length === 0
      ? 'この条件のカードに teams.json のチームが見つかりません。'
      : `${facets.length}チーム${hidden > 0 ? `（上位${TOP_TEAM_CHIPS}件を表示）` : ''}`
        + (selected === 1 ? '｜1チーム選択中のため画面テーマを切り替えています' : '');
  }

  function renderToggleLabel() {
    const state = filters();
    const count = CHIP_GROUPS.reduce((total, group) => total + (state[group.id] ?? []).length, 0)
      + (state.teams ?? []).length;
    els.toggle.textContent = count > 0 ? `絞り込み ${count}` : '絞り込み';
  }

  function render() {
    renderToggleLabel();
    if (els.panel.hidden) return;
    // 既定（金庫だけ）なら戻すものが無い
    els.reset.disabled = !hasActiveFilters(filters());
    renderGroups();
    renderTeamModes();
    renderTeams();
    if (!els.sheet.hidden) renderSheet();
  }

  /* ===== チーム検索シート ===== */

  function renderSheet() {
    const index = deps.getTeamIndex();
    const state = filters();
    const all = teamFacets(index, deps.getFacetRows(), state.teamMode);
    const hits = searchTeamFacets(all, sheetQuery);

    const list = el('div', 'choices');
    for (const { team, count } of hits.slice(0, SHEET_LIMIT)) {
      const label = el('label', 'choice');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = (state.teams ?? []).includes(team.id);
      box.dataset.teamId = team.id;
      label.append(box);

      const body = el('span', 'choice__body');
      body.append(el('span', 'choice__main', `${teamLabel(team)}（${count}枚）`));
      body.append(el('span', 'choice__sub', team.name));
      label.append(body);
      list.append(label);
    }
    if (hits.length === 0) list.append(el('p', 'hint', '一致するチームがありません。'));

    const more = hits.length > SHEET_LIMIT
      ? `${hits.length}件のうち${SHEET_LIMIT}件を表示しています。絞り込み語を足してください。`
      : `${hits.length}件`;

    els.sheetList.replaceChildren(list, el('p', 'hint', more));
  }

  function openSheet() {
    sheetQuery = '';
    els.sheetSearch.value = '';
    els.sheet.hidden = false;
    els.pick.setAttribute('aria-expanded', 'true');
    renderSheet();
    els.sheetSearch.focus({ preventScroll: true });
    els.sheet.scrollIntoView({ block: 'nearest' });
  }

  function closeSheet() {
    els.sheet.hidden = true;
    els.pick.setAttribute('aria-expanded', 'false');
  }

  /* ===== 開閉 ===== */

  function setOpen(open) {
    els.panel.hidden = !open;
    els.toggle.setAttribute('aria-expanded', String(open));
    if (!open) closeSheet();
    render();
  }

  /* ===== イベント ===== */

  els.toggle.addEventListener('click', () => setOpen(els.panel.hidden));

  els.groups.addEventListener('click', (event) => {
    const button = event.target.closest('.chip');
    if (button) toggleValue(button.dataset.group, button.dataset.value);
  });

  els.teamModes.addEventListener('click', (event) => {
    const button = event.target.closest('[data-team-mode]');
    if (!button) return;
    // モードを変えるとチームの母集団が変わるので、選択は外す（残すと0件になりやすい）
    deps.onChange({ ...filters(), teamMode: button.dataset.teamMode, teams: [] });
  });

  els.teamChips.addEventListener('click', (event) => {
    const button = event.target.closest('.chip');
    if (button) toggleTeam(button.dataset.teamId);
  });

  els.pick.addEventListener('click', () => {
    if (els.sheet.hidden) openSheet();
    else closeSheet();
  });

  els.reset.addEventListener('click', () => {
    closeSheet();
    deps.onReset();
  });

  els.sheetSearch.addEventListener('input', () => {
    sheetQuery = els.sheetSearch.value;
    renderSheet();
  });

  els.sheetList.addEventListener('change', (event) => {
    const box = event.target.closest('input[data-team-id]');
    if (box) toggleTeam(box.dataset.teamId);
  });

  els.sheetClose.addEventListener('click', closeSheet);

  return { render, setOpen, closeSheet, isOpen: () => !els.panel.hidden };
}
