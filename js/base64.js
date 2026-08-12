/**
 * Contents API 用の base64 変換。
 *
 * 選手名や備考に日本語が入るため、変換は必ずUTF-8バイト列を経由する。
 * `btoa(JSON.stringify(...))` は非Latin-1文字で InvalidCharacterError になるので使わない。
 */

/** 1回の String.fromCharCode に渡す最大バイト数（引数展開のスタック溢れを避ける）。 */
const CHUNK_SIZE = 0x8000;

/**
 * 文字列 → UTF-8 → base64。
 * @param {string} text
 * @returns {string} base64（改行なし）
 */
export function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

/**
 * base64 → UTF-8 → 文字列。
 *
 * Contents API のレスポンスは content を76文字ごとに改行して返すため、
 * atob に渡す前に空白類を必ず除去する。
 * @param {string} base64
 * @returns {string}
 */
export function decodeBase64Utf8(base64) {
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
