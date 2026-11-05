/**
 * チェックリストを実データで照合して結果を出す（開発用・アプリ本体からは読まれない）。
 *
 * PWA と同じモジュール（js/checklist.js・js/merge.js・js/query.js）を使うので、
 * ここで出る数字は iPhone の所持照合ビューに出る数字と同じになる。
 *
 * チェックリストを作ったあと・collection.json を直したあとに走らせて、
 *   - 当たるようになったか
 *   - 台帳のパラレル名がチェックリストに無い（＝表記の食い違い）ものはどれか
 * を確かめる。表記の食い違いは tools/fix_collection.py で寄せられる。
 *
 * 使い方:
 *     node dev/match_report.mjs                     # 全製品
 *     node dev/match_report.mjs 2025-26-topps-...   # productKey で1件だけ
 *     node dev/match_report.mjs --data ../other-data
 */
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

const args = process.argv.slice(2);
const dataIndex = args.indexOf('--data');
const dataRepo = resolve(repoRoot, dataIndex >= 0 ? args[dataIndex + 1] : '../soccer-cards-data');
const only = args.filter((a, i) => !a.startsWith('--') && i !== dataIndex + 1);

const js = (name) => import(pathToFileURL(join(repoRoot, 'js', name)).href);
const { readChecklist, matchChecklist, productKeyOfCard, applicableVariations } = await js('checklist.js');
const { mergeCollection } = await js('merge.js');
const { buildRows } = await js('query.js');
const { matchKey } = await js('text.js');

const read = (p) => JSON.parse(readFileSync(join(dataRepo, p), 'utf8'));
const optional = (p) => {
  try {
    return read(p);
  } catch {
    return null;
  }
};

const { merged, career } = mergeCollection(
  read('collection.json'), optional('prices.json'), optional('players_info.json'),
);
const rows = buildRows(merged, career);

let files;
try {
  files = readdirSync(join(dataRepo, 'checklists')).filter((f) => f.endsWith('.json')).sort();
} catch {
  console.log(`${dataRepo}/checklists がありません。`);
  process.exit(0);
}
if (only.length > 0) {
  files = files.filter((f) => only.some((key) => f.startsWith(key)));
  if (files.length === 0) {
    console.log(`該当する productKey がありません: ${only.join(', ')}`);
    process.exit(1);
  }
}

const totals = { owned: 0, otherParallel: 0, candidate: 0, missing: 0 };

for (const file of files) {
  const checklist = readChecklist(read(`checklists/${file}`));
  const owned = rows.filter((r) => productKeyOfCard(r.card) === checklist.productKey);
  const { entries, counts } = matchChecklist(checklist, rows);
  for (const key of Object.keys(totals)) totals[key] += counts[key];

  console.log('='.repeat(72));
  console.log(`${checklist.series} ${checklist.season}  [${checklist.productKey}]`);
  console.log(`  チェックリスト: パラレル${checklist.variations.length}種 / カード${checklist.cards.length}件`
    + `（coverage ${checklist.coverage} / cards ${checklist.cardsCoverage}）`);
  console.log(`  所持カード: ${owned.length}枚（うち金庫 ${owned.filter((r) => r.card.tier === 'vault').length}枚）`);
  console.log(`  照合: 所持${counts.owned} / 別パラレル所持${counts.otherParallel}`
    + ` / 候補あり${counts.candidate} / 未所持${counts.missing}`);

  const matched = entries.filter((e) => e.match.status !== 'missing');
  if (matched.length > 0) {
    console.log('  --- 当たった行 ---');
    for (const e of matched) {
      const hits = e.match.owned.map((r) => `${r.card.variation}${r.card.serial ? ` ${r.card.serial}` : ''}`);
      console.log(`    ${e.row.cardNo.padEnd(10)} ${e.row.nameEn.padEnd(22)} `
        + `${e.match.status.padEnd(14)} 所持: ${hits.join(' / ')}`);
      if (e.match.nameMismatch) console.log('      ※ 同じ番号で名前が違います（データ品質の確認を）');
    }
  }

  // 台帳にあってチェックリストに無いパラレル名＝表記の食い違いか、チェックリストの未収録
  const known = new Set(checklist.variations.map((v) => matchKey(v.name)));
  const unknown = new Map();
  for (const r of owned) {
    const key = matchKey(r.card.variation);
    if (!key || known.has(key)) continue;
    if (!unknown.has(r.card.variation)) unknown.set(r.card.variation, []);
    unknown.get(r.card.variation).push(`#${r.card.cardNo}${r.card.serial ? ` ${r.card.serial}` : ''}`);
  }
  if (unknown.size > 0) {
    console.log('  --- チェックリストに無いパラレル名（要確認） ---');
    for (const [name, where] of unknown) {
      const head = where.slice(0, 4).join(', ');
      console.log(`    「${name}」  ${head}${where.length > 4 ? ` ほか${where.length - 4}件` : ''}`);
    }
  }

  const other = entries.filter((e) => e.match.status === 'otherParallel');
  if (other.length > 0) {
    console.log('  --- 「別パラレル所持」の内訳（名前が合えば「所持」になる） ---');
    for (const e of other) {
      const names = applicableVariations(checklist, e.row);
      for (const r of e.match.owned) {
        console.log(`    ${e.row.cardNo}: 台帳「${r.card.variation}」`
          + ` ↔ 候補 ${names.slice(0, 3).join(' / ')}${names.length > 3 ? '…' : ''}`);
      }
    }
  }
}

if (files.length > 1) {
  console.log('='.repeat(72));
  console.log(`合計: 所持${totals.owned} / 別パラレル所持${totals.otherParallel}`
    + ` / 候補あり${totals.candidate} / 未所持${totals.missing}`);
}
