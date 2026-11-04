"""FCGB（gb-eval）のCSVから gb/{breakId}.json を作る（開発用・スキーマ仕様 §9-4）。

入力は FCGB のブレイクフォルダ（breaks.csv / spots.csv / checklist_entries.csv）。
出力はデータリポジトリの gb/{breakId}.json。

期待値・確率の数値は**転記しない**（§9-4）。FCGB側のレポートが正で、ここが持つのは
参照パス（evalReport）だけ。gb/ が持つのは「どのブレイクの、どのスポットに、
どのチーム・どの選手がいたか」だけで、PWAは取り込み時の gbRef の選択肢と
GBビューの表示に使う。

注意: FCGB の `card_id` は評価用の内部ID（BAR_DRO / CA_DR など）で、製品の
カード番号ではない。ここからカード番号を作ってはいけない（所持照合が静かに
外れる）。選手名は card_name から取り、チェックリストがあれば表記を突き合わせる。

前提（§9-4）: gb/ を作る前に、該当製品の checklists があること。
どうしても先に作りたいときだけ --allow-missing-checklist を付ける。

使い方:
    python dev/gb_export.py "C:/.../FCGB/breaks/BLZ_2026-09-05_ToppsChromeUCC_22" --maker Topps
    python dev/gb_export.py <break_dir> --status joined   # 参加した
    python dev/gb_export.py <break_dir> --dry-run

コミット規約: pc: gb {breakId}
"""

import argparse
import csv
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
    match_key,
    product_key,
    read_json,
    resolve_data_repo,
    write_json,
)

GB_STATUS = {"evaluated", "joined", "received"}

# spot_name をチーム部分と選手部分に割る区切り（「Barcelona - Dro/Fernandez」）
TEAM_PLAYER_SPLIT = re.compile(r"\s+[-–—]\s+")
# チーム・選手の並び（「Aston Villa/Nottingham Forest」「Arsenal & Chelsea」）
NAME_SEPARATORS = re.compile(r"\s*[/&＋+]\s*")

# card_name の末尾に付く種別の語。選手名を取り出すときに落とす
DESCRIPTOR_WORDS = {
    "chrome", "auto", "autograph", "autographs", "triple", "dual", "quad",
    "rc", "rookie", "parallel", "parallels", "refractor", "prism",
    "base", "insert", "relic", "patch", "numbered",
}

# 「その他」をまとめた評価用の行。選手ではないので飛ばす
CATCH_ALL = re.compile(r"_OTHER$", re.IGNORECASE)


def read_csv(path):
    if not os.path.exists(path):
        fail(f"{path} がありません。FCGBのブレイクフォルダを指定してください。")
    with open(path, encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def card_code(entry):
    """card_name の末尾に「(CTA-SGR)」と入っていればそれを返す（本物のカード番号）。

    card_id は内部IDなので使わない。番号が分からない行は None。
    """
    found = re.search(r"\(([A-Za-z0-9][A-Za-z0-9\-]*)\)\s*$", entry.get("card_name") or "")
    return found.group(1) if found else None


def player_names(card_name):
    """card_name から選手名を取り出す。

    「Declan Rice Chrome Auto」→ ["Declan Rice"]
    「Saliba/Gabriel/Rice Triple Auto (CTA-SGR)」→ ["Saliba", "Gabriel", "Rice"]
    """
    text = re.sub(r"\([^)]*\)\s*$", "", card_name or "").strip()

    # 末尾から種別の語を落とす（「Chrome Auto」「RC parallel」など）
    words = text.split()
    while words and words[-1].lower().strip(".,") in DESCRIPTOR_WORDS:
        words.pop()
    text = " ".join(words).strip()
    if not text:
        return []

    return [name.strip() for name in NAME_SEPARATORS.split(text) if name.strip()]


def expand_surnames(names):
    """同じスポット内に姓だけの行とフルネームの行があれば、姓をフルネームに寄せる。

    トリプルオートが「Saliba/Gabriel/Rice」のように姓だけで並ぶため。
    一意に決まるときだけ置き換える（曖昧なら姓のまま残す）。
    """
    # 同じフルネームが何度も出てくる（オートとパラレルで1人2行）ので先に潰す。
    # 潰さずに数えると「候補が2件ある」と誤判定して姓のまま残ってしまう
    full = list({match_key(name): name for name in names if " " in name}.values())

    result = []
    for name in names:
        if " " in name:
            result.append(name)
            continue
        key = match_key(name)
        hits = [candidate for candidate in full if match_key(candidate.split()[-1]) == key]
        result.append(hits[0] if len(hits) == 1 else name)
    return result


def resolve_spot_teams(teams, spot_name, warnings):
    """スポット名から teams.json のIDを拾う。拾えなければ空で返し、警告に残す。"""
    head = TEAM_PLAYER_SPLIT.split(spot_name, maxsplit=1)[0]

    ids = []
    for candidate in NAME_SEPARATORS.split(head):
        candidate = candidate.strip()
        if not candidate:
            continue
        team = teams.resolve(candidate)
        if team and team["id"] not in ids:
            ids.append(team["id"])

    if not ids:
        # 区切りが読めない形（「Newcastle」単体など）は名前まるごとで引き直す
        team = teams.resolve(spot_name)
        if team:
            ids.append(team["id"])

    if not ids:
        warnings.append(
            f"スポット「{spot_name}」のチームを teams.json から引けませんでした。"
            "teams.json に別名を足すか、gb/ を手で直してください。"
        )
    return ids


def find_maker(data_repo, series, season, given):
    """maker は breaks.csv に無いので、指定が無ければ既存のチェックリストから探す。"""
    if given:
        return given

    directory = os.path.join(data_repo, "checklists")
    if os.path.isdir(directory):
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".json"):
                continue
            existing = read_json(os.path.join(directory, name))
            if existing.get("series") == series and existing.get("season") == season:
                return existing.get("maker") or ""

    fail(
        "maker が分かりません（breaks.csv に列がありません）。"
        f"--maker で指定するか、先に「{series} / {season}」のチェックリストを作ってください。"
    )
    return ""


