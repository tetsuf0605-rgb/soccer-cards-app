/**
 * その場に出す確認パネル。
 *
 * `window.confirm` は使わない。ホーム画面に追加したPWAやアプリ内ブラウザでは
 * ダイアログが表示されず即 false が返ることがあり、「ボタンを押しても何も
 * 起きない」「中止できない」という止まり方をするため。
 *
 * 画面内のDOMなら、どの環境でも同じように出て同じように押せる。
 */
import { el } from './render.js';

/** 開いているパネルの解決口（同じ場所で2度開いたら前のを畳む）。 */
const pending = new Map();

/**
 * 確認を求める。
 *
 * @param {HTMLElement} slot パネルを差し込む空の要素
 * @param {{text: string, note?: string, yesLabel?: string, noLabel?: string, danger?: boolean}} options
 * @returns {Promise<boolean>} 「はい」なら true
 */
export function askConfirm(slot, { text, note, yesLabel = 'はい', noLabel = 'やめる', danger = false }) {
  closeConfirm(slot);

  return new Promise((resolve) => {
    const panel = el('div', 'confirm');
    panel.append(el('p', 'confirm__text', text));
    if (note) panel.append(el('p', 'confirm__note', note));

    const actions = el('div', 'actions');
    const yes = el('button', `btn ${danger ? 'btn--danger' : 'btn--primary'}`, yesLabel);
    const no = el('button', 'btn btn--ghost', noLabel);
    yes.type = 'button';
    no.type = 'button';
    yes.addEventListener('click', () => settle(slot, true));
    no.addEventListener('click', () => settle(slot, false));
    actions.append(yes, no);
    panel.append(actions);

    slot.replaceChildren(panel);
    pending.set(slot, resolve);
    yes.focus({ preventScroll: true });
    panel.scrollIntoView({ block: 'center' });
  });
}

function settle(slot, answer) {
  const resolve = pending.get(slot);
  if (!resolve) return;
  pending.delete(slot);
  slot.replaceChildren();
  resolve(answer);
}

/** 開いていれば「やめる」として畳む（画面を離れるときに呼ぶ）。 */
export function closeConfirm(slot) {
  settle(slot, false);
}
