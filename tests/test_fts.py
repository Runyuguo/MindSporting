import unittest

from rag_core import rag_engine


class TestFtsQuery(unittest.TestCase):
    def test_greek_letters_preserved(self):
        q = rag_engine.make_fts_query("TNF-α κ")
        self.assertIn('"TNF-α"', q)
        self.assertIn('"κ"', q)

    def test_slash_and_superscript_preserved(self):
        q = rag_engine.make_fts_query("Na⁺/K⁺-ATPase")
        self.assertIn('"Na⁺/K⁺-ATPase"', q)

    def test_cjk_long_term_expanded(self):
        q = rag_engine.make_fts_query("线粒体动力学")
        self.assertIn('"线粒体动力学"', q)
        self.assertTrue("线粒体动" in q or "体动力学" in q, q)

    def test_empty_query(self):
        self.assertEqual(rag_engine.make_fts_query(""), "")


if __name__ == "__main__":
    unittest.main()
