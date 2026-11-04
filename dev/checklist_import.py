"""製品チェックリストの正規化と検証（開発用・スキーマ仕様 §9-3）。

情報源（Cardboard Connection / Beckett / TCDb / 公式PDF）から起こした
下書きJSONを受け取り、表記を寄せて検証し、データリポジトリの
checklists/{productKey}.json に書き出す。書き手はPC（Claude Code手動セッション）。

下書きは緩く書いてよい:
  - productKey は書かなくてよい（maker / series / season から作る）
  - team はチーム名ならなんでもよい（teams.json の別名・日本語名でも正式名に寄せる）
  - cards[].kind / features / parallels は語彙を検証する
  - 並び順は気にしなくてよい（cardNo の自然順に並べ直す）

使い方:
    python dev/checklist_import.py draft.json              # 書き出す
    python dev/checklist_import.py draft.json --dry-run    # 検証だけ
    python dev/checklist_import.py --check                 # 既存ファイルを全部検証

検証で1件でも落ちたら何も書かずに中止する（半端なファイルを残さないため）。
コミット規約: pc: checklist {productKey}
"""

import argparse
import json
import os
import re
import sys

# 隔離モード（python -I）や別ディレクトリからの実行でも _common を読めるようにする
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _common import (  # noqa: E402
    DEFAULT_DATA_REPO,
    dumps,
    fail,
    load_teams,
    product_key,
    read_json,
    resolve_data_repo,
    warn_if_large,
    write_json,
)

CARD_KINDS = {"base", "insert", "auto", "relic", "other"}
VARIATION_CATEGORIES = {"base", "parallel", "insert", "auto", "relic", "other"}
COVERAGE = {"full", "partial", "none", "unknown"}
# denominator の語（写真判定運用仕様 §3-3）。"unknown" は分母が読めなかった場合
DENOMINATOR_WORDS = {"none", "unknown"}
# collection の features と同じ語彙（スキーマ仕様 §9-3）。ほかは警告だけ出して通す
KNOWN_FEATURES = {"auto", "patch", "rookie"}


def natural_key(text):
    """CA-DR / 110 / 2 を人が並べるとおりに並べるためのキー。"""
    parts = re.split(r"(\d+)", str(text))
    return [int(part) if part.isdigit() else part.lower() for part in parts]


def as_text(value):
    return "" if value is None else str(value).strip()


def normalize_variations(draft, errors):
    seen = {}
    result = []
    for index, raw in enumerate(draft.get("variations") or []):
        where = f"variations[{index}]"
        if not isinstance(raw, dict):
            errors.append(f"{where}: オブジェクトではありません")
            continue

        name = as_text(raw.get("name"))
        if not name:
            errors.append(f"{where}: name が空です")
            continue
        if name in seen:
            errors.append(f"{where}: name「{name}」が重複しています")
            continue
        seen[name] = True

        category = as_text(raw.get("category")) or "parallel"
        if category not in VARIATION_CATEGORIES:
            errors.append(f"{where}: category「{category}」は語彙外です（{sorted(VARIATION_CATEGORIES)}）")

        # denominator は数値（シリアル分母）/ "none"（シリアルなし）/ "unknown"（分母不明）
        # 写真判定運用仕様 §3-3
        denominator = raw.get("denominator", "none")
        if isinstance(denominator, bool) or not isinstance(denominator, (str, int)):
            errors.append(f"{where}: denominator の型が読めません")
        elif isinstance(denominator, str):
            denominator = as_text(denominator) or "none"
            if denominator.isdigit():
                denominator = int(denominator)
            elif denominator not in DENOMINATOR_WORDS:
                errors.append(
                    f"{where}: denominator「{denominator}」は数値か "
                    f"{' / '.join(sorted(DENOMINATOR_WORDS))} にしてください"
                )

        entry = {"name": name, "category": category, "denominator": denominator}
        # 限定版の区別（Hobby / Asia 等。同 §3-3）。あれば残す
        if as_text(raw.get("exclusive")):
            entry["exclusive"] = as_text(raw.get("exclusive"))
        if as_text(raw.get("notes")):
            entry["notes"] = as_text(raw.get("notes"))
        result.append(entry)

    return result


