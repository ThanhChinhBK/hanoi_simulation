from hanoi_pipeline.flood import _intersection_links, _street_low_point_links, name_matches


def test_name_matches_strips_prefix_and_case():
    assert name_matches("Phố Tràng Tiền", "Tràng Tiền")
    assert name_matches("Đường Láng", "láng")
    assert name_matches("Phố Huế / Phố Hàng Bài", "Hàng Bài")
    assert not name_matches("Phố Láng Hạ", "Láng")


def _toy():
    # A street running west-east (links 0,1) crossing a north-south street (links 2,3) at node 1.
    nodes = [
        {"lon": 105.80, "lat": 21.00, "elev_m": 10.0},
        {"lon": 105.801, "lat": 21.00, "elev_m": 8.0},
        {"lon": 105.802, "lat": 21.00, "elev_m": 9.0},
        {"lon": 105.801, "lat": 21.001, "elev_m": 12.0},
        {"lon": 105.801, "lat": 20.999, "elev_m": 11.0},
    ]
    def link(a, b, bridge=False):
        return {"from": a, "to": b, "bridge": bridge, "tunnel": False}
    links = [link(0, 1), link(1, 2), link(3, 1), link(1, 4)]
    return nodes, links


def test_intersection_links_near_shared_node():
    nodes, links = _toy()
    assert _intersection_links(nodes, links, [0, 1], [2, 3]) == [0, 1, 2, 3]
    assert _intersection_links(nodes, links, [0], []) == []


def test_street_low_point_excludes_bridges():
    nodes, links = _toy()
    links[0]["bridge"] = True
    out = _street_low_point_links(nodes, links, [0, 1], radius_m=50)
    assert out == [1]
