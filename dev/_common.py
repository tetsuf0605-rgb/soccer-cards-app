"""checklist_import.py / gb_export.py の共通処理（開発用・アプリ本体からは読まれない）。

データリポジトリ（既定で ../soccer-cards-data）を読み書きする。
このリポジトリは public なので、ここに実データを焼き込まないこと。

productKey の生成規則は js/checklist.js の productKeyOf と同じにしてある。
片方だけ直すと所持照合が静かに外れるので、必ず両方を直すこと。
"""

import json
import os
import re
import sys
import unicodedata

# データリポジトリの既定位置（PWAリポジトリと並べて置く前提。保存同期方式仕様 §5-1）
DEFAULT_DATA_REPO = "../soccer-cards-data"


def repo_root():
    """soccer-cards-app のルート（このファイルの1つ上）。"""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def resolve_data_repo(path=None):
    """データリポジトリの絶対パス。相対指定はPWAリポジトリのルート基準で解く。"""
    return os.path.abspath(os.path.join(repo_root(), path or DEFAULT_DATA_REPO))


def fail(message):
    """中止する。直し方が分かる文面にすること。"""
    sys.exit(f"中止: {message}")


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


# ===== 文字列の正規化（js/text.js と同じ寄せ方） =====


def fold_text(text):
    """NFKC → 小文字。ひらがな→カタカナはPython側では使わないので省く。"""
    return unicodedata.normalize("NFKC", "" if text is None else str(text)).lower()


def strip_accents(text):
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


# NFDで分解できないラテン文字（Ødegaard の Ø など）。js/text.js の LATIN_FOLD と同じ
LATIN_FOLD = str.maketrans({
    "ø": "o", "đ": "d", "ð": "d", "þ": "th", "ł": "l", "ħ": "h", "ŧ": "t",
    "æ": "ae", "œ": "oe", "ß": "ss", "ı": "i", "ĸ": "k",
})


def match_key(text):
    """名前の突き合わせキー（チーム名・選手のnameEn）。js/text.js の matchKey と同じ。"""
    folded = strip_accents(fold_text(text)).translate(LATIN_FOLD)
    return re.sub(r"[\s.,'’`\-_/·・]", "", folded)


def slug(text):
    """ファイル名に使える形。js/checklist.js の slug と同じ。"""
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", strip_accents(fold_text(text))))


def product_key(maker, series, season):
    """js/checklist.js の productKeyOf と同じ規則。season か series が無ければ None。"""
    season_slug = slug(season)
    series_slug = slug(series)
    if not season_slug or not series_slug:
        return None

    maker_slug = slug(maker)
    # 「Topps」＋「Topps Chrome ...」で topps が二度出ないようにする
    needs_maker = bool(maker_slug) and series_slug != maker_slug \
        and not series_slug.startswith(maker_slug + "-")

    parts = [season_slug, maker_slug if needs_maker else None, series_slug]
    return "-".join(part for part in parts if part)


# ===== teams.json =====


class TeamIndex:
    """teams.json の索引。正式名・日本語名・別名のどれでも引ける（スキーマ仕様 §9-1）。"""

    def __init__(self, teams):
        self.teams = teams
        self.by_id = {team["id"]: team for team in teams if team.get("id")}
        self.by_key = {}
        # 正式名を先に入れてから別名を入れる（別名が正式名を上書きしないように）
        for team in teams:
            self.by_key.setdefault(match_key(team["name"]), team)
        for team in teams:
            for alias in [team.get("nameJa")] + list(team.get("aliases") or []):
                if alias:
                    self.by_key.setdefault(match_key(alias), team)

    def resolve(self, name):
        """チーム名を teams.json の1件に解決する。見つからなければ None。"""
        key = match_key(name)
        return self.by_key.get(key) if key else None

    def official(self, name):
        """正式名に寄せる。解決できなければ None（呼び出し側でエラーにする）。"""
        team = self.resolve(name)
        return team["name"] if team else None


def load_teams(data_repo):
    path = os.path.join(data_repo, "teams.json")
    if not os.path.exists(path):
        fail(f"{path} がありません。先に teams.json を作ってください（段階2-A）。")
    return TeamIndex(read_json(path).get("teams") or [])


# ===== 書き出しの体裁（js/serialize.js と同じ考え方） =====

INDENT = "  "


def _is_scalar(value):
    return value is None or not isinstance(value, (dict, list))


def _format(value, depth, inline_from):
    if _is_scalar(value):
        return json.dumps(value, ensure_ascii=False)

    pad = INDENT * depth
    inner = INDENT * (depth + 1)

    if isinstance(value, list):
        if not value:
            return "[]"
        if all(_is_scalar(item) for item in value):
            return "[" + ", ".join(json.dumps(item, ensure_ascii=False) for item in value) + "]"
        items = [inner + _format(item, depth + 1, inline_from) for item in value]
        return "[\n" + ",\n".join(items) + "\n" + pad + "]"

    if not value:
        return "{}"

    if depth >= inline_from:
        pairs = [
            f"{json.dumps(key, ensure_ascii=False)}: {_format(item, depth + 1, inline_from)}"
            for key, item in value.items()
        ]
        return "{ " + ", ".join(pairs) + " }"

    pairs = [
        f"{inner}{json.dumps(key, ensure_ascii=False)}: {_format(item, depth + 1, inline_from)}"
        for key, item in value.items()
    ]
    return "{\n" + ",\n".join(pairs) + "\n" + pad + "}"


def dumps(value, inline_from=2):
    """1件1行で並ぶJSON本文。既定は「配列の要素を1行に畳む」深さ。"""
    return _format(value, 0, inline_from) + "\n"


def write_json(path, value, inline_from=2):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(dumps(value, inline_from))
    return os.path.getsize(path)


# ===== 件数の目安（Contents API の1MB制限。保存同期方式仕様 §4） =====

SIZE_WARN_BYTES = 900_000


def warn_if_large(path, size):
    if size > SIZE_WARN_BYTES:
        print(
            f"警告: {os.path.basename(path)} が {size:,} バイトです。"
            "Contents API の1MB制限に近いので cardsCoverage: partial を検討してください。"
        )