def normalize_cards(draft, variation_names, teams, errors, warnings):
    seen = {}
    result = []

    for index, raw in enumerate(draft.get("cards") or []):
        where = f"cards[{index}]"
        if not isinstance(raw, dict):
            errors.append(f"{where}: オブジェクトではありません")
            continue

        card_no = as_text(raw.get("cardNo"))
        if not card_no:
            errors.append(f"{where}: cardNo が空です")
            continue
        key = card_no.lower().replace(" ", "")
        if key in seen:
            errors.append(f"{where}: cardNo「{card_no}」が {seen[key]} と重複しています")
            continue
        seen[key] = where

        name_en = as_text(raw.get("nameEn"))
        if not name_en:
            errors.append(f"{where} ({card_no}): nameEn が空です（照合キーなので必須）")

        # チーム名は teams.json の正式名に寄せる（スキーマ仕様 §9-3）
        team_raw = as_text(raw.get("team"))
        team = teams.official(team_raw) if team_raw else ""
        if team_raw and not team:
            errors.append(
                f"{where} ({card_no}): team「{team_raw}」が teams.json にありません。"
                "別名なら teams.json に足すか、正式名で書いてください。"
            )
            team = team_raw
        elif team_raw and team != team_raw:
            warnings.append(f"{where} ({card_no}): team「{team_raw}」→「{team}」に寄せました")

        kind = as_text(raw.get("kind")) or "base"
        if kind not in CARD_KINDS:
            errors.append(f"{where} ({card_no}): kind「{kind}」は語彙外です（{sorted(CARD_KINDS)}）")

        parallels = raw.get("parallels", "all")
        if parallels != "all":
            if not isinstance(parallels, list):
                errors.append(f"{where} ({card_no}): parallels は \"all\" か配列にしてください")
                parallels = []
            else:
                parallels = [as_text(item) for item in parallels if as_text(item)]
                unknown = [name for name in parallels if name not in variation_names]
                if unknown:
                    errors.append(
                        f"{where} ({card_no}): parallels に variations[] に無い名前があります: {unknown}"
                    )

        features = [as_text(item) for item in (raw.get("features") or []) if as_text(item)]
        for feature in features:
            if feature not in KNOWN_FEATURES:
                warnings.append(f"{where} ({card_no}): features「{feature}」は見慣れない値です")

        entry = {
            "cardNo": card_no,
            "nameEn": name_en,
        }
        others = [as_text(item) for item in (raw.get("nameEnOthers") or []) if as_text(item)]
        if others:
            entry["nameEnOthers"] = others
        entry["team"] = team
        entry["kind"] = kind
        entry["parallels"] = parallels
        entry["features"] = features
        if as_text(raw.get("notes")):
            entry["notes"] = as_text(raw.get("notes"))
        result.append(entry)

    result.sort(key=lambda card: natural_key(card["cardNo"]))
    return result


def normalize(draft, teams):
    """下書き → チェックリスト本体。errors が空でなければ呼び出し側が中止する。"""
    errors = []
    warnings = []

    maker = as_text(draft.get("maker"))
    series = as_text(draft.get("series"))
    season = as_text(draft.get("season"))
    for name, value in (("maker", maker), ("series", series), ("season", season)):
        if not value:
            errors.append(f"{name} が空です（productKey を作れません）")

    key = product_key(maker, series, season) if maker and series and season else None
    given = as_text(draft.get("productKey"))
    if given and key and given != key:
        errors.append(
            f"productKey「{given}」は maker/series/season から作った「{key}」と違います。"
            "下書きの productKey を消すか、maker/series/season を直してください。"
        )

    variations = normalize_variations(draft, errors)
    variation_names = {item["name"] for item in variations}
    cards = normalize_cards(draft, variation_names, teams, errors, warnings)

    coverage = as_text(draft.get("coverage")) or "unknown"
    if coverage not in COVERAGE:
        errors.append(f"coverage「{coverage}」は語彙外です（{sorted(COVERAGE)}）")

    cards_coverage = as_text(draft.get("cardsCoverage")) or ("none" if not cards else "unknown")
    if cards_coverage not in COVERAGE:
        errors.append(f"cardsCoverage「{cards_coverage}」は語彙外です（{sorted(COVERAGE)}）")
    if cards and cards_coverage == "none":
        errors.append("cards[] があるのに cardsCoverage が none です")

    sources = [as_text(item) for item in (draft.get("sources") or []) if as_text(item)]
    if not sources:
        warnings.append("sources が空です。出典を残しておくと後で確かめられます")

    checklist = {
        # cards[] を持つ形式は schemaVersion 2（スキーマ仕様 §9-3）
        "schemaVersion": 2 if cards else 1,
        "productKey": key or given,
        "maker": maker,
        "series": series,
        "season": season,
        "coverage": coverage,
        "cardsCoverage": cards_coverage,
        "confirmedAt": as_text(draft.get("confirmedAt")) or None,
        "sources": sources,
        "variations": variations,
    }
    if cards:
        checklist["cards"] = cards

    return checklist, errors, warnings


