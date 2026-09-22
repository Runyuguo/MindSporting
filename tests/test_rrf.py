import unittest

from rag_core import rag_engine


class TestRrfAggregation(unittest.TestCase):
    def test_aggregate_collapses_multi_chunk_doc(self):
        hits = [
            {"source": "vault:note", "ref": "A", "score": 0.9},
            {"source": "vault:note", "ref": "A", "score": 0.95},
            {"source": "metadata", "ref": "B", "score": 0.8},
        ]
        agg = rag_engine.aggregate_by_document(hits)
        self.assertEqual(len(agg), 2)
        a = [h for h in agg if h["ref"] == "A"][0]
        self.assertEqual(a["score"], 0.95)

    def test_aggregate_prevents_monopoly(self):
        hits = []
        for i in range(10):
            hits.append({"source": "vault:note", "ref": "A", "score": 0.9 - i * 0.01})
        for j, ref in enumerate(["B", "C", "D", "E", "F"]):
            hits.append({"source": "metadata", "ref": ref, "score": 0.5 - j * 0.02})
        agg = rag_engine.aggregate_by_document(hits)
        self.assertEqual(len(agg), 6)
        top_refs = [h["ref"] for h in agg[:3]]
        self.assertGreaterEqual(len(set(top_refs)), 2, top_refs)

    def test_rrf_merge_rewards_multi_list_presence(self):
        bm = [
            {"source": "metadata", "ref": "W", "score": 0.9},
            {"source": "metadata", "ref": "Y", "score": 0.5},
        ]
        sem = [
            {"source": "metadata", "ref": "Z", "score": 0.9},
            {"source": "metadata", "ref": "Y", "score": 0.5},
        ]
        merged = rag_engine.rrf_merge(bm, sem, k=60)
        self.assertEqual(merged[0]["ref"], "Y")


if __name__ == "__main__":
    unittest.main()
