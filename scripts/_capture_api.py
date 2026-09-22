import json
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8000"


def get(path, params=None, timeout=40):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    print(">>> GET", path, flush=True)
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


print("=== search_bm25 ===", flush=True)
print(json.dumps(get("/search", {"lib": "ai4s", "q": "线粒体动力学", "mode": "bm25", "topn": 2}),
                 ensure_ascii=False, indent=2), flush=True)

print("=== search_semantic ===", flush=True)
print(json.dumps(get("/search", {"lib": "ai4s", "q": "线粒体动力学", "mode": "semantic", "topn": 2}, timeout=90),
                 ensure_ascii=False, indent=2), flush=True)

print("=== library ===", flush=True)
lib = get("/library", {"lib": "ai4s", "limit": 3})
print(json.dumps(lib, ensure_ascii=False, indent=2), flush=True)

print("=== graph ===", flush=True)
gr = get("/graph", {"lib": "ai4s"})
print(json.dumps({"counts": {"nodes": len(gr.get("nodes", [])), "edges": len(gr.get("edges", []))},
                  "node_example": gr.get("nodes", [])[:2],
                  "edge_example": gr.get("edges", [])[:2]}, ensure_ascii=False, indent=2), flush=True)

if lib.get("items"):
    it = lib["items"][0]
    print("=== doc ===", flush=True)
    d = get("/doc", {"lib": "ai4s", "source": it["source"], "ref": it["ref"]})
    print(json.dumps({"source": it["source"], "ref": it["ref"],
                      "content_head": d.get("content", "")[:300]}, ensure_ascii=False, indent=2), flush=True)

print("=== ask_stream (SSE, bm25) ===", flush=True)
url = BASE + "/ask/stream?" + urllib.parse.urlencode({"lib": "ai4s", "q": "线粒体动力学", "mode": "bm25"})
with urllib.request.urlopen(url, timeout=60) as r:
    print(r.read().decode("utf-8"), flush=True)

print("DONE", flush=True)
