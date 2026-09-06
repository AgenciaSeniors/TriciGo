"""Shape tests for the Wikidata SPARQL query.

Run: cd scripts/sync-pois && python3 test_wikidata_query.py
(pytest is not part of the sync toolchain; plain unittest keeps it dependency-free.)
"""
import re
import unittest

from download_wikidata import CUBA_QID, POI_TYPE_QIDS, build_sparql_query


class QueryShape(unittest.TestCase):
    def test_in_list_is_comma_separated(self):
        q = build_sparql_query()
        inside = re.search(r"IN \(([^)]*)\)", q).group(1)
        self.assertEqual(inside.count(","), len(POI_TYPE_QIDS) - 1)
        # The bug that kept this source empty for months: a space-separated list
        # is a SPARQL syntax error and query.wikidata.org answers HTTP 400.
        self.assertNotRegex(inside, r"wd:Q\d+ wd:Q")

    def test_every_curated_qid_is_in_the_filter(self):
        q = build_sparql_query()
        for qid in POI_TYPE_QIDS:
            self.assertIn(f"wd:{qid}", q)

    def test_country_filter_is_cuba(self):
        self.assertIn(f"wdt:P17 wd:{CUBA_QID}", build_sparql_query())
        self.assertEqual(CUBA_QID, "Q241")


if __name__ == "__main__":
    unittest.main()
