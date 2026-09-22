"""rag-stack 检索内核 CLI（阶段 1 验证入口）。"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rag_core import rag_engine  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="RAG 检索内核 CLI")
    ap.add_argument("cmd", choices=["reindex", "search", "ask", "build-vectors"])
    ap.add_argument("--lib", default="ai4s", help="ai4s | mito")
    ap.add_argument("--query", "--q", dest="query")
    ap.add_argument("--question", dest="question")
    ap.add_argument("--topn", type=int, default=None)
    ap.add_argument("--mode", default="hybrid", choices=["hybrid", "bm25", "semantic"])
    ap.add_argument("--source", default=None)
    ap.add_argument("--limit", type=int, default=2000)
    a = ap.parse_args()

    eng = rag_engine._engine_from_lib(a.lib)
    if a.cmd == "reindex":
        print(json.dumps(eng.sync_index(), ensure_ascii=False, indent=2))
    elif a.cmd == "build-vectors":
        print(json.dumps(eng.build_vectors(), ensure_ascii=False, indent=2))
    elif a.cmd == "search":
        hits = eng.search(a.query or "", mode=a.mode, topn=a.topn, source=a.source)
        print(json.dumps(hits, ensure_ascii=False, indent=2))
    elif a.cmd == "ask":
        print(json.dumps(eng.ask(a.question or "", topn=a.topn or 10), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
