/**
 * エクスポート（保存同期方式仕様 §3・§7）。
 *
 * マージ済みの単一 collection.json（スキーマ仕様v1.2の完全形）を書き出す。
 * バックアップと引っ越しが目的なので、出力はリポジトリの collection.json と
 * 同じ体裁（serialize.js）にする — 差分を取れば何が違うか読める。
 *
 * オーバーレイを畳み込んだ結果なので、これ1本で価格・所属まで揃う。
 */
import { mergeCollection } from './merge.js';
import { stringifyCollection } from './serialize.js';
import { toIsoDate, toIsoTimestamp } from './ingest.js';

const MIME = 'application/json';

/**
 * 書き出す中身とファイル名を作る。
 *
 * exportedAt は書き出した時刻に更新する（このファイルがいつ時点の写しかを、
 * 中身だけ見て判断できるようにする）。ほかのフィールドは触らない。
 *
 * @param {object} collection collection.json
 * @param {{prices: object|null, playersInfo: object|null}} overlays
 * @param {Date} [date]
 * @returns {{filename: string, text: string, json: object, counts: {cards: number, players: number}}}
 */
export function buildExport(collection, overlays, date = new Date()) {
  const { merged } = mergeCollection(collection, overlays?.prices ?? null, overlays?.playersInfo ?? null);

  // 推定価格は表示のためにマージで行へ載せているが、collection.json の
  // カードには無い項目なので書き出さない（スキーマ仕様 §9-7。完全形を保つ）
  const cards = merged.cards.map((card) => {
    if (!('estimate' in card)) return card;
    const { estimate, ...rest } = card;
    return rest;
  });

  // exportedAt は元から先頭付近にあるキーなので、スプレッドで値だけ差し替える（並びは変わらない）
  const json = { ...merged, cards, exportedAt: toIsoTimestamp(date) };

  return {
    filename: `collection-${toIsoDate(date)}.json`,
    text: stringifyCollection(json),
    json,
    counts: { cards: json.cards?.length ?? 0, players: json.players?.length ?? 0 },
  };
}

/** このブラウザがファイルの共有シートを出せるか（iOSはこちらが本命）。 */
export function canShareFile() {
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [new File(['{}'], 'probe.json', { type: MIME })] });
  } catch {
    return false;
  }
}

/**
 * 共有シートに渡す（iPhoneでは「ファイルに保存」でiCloud/本体に置ける）。
 * ユーザーが取り消した場合は false を返す（エラー扱いにしない）。
 *
 * @returns {Promise<boolean>} 共有シートを出せたら true
 */
export async function shareFile(text, filename) {
  const file = new File([text], filename, { type: MIME });
  try {
    await navigator.share({ files: [file], title: filename });
    return true;
  } catch (error) {
    if (error?.name === 'AbortError') return false;
    throw error;
  }
}

/** ダウンロードとして保存する（PC・Androidの経路）。 */
export function downloadFile(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: MIME }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  // Safariはドキュメントに繋がっていない<a>のclickを無視することがある
  document.body.append(link);
  link.click();
  link.remove();
  // 即revokeするとダウンロードが始まる前に消えることがあるので少し待つ
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
