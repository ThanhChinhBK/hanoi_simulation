"""Geometry helpers (local metric projection around Hanoi)."""

import math

LAT0 = 21.02
M_PER_DEG_LAT = 110_574.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))


def to_xy(lon: float, lat: float) -> tuple[float, float]:
    """Equirectangular projection in metres; accurate to <0.1% over the study area."""
    return lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT


def dist_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    x1, y1 = to_xy(lon1, lat1)
    x2, y2 = to_xy(lon2, lat2)
    return math.hypot(x2 - x1, y2 - y1)


def grid_index(lon: float, lat: float, bbox, size_m: float) -> tuple[int, int]:
    x, y = to_xy(lon, lat)
    x0, y0 = to_xy(bbox[0], bbox[1])
    return int((x - x0) // size_m), int((y - y0) // size_m)


def grid_center(ix: int, iy: int, bbox, size_m: float) -> tuple[float, float]:
    x0, y0 = to_xy(bbox[0], bbox[1])
    x = x0 + (ix + 0.5) * size_m
    y = y0 + (iy + 0.5) * size_m
    return x / M_PER_DEG_LON, y / M_PER_DEG_LAT
