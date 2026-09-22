import unittest

from fastapi.testclient import TestClient

from server import http_server


class TestHttpContract(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(http_server.app)

    def test_search_returns_json_hits(self):
        r = self.client.get("/search", params={"lib": "ai4s", "q": "mitochondria",
                                               "mode": "bm25", "topn": 3})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIn("hits", body)
        self.assertIsInstance(body["hits"], list)


if __name__ == "__main__":
    unittest.main()