def build_spots(spot_rows, entries, teams, warnings):
    """spots.csv と checklist_entries.csv からスポットを組み立てる。"""
    by_spot = {}
    for entry in entries:
        if CATCH_ALL.search(entry.get("card_id") or ""):
            continue  # 「その他（残り97種）」のような集計行
        names = player_names(entry.get("card_name"))
        if not names:
            continue
        for spot_id in (entry.get("spot_ids") or "").split(";"):
            spot_id = spot_id.strip()
            if spot_id:
                by_spot.setdefault(spot_id, []).extend(names)

    spots = []
    for row in spot_rows:
        spot_id = (row.get("spot_id") or "").strip()
        if not spot_id:
            continue
        name = (row.get("spot_name") or spot_id).strip()

        # 重複を潰しつつ並びは保つ（評価CSVの順＝だいたい主力順）
        seen = {}
        for player in expand_surnames(by_spot.get(spot_id, [])):
            seen.setdefault(match_key(player), player)
        players = list(seen.values())

        price = (row.get("price_yen") or "").strip()
        spots.append({
            "spotId": spot_id,
            "name": name,
            "type": (row.get("spot_type") or "team").strip() or "team",
            "priceYen": int(float(price)) if price else None,
            "teamIds": resolve_spot_teams(teams, name, warnings),
            "playersEn": players,
        })
    return spots


def cross_check_checklist(checklist, spots, entries):
    """チェックリストと突き合わせて、拾えなかったものを報告する（書き換えはしない）。"""
    notes = []
    cards = checklist.get("cards") or []
    if not cards:
        notes.append(
            f"チェックリスト {checklist.get('productKey')} に cards[] がありません"
            "（cardsCoverage を確かめてください）。所持照合は使えません。"
        )
        return notes

    known_names = {match_key(card.get("nameEn")) for card in cards if card.get("nameEn")}
    unknown = []
    for spot in spots:
        for player in spot["playersEn"]:
            if match_key(player) not in known_names and player not in unknown:
                unknown.append(player)
    if unknown:
        notes.append(
            f"チェックリストに見当たらない選手が{len(unknown)}人います: "
            f"{', '.join(unknown[:8])}{' …' if len(unknown) > 8 else ''}"
        )

    known_nos = {str(card.get("cardNo", "")).lower().replace(" ", "") for card in cards}
    missing_nos = []
    for entry in entries:
        code = card_code(entry)
        if code and code.lower().replace(" ", "") not in known_nos and code not in missing_nos:
            missing_nos.append(code)
    if missing_nos:
        notes.append(f"チェックリストに無いカード番号: {', '.join(missing_nos)}")

    return notes


