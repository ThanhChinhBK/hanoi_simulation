from hanoi_pipeline.metro import build_metro


def test_build_metro_lines_and_stations():
    def way(*pts):
        return {"type": "way", "role": "", "geometry": [{"lon": x, "lat": y} for x, y in pts]}

    def stop(i, x, y):
        return {"type": "node", "ref": i, "role": "stop", "lon": x, "lat": y}

    osm = {"elements": [
        # both directions of line 2A, one unknown line, one with no geometry
        {"type": "relation", "id": 2, "tags": {"ref": "T2A", "name": "B → A"},
         "members": [way((1, 1), (2, 2))]},
        {"type": "relation", "id": 1, "tags": {"ref": "T2A", "name": "A → B"},
         "members": [way((1, 1), (2, 2)), stop(10, 1, 1), stop(11, 2, 2), stop(12, 2, 2),
                     {"type": "node", "ref": 13, "role": "platform", "lon": 3, "lat": 3}]},
        {"type": "relation", "id": 3, "tags": {"ref": "X9"}, "members": [way((0, 0), (1, 0))]},
        {"type": "relation", "id": 4, "tags": {"ref": "T3"}, "members": []},
        {"type": "node", "id": 10, "tags": {"name": "Cát Linh"}},
        {"type": "node", "id": 11, "tags": {"name": "Hà Đông"}},
        {"type": "node", "id": 12, "tags": {"name": "Hà Đông"}},
        {"type": "node", "id": 13, "tags": {"name": "Platform"}},
    ]}
    fc = build_metro(osm)
    lines = [f for f in fc["features"] if f["properties"]["kind"] == "line"]
    stations = [f["properties"]["name"] for f in fc["features"] if f["properties"]["kind"] == "station"]
    assert [(f["properties"]["ref"], f["properties"]["osm_relation"]) for f in lines] == [("T2A", 1)]
    assert lines[0]["properties"]["status"] == "operating"
    assert stations == ["Cát Linh", "Hà Đông"]
