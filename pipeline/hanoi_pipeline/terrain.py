"""Terrain and surface inputs for the flood model.

- FABDEM V1-2 (bare-earth: buildings and trees removed from Copernicus GLO-30). The
  tiles are read straight out of the 2.9 GB regional zip with HTTP range requests.
  Falls back to the Copernicus DSM when FABDEM is unavailable.
- Relative lowness: how far a cell sits below the mean ground within ~500 m (negative
  topographic position index). Water collects in such spots when drains are overwhelmed.
  Checked against the 17 reported 30/9/2025 intersection flood points (links ranked
  by score, AUC): lowness 0.64; priority-flood depression depth 0.54; absolute
  elevation 0.31 (the reported points sit in the higher old core).
- ESA WorldCover 2021 land cover -> runoff coefficient and open-water share per cell.
"""

from __future__ import annotations

import io
import logging
from pathlib import Path

import numpy as np
import rasterio
import requests
from rasterio.merge import merge
from rasterio.windows import from_bounds
from scipy.ndimage import uniform_filter

from . import config
from .download import fetch

log = logging.getLogger(__name__)


class _HttpRangeFile(io.RawIOBase):
    """Read-only seekable file over HTTP range requests (enough for `zipfile`)."""

    def __init__(self, url: str):
        self.url, self.pos, self.s = url, 0, requests.Session()
        r = self.s.head(url, allow_redirects=True, timeout=60)
        r.raise_for_status()
        if r.headers.get("Accept-Ranges") != "bytes":
            raise RuntimeError(f"{url}: no range support")
        self.size = int(r.headers["Content-Length"])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = {0: off, 1: self.pos + off, 2: self.size + off}[whence]
        return self.pos

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        r = self.s.get(self.url, headers={"Range": f"bytes={self.pos}-{self.pos + n - 1}"}, timeout=300)
        r.raise_for_status()
        d = r.content[:n]
        b[: len(d)] = d
        self.pos += len(d)
        return len(d)


def fabdem_paths() -> list[Path]:
    import zipfile

    out = [config.CACHE / "dem" / f"fabdem_{t}.tif" for t in config.FABDEM_TILES]
    missing = [p for p in out if not p.exists()]
    if missing:
        log.info("extracting %d FABDEM tile(s) from %s (range requests)", len(missing), config.FABDEM_ZIP_URL)
        z = zipfile.ZipFile(io.BufferedReader(_HttpRangeFile(config.FABDEM_ZIP_URL), buffer_size=1 << 22))
        for t, p in zip(config.FABDEM_TILES, out):
            if p.exists():
                continue
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".part")
            with z.open(f"{t}_FABDEM_V1-2.tif") as src, open(tmp, "wb") as dst:
                while chunk := src.read(1 << 22):
                    dst.write(chunk)
            tmp.rename(p)
    return out


def copernicus_paths() -> list[Path]:
    return [
        fetch(config.COPERNICUS_DEM_URL.format(t=t), config.CACHE / "dem" / f"cop30_{t}.tif")
        for t in config.COPERNICUS_DEM_TILES
    ]


def dem_source() -> tuple[str, list[Path]]:
    try:
        return "fabdem", fabdem_paths()
    except Exception as e:  # noqa: BLE001 - network or format problems: use the DSM
        log.warning("FABDEM unavailable (%s); falling back to Copernicus DSM", e)
        return "copernicus", copernicus_paths()


class Dem:
    """DEM window around the bbox, plus relative lowness."""

    def __init__(self, z: np.ndarray, transform, source: str, window_m: float = config.LOWNESS_WINDOW_M):
        self.z, self.transform, self.source = z, transform, source
        self.low = lowness(z, max(1, int(round(window_m / abs(transform.e * 110_574.0)))))

    @classmethod
    def load(cls, bbox, margin_deg: float = config.DEM_MARGIN_DEG) -> "Dem":
        source, paths = dem_source()
        w, s, e, n = bbox
        srcs = [rasterio.open(p) for p in paths]
        try:
            z, tr = merge(srcs, bounds=(w - margin_deg, s - margin_deg, e + margin_deg, n + margin_deg))
            nodata = srcs[0].nodata
        finally:
            for x in srcs:
                x.close()
        z = z[0].astype(np.float64)
        bad = ~np.isfinite(z) | (z < -100) | ((z == nodata) if nodata is not None else False)
        if bad.any():
            z[bad] = np.nanmedian(np.where(bad, np.nan, z))
        log.info("DEM %s: %dx%d cells", source, *z.shape)
        return cls(z, tr, source)

    def _rc(self, lon: float, lat: float) -> tuple[int, int]:
        c, r = ~self.transform * (lon, lat)
        return (min(max(int(r), 0), self.z.shape[0] - 1), min(max(int(c), 0), self.z.shape[1] - 1))

    def elev(self, lon: float, lat: float) -> float:
        return float(self.z[self._rc(lon, lat)])

    def lowness(self, lon: float, lat: float) -> float:
        return float(self.low[self._rc(lon, lat)])

    def mean_in(self, w: float, s: float, e: float, n: float) -> float:
        c0, r0 = ~self.transform * (w, n)
        c1, r1 = ~self.transform * (e, s)
        r0, r1 = sorted((max(int(r0), 0), min(int(np.ceil(r1)), self.z.shape[0])))
        c0, c1 = sorted((max(int(c0), 0), min(int(np.ceil(c1)), self.z.shape[1])))
        win = self.z[r0:r1, c0:c1]
        return float(win.mean()) if win.size else float(np.mean(self.z))