def break_id_date(break_id):
    """breaks.csv に date 列が無いので、break_id の中の日付を拾う（BLZ_2026-09-05_...）。"""
    found = re.search(r"(\d{4}-\d{2}-\d{2})", break_id)
    return found.group(1) if found else ""


def main():
    parser = argparse.ArgumentParser(description="FCGBのCSVから gb/{breakId}.json を作る")
    parser.add_argument("break_dir", help="FCGBのブレイクフォルダ")
    parser.add_argument("--data-repo", default=DEFAULT_DATA_REPO, help="データリポジトリの場所")
    parser.add_argument("--maker", default="", help="メーカー（breaks.csv に列が無いため）")
    parser.add_argument("--status", default="evaluated", choices=sorted(GB_STATUS))
    parser.add_argument("--eval-report", default="", help="gb-eval のレポートへの参照パス")
    parser.add_argument("--allow-missing-checklist", action="store_true",
                        help="チェックリストが無くても書き出す（§9-4の前提を外す）")
    parser.add_argument("--dry-run", action="store_true", help="書かずに中身を出す")
    args = parser.parse_args()

    data_repo = resolve_data_repo(args.data_repo)
    if not os.path.isdir(data_repo):
        fail(f"{data_repo} がありません。--data-repo で場所を指定してください。")
    teams = load_teams(data_repo)

    break_dir = os.path.abspath(args.break_dir)
    breaks = read_csv(os.path.join(break_dir, "breaks.csv"))
    if len(breaks) != 1:
        fail(f"breaks.csv は1行のはずですが {len(breaks)} 行あります。")
    head = breaks[0]

    break_id = (head.get("break_id") or "").strip()
    series = (head.get("product") or "").strip()
    season = (head.get("year") or "").strip()
    if not break_id or not series or not season:
        fail("breaks.csv の break_id / product / year が読めません。")

    maker = find_maker(data_repo, series, season, args.maker.strip())
    key = product_key(maker, series, season)
    if not key:
        fail(f"productKey を作れません（maker={maker} series={series} season={season}）。")

    entries = read_csv(os.path.join(break_dir, "checklist_entries.csv"))
    spot_rows = read_csv(os.path.join(break_dir, "spots.csv"))

    warnings = []
    spots = build_spots(spot_rows, entries, teams, warnings)

    # チェックリストが先（§9-4）。無いと所持照合ビューが使えない
    checklist_path = os.path.join(data_repo, "checklists", f"{key}.json")
    if os.path.exists(checklist_path):
        warnings += cross_check_checklist(read_json(checklist_path), spots, entries)
    elif args.allow_missing_checklist:
        warnings.append(
            f"{os.path.relpath(checklist_path, data_repo)} がありません。"
            "GBビューは出ますが、所持照合には使えません（スキーマ仕様 §9-4）。"
        )
    else:
        fail(
            f"{os.path.relpath(checklist_path, data_repo)} がありません。"
            "先に dev/checklist_import.py でチェックリストを作ってください（スキーマ仕様 §9-4）。"
            " 先に gb/ だけ作るなら --allow-missing-checklist。"
        )

    boxes = (head.get("boxes") or "").strip()
    gb = {
        "schemaVersion": 1,
        "breakId": break_id,
        "breaker": (head.get("breaker") or "").strip(),
        "productKey": key,
        # スキーマ仕様 §9-4 の format は pyt / random などのブレイク形式。
        # breaks.csv の「format」列は箱の売り方（hobby_full_case）なので break_type を使う
        "format": (head.get("break_type") or head.get("format") or "").strip(),
        "boxes": int(float(boxes)) if boxes else None,
        "date": (head.get("date") or "").strip() or break_id_date(break_id),
        "spots": spots,
        "status": args.status,
        "evalReport": args.eval_report.strip() or f"FCGB/breaks/{break_id}/output/report.md",
    }

    for warning in warnings:
        print(f"警告: {warning}")
    empty = [spot["spotId"] for spot in spots if not spot["teamIds"] and not spot["playersEn"]]
    if empty:
        print(f"警告: 構成が空のスポットがあります: {', '.join(empty)}")

    if args.dry_run:
        print(dumps(gb))
        return

    dest = os.path.join(data_repo, "gb", f"{break_id}.json")
    size = write_json(dest, gb)
    print(
        f"書き出しました: {os.path.relpath(dest, data_repo)} "
        f"（{size:,} バイト / スポット{len(spots)}件）"
    )
    print(f"コミット: pc: gb {break_id}")


if __name__ == "__main__":
    main()
