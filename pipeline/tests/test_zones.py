from hanoi_pipeline import zones
from hanoi_pipeline.geo import M_PER_DEG_LAT, M_PER_DEG_LON

BBOX = (105.80, 21.00, 105.81, 21.01)


def _node(dx_m, dy_m):
    return {"lon": BBOX[0] + dx_m / M_PER_DEG_LON, "lat": BBOX[1] + dy_m / M_PER_DEG_LAT, "elev_m": 0, "signal": False}


def test_population_spreads_over_alley_nodes_and_pois_snap(monkeypatch):
    # an arterial (0-1) with an alley (2-3) running beside it, all inside one 200 m zone
    nodes = [_node(10, 10), _node(190, 10), _node(90, 90), _node(110, 110)]
    links = [
        {"from": 0, "to": 1, "road_class": "primary"},
        {"from": 2, "to": 3, "road_class": "service"},
    ]
    cell = (nodes[2]["lon"], nodes[2]["lat"], 100.0)
    monkeypatch.setattr(zones, "population_cells", lambda bbox: ([cell], 100.0))
    monkeypatch.setattr(zones, "poi_points", lambda bbox: [(nodes[1]["lon"], nodes[1]["lat"], "work", 5.0)])

    out, check = zones.build_zones(BBOX, nodes, links)

    assert len(out) == 1
    z = out[0]
    access = {n: (pop, poi) for n, pop, poi in z["access"]}
    # homes go to the alley nodes only (not the arterial), split evenly
    assert access[2][0] == access[3][0] == 50.0
    assert 0 not in access
    # the POI attaches to its nearest node, even on the arterial
    assert access[1] == (0.0, 5.0)
    assert z["population"] == 100.0
    assert z["node"] in access
    assert check["zones_population_total"] == 100