def lowness(z: np.ndarray, size_cells: int) -> np.ndarray:
    """Mean elevation in a `size_cells` square window minus the cell's elevation (m).
    Positive = below its surroundings."""
    size = size_cells | 1
    return uniform_filter(z, size=size, mode="nearest") - z


# ESA WorldCover classes -> runoff coefficient for land, rational-method style values
# (Chow et al. 1988 tables; urban 0.70-0.95, lawns 0.10-0.35, forest 0.05-0.25).
WORLDCOVER_C = {
    10: 0.20,  # tree cover
    20: 0.25,  # shrubland
    30: 0.30,  # grassland
    40: 0.35,  # cropland
    50: 0.90,  # built-up
    60: 0.50,  # bare / sparse vegetation
    90: 0.30,  # herbaceous wetland
    95: 0.20,  # mangroves
    100: 0.30,  # moss and lichen
}
WATER = 80


def worldcover_paths(bbox) -> list[str]:
    w, s, e, n = bbox
    tiles = set()
    for lat in (s, n):
        for lon in (w, e):
            tiles.add((int(np.floor(lat / 3) * 3), int(np.floor(lon / 3) * 3)))
    return [config.WORLDCOVER_URL.format(t=f"N{lat:02d}E{lon:03d}") for lat, lon in sorted(tiles)]


def load_worldcover(bbox) -> tuple[np.ndarray, object] | None:
    """Land-cover classes over the bbox (10 m). Cached as a small GeoTIFF."""
    cache = config.CACHE / "worldcover" / "bbox_{:.3f}_{:.3f}_{:.3f}_{:.3f}.tif".format(*bbox)
    if not cache.exists():
        try:
            srcs = [rasterio.open("/vsicurl/" + u) for u in worldcover_paths(bbox)]
            try:
                arr, tr = merge(srcs, bounds=tuple(bbox))
                profile = srcs[0].profile
            finally:
                for x in srcs:
                    x.close()
        except Exception as e:  # noqa: BLE001
            log.warning("WorldCover unavailable (%s); catchments use the global runoff coefficient", e)
            return None
        cache.parent.mkdir(parents=True, exist_ok=True)
        profile.update(height=arr.shape[1], width=arr.shape[2], transform=tr, count=1,
                       compress="deflate", tiled=False)
        profile.pop("blockxsize", None)
        profile.pop("blockysize", None)
        with rasterio.open(cache, "w", **profile) as dst:
            dst.write(arr)
    with rasterio.open(cache) as src:
        return src.read(1), src.transform


def cover_stats(classes: np.ndarray) -> tuple[float | None, float]:
    """(runoff coefficient of the land part, open-water share) of a land-cover window."""
    if classes.size == 0:
        return None, 0.0
    vals, counts = np.unique(classes, return_counts=True)
    total = counts.sum()
    water = sum(c for v, c in zip(vals, counts) if v == WATER)
    land = [(WORLDCOVER_C.get(int(v), 0.5), c) for v, c in zip(vals, counts) if v != WATER and v != 0]
    land_n = sum(c for _, c in land)
    coef = round(sum(k * c for k, c in land) / land_n, 3) if land_n else None
    return coef, round(water / total, 3)


def window(arr: np.ndarray, transform, w: float, s: float, e: float, n: float) -> np.ndarray:
    win = from_bounds(w, s, e, n, transform).round_offsets().round_lengths()
    r0, c0 = max(int(win.row_off), 0), max(int(win.col_off), 0)
    return arr[r0: r0 + int(win.height), c0: c0 + int(win.width)]
