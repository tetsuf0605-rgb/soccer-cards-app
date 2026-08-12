"""dev/fixtures.js を生成する（開発用・アプリ本体からは読み込まれない）。

selftest.html が Contents API のレスポンスを差し替えるために使う固定データを作る。
base64化はPython側で行い、アプリの encodeBase64Utf8 とは独立した符号器として
突き合わせられるようにしている。

!!! 注意 !!!
soccer-cards-app は public リポジトリ。ここに実際の所持カードデータを
焼き込まないこと。生成元は「スキーマ仕様 §3 のサンプル（架空の2枚）」に限る。

使い方（データリポにサンプルが入っている状態で）:
    python dev/gen_fixtures.py ../soccer-cards-data
"""
import base64
import hashlib
import json
import os
import sys
import textwrap

FILES = ["collection.json", "prices.json", "players_info.json"]

# 実データの焼き込みを防ぐガード（サンプルに含まれるカードID）
EXPECTED_CARD_IDS = {"c-20260811-k3f", "c-20260812-m7q"}


def git_blob_sha(raw: bytes) -> str:
    """git が付けるblob shaと同じ値（selftestのsha表示を現実的にするため）。"""
    header = f"blob {len(raw)}".encode() + b"\x00"
    return hashlib.sha1(header + raw).hexdigest()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(here)
    # 相対指定はリポジトリルート基準で解決する（dev/ 基準ではない）
    src = sys.argv[1] if len(sys.argv) > 1 else "../soccer-cards-data"
    src = os.path.abspath(os.path.join(repo_root, src))

    collection = json.load(open(os.path.join(src, "collection.json"), encoding="utf-8"))
    card_ids = {c["id"] for c in collection["cards"]}
    if card_ids != EXPECTED_CARD_IDS:
        sys.exit(
            "中止: collection.json がスキーマ仕様§3のサンプルではありません。\n"
            f"  検出したカードID: {sorted(card_ids)}\n"
            "  実データをpublicリポジトリに焼き込まないでください。"
        )

    entries = []
    for name in FILES:
        raw = open(os.path.join(src, name), "rb").read()
        b64 = "\n".join(textwrap.wrap(base64.b64encode(raw).decode("ascii"), 60))
        entries.append(
            f"  {json.dumps(name)}: {{\n"
            f"    sha: {json.dumps(git_blob_sha(raw))},\n"
            f"    size: {len(raw)},\n"
            f"    content: `\n{b64}\n`,\n"
            f"  }},"
        )

    out = (
        "/* 自動生成: dev/gen_fixtures.py — 手で編集しない。\n"
        " *\n"
        " * スキーマ仕様 §3 のサンプルデータ（架空の2枚）を Contents API の\n"
        " * レスポンス形と同じ形にしたもの。content は API と同様に改行入りのbase64。\n"
        " * 実データからは再生成しないこと（このリポジトリは public）。\n"
        " */\n"
        "export const FIXTURES = {\n" + "\n".join(entries) + "\n};\n"
    )
    dest = os.path.join(here, "fixtures.js")
    with open(dest, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    print(f"wrote {dest} ({len(out)} bytes)")


if __name__ == "__main__":
    main()