def validate_file(path, teams):
    """既存のチェックリストを読み直して検証する（--check）。"""
    name = os.path.basename(path)
    try:
        existing = read_json(path)
    except json.JSONDecodeError as error:
        return [f"{name}: JSONとして壊れています（{error}）"], []

    checklist, errors, warnings = normalize(existing, teams)
    expected = name[: -len(".json")]
    if checklist["productKey"] != expected:
        errors.append(
            f"{name}: productKey「{checklist['productKey']}」がファイル名と違います"
        )
    return [f"{name}: {message}" for message in errors], [f"{name}: {m}" for m in warnings]


def main():
    parser = argparse.ArgumentParser(description="製品チェックリストの正規化と検証")
    parser.add_argument("draft", nargs="?", help="下書きJSONのパス")
    parser.add_argument("--data-repo", default=DEFAULT_DATA_REPO, help="データリポジトリの場所")
    parser.add_argument("--dry-run", action="store_true", help="書かずに検証だけする")
    parser.add_argument("--check", action="store_true", help="既存の checklists/ を全部検証する")
    args = parser.parse_args()

    data_repo = resolve_data_repo(args.data_repo)
    if not os.path.isdir(data_repo):
        fail(f"{data_repo} がありません。--data-repo で場所を指定してください。")
    teams = load_teams(data_repo)
    checklists_dir = os.path.join(data_repo, "checklists")

    if args.check:
        paths = sorted(
            os.path.join(checklists_dir, name)
            for name in os.listdir(checklists_dir)
            if name.endswith(".json")
        ) if os.path.isdir(checklists_dir) else []
        if not paths:
            print("checklists/ にファイルがありません。")
            return

        all_errors = []
        for path in paths:
            errors, warnings = validate_file(path, teams)
            all_errors += errors
            for warning in warnings:
                print(f"警告: {warning}")
        if all_errors:
            for message in all_errors:
                print(f"エラー: {message}", file=sys.stderr)
            fail(f"{len(all_errors)}件の問題があります。")
        print(f"{len(paths)}件すべて検証を通りました。")
        return

    if not args.draft:
        fail("下書きJSONのパスか --check を指定してください。")

    draft = read_json(args.draft)
    checklist, errors, warnings = normalize(draft, teams)

    for warning in warnings:
        print(f"警告: {warning}")
    if errors:
        for message in errors:
            print(f"エラー: {message}", file=sys.stderr)
        fail(f"{len(errors)}件の問題があります。何も書いていません。")

    dest = os.path.join(checklists_dir, f"{checklist['productKey']}.json")
    if args.dry_run:
        print(dumps(checklist))
        print(f"（--dry-run。書き出すなら {os.path.relpath(dest, data_repo)}）")
        return

    size = write_json(dest, checklist)
    warn_if_large(dest, size)
    print(
        f"書き出しました: {os.path.relpath(dest, data_repo)} "
        f"（{size:,} バイト / パラレル{len(checklist['variations'])}種 "
        f"/ カード{len(checklist.get('cards') or [])}件）"
    )
    print(f"コミット: pc: checklist {checklist['productKey']}")


if __name__ == "__main__":
    main()
