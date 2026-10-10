import numpy as np

from hanoi_pipeline import config
from hanoi_pipeline.flood import build_catchments
from hanoi_pipeline.terrain import WATER, cover_stats, lowness


def test_lowness_positive_in_a_hollow():
    z = np.full((9, 9), 10.0)
    z[4, 4] = 8.0
    z[0, 0] = 12.0
    low = lowness(z, 3)
    assert low[4, 4] > 1.5
    assert low[0, 0] < 0
    assert abs(low[7, 7]) < 1e-9


def test_cover_stats():
    built, trees = 50, 10
    c, w = cover_stats(np.array([[built, built], [trees, WATER]]))
    assert w == 0.25
    assert np.isclose(c, (0.9 * 2 + 0.2) / 3, atol=1e-3)
    assert cover_stats(np.array([[WATER]])) == (None, 1.0)


class _FlatDem:
    """Ground falls towards the east: each 1 km column is 1 m lower."""

    def mean_in(self, w, s, e, n):
        return 20.0 - (w - config.BBOX[0]) * 100.0


def test_catchments_spill_downhill_and_rank_by_lowness():
    lat = config.BBOX[1] + 0.003
    lons = [config.BBOX[0] + 0.002 + k * 0.0098 for k in range(3)]  # three 1 km columns
    nodes, links = [], []
    for lon in lons:
        base = len(nodes)
        for j, low in enumerate([0.0, 1.5, 3.0]):
            nodes.append({"lon": lon + j * 0.0005, "lat": lat, "elev_m": 10.0, "low_m": low})
        for j in range(2):
            links.append({"from": base + j, "to": base + j + 1, "bridge": False, "tunnel": False})
    cs = build_catchments(config.BBOX, nodes, links, dem=_FlatDem(), low_share=0.5)
    assert len(cs) == 3
    assert [c.get("spill_to") for c in cs] == [1, 2, None]
    assert cs[0]["ground_elev_m"] > cs[2]["ground_elev_m"]
    assert all(len(c["low_links"]) == 1 for c in cs)
    assert [c["low_links"] for c in cs] == [[1], [3], [5]]  # the lower link of each pair
    assert "runoff_coefficient" not in cs[0]
