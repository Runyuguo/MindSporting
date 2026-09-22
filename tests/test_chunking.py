import unittest

from rag_core import rag_engine


class TestChunking(unittest.TestCase):
    def test_short_sentences_kept_intact(self):
        text = "第一句。第二句！第三句？"
        chunks = rag_engine.chunk_text(text, max_chars=500)
        self.assertTrue(any("第一句" in c and "第二句" in c for c in chunks))

    def test_all_chunks_within_limit(self):
        text = ("这是一个很长的段落。" * 200)
        chunks = rag_engine.chunk_text(text, max_chars=500)
        self.assertTrue(chunks)
        for c in chunks:
            self.assertLessEqual(len(c), 500, f"chunk too long: {len(c)}")

    def test_overlong_sentence_hard_split(self):
        text = "x" * 1200  # 无空格的长 token
        chunks = rag_engine.chunk_text(text, max_chars=500)
        self.assertTrue(chunks)
        for c in chunks:
            self.assertLessEqual(len(c), 500)

    def test_heading_starts_new_chunk(self):
        text = "前言内容。\n# 方法\n方法正文句子。"
        chunks = rag_engine.chunk_text(text, max_chars=500)
        self.assertTrue(any(c.startswith("# 方法") for c in chunks), chunks)


if __name__ == "__main__":
    unittest.main()
