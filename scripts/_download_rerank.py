import os

os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

from huggingface_hub import snapshot_download  # noqa: E402

try:
    p = snapshot_download("BAAI/bge-reranker-v2-m3")
    print("RERANK_DL_DONE", p)
except Exception as e:  # noqa: BLE001
    print("RERANK_DL_FAIL", repr(e))
