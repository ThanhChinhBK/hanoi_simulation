"""Pipeline configuration: study area, sources, attributions."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
CACHE = DATA / "cache"
BUNDLES = DATA / "bundles"
INPUTS = Path(__file__).resolve().parents[1] / "inputs"
WEB_DATA = ROOT / "web" / "public" / "data"

# Inner districts (pre-2025 boundaries): Hoàn Kiếm, Ba Đình, Đống Đa, Hai Bà Trưng,
# Cầu Giấy, Thanh Xuân. A bbox is used instead of admin polygons because of the July 2025
# administrative reform (districts abolished, wards merged); population comes from a grid.
BBOX = (105.775, 20.975, 105.875, 21.065)  # west, south, east, north (WGS84)

ROAD_CLASSES = [
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "service",
]
# Ngõ/ngách are mostly highway=service (+ service=alley) in Hanoi OSM. Parking aisles,
# driveways and private service roads are left out; footways (mostly sidewalks) too.
OSM_ROAD_FILTER = [
    '["highway"~"^(' + "|".join(c for c in ROAD_CLASSES if c != "service") + ')$"]',
    '["highway"="service"]["service"!~"parking_aisle|parking|driveway|drive-through|emergency_access"]'
    '["access"!~"^(private|no)$"]["area"!="yes"]',
]
MINOR_CLASSES = {"residential", "living_street", "service", "unclassified"}
GEOM_SIMPLIFY_DEG = 1e-5  # ~1 m: drops redundant vertices, keeps the shape

WORLDPOP_URL = (
    "https://data.worldpop.org/GIS/Population/Global_2000_2020_Constrained/2020/BSGM/VNM/"
    "vnm_ppp_2020_constrained.tif"
)
COPERNICUS_DEM_TILES = ["N21_00_E105_00", "N20_00_E105_00"]
COPERNICUS_DEM_URL = (
    "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{t}_DEM/"
    "Copernicus_DSM_COG_10_{t}_DEM.tif"
)

ZONE_SIZE_M = 200.0
# Population cells are spread over minor-road nodes within this radius of the cell
# centre (people live along ngõ); POIs attach to the nearest node within POI_SNAP_M.
HOME_SNAP_M = 75.0
POI_SNAP_M = 150.0
CATCHMENT_SIZE_M = 1000.0

# 2019 census (GSO), population of the six inner districts (old boundaries).
# Used only as a sanity check: the bbox also covers parts of neighbouring districts.
# VERIFY against GSO 2019 census tables (values entered from memory; old district boundaries).
CENSUS_2019_INNER = {
    "Ba Đình": 221_893,
    "Hoàn Kiếm": 135_618,
    "Đống Đa": 371_606,
    "Hai Bà Trưng": 303_586,
    "Cầu Giấy": 292_536,
    "Thanh Xuân": 293_292,
}

# Metro: OSM route relations, status set by hand (OSM does not tag it reliably).
# Verify statuses before relying on them; display only (rail is not simulated).
METRO_BBOX = (105.70, 20.93, 105.92, 21.12)
METRO_LINES = {
    "T2A": {"name": "Line 2A Cát Linh – Hà Đông", "colour": "#2e9d48", "status": "operating",
            "note": "Elevated; opened 6/11/2021."},
    "T3": {"name": "Line 3 Nhổn – Cầu Giấy", "colour": "#d1427a", "status": "operating",
           "note": "Elevated section opened 8/8/2024; underground Cầu Giấy – Ga Hà Nội not yet open."},
    "T2": {"name": "Line 2 Nam Thăng Long – Trần Hưng Đạo", "colour": "#e8a33d", "status": "planned",
           "note": "Planned / under construction (status: assumption)."},
    "T8": {"name": "Line 8", "colour": "#7f6cc4", "status": "planned", "note": "Planned (OSM proposal)."},
    "T10": {"name": "Line 10", "colour": "#3c8dbc", "status": "planned", "note": "Planned (OSM proposal)."},
    "T14": {"name": "Line 14", "colour": "#9b7b52", "status": "planned", "note": "Planned (OSM proposal)."},
}

ATTRIBUTIONS = [
    {"name": "OpenStreetMap contributors", "license": "ODbL 1.0",
     "url": "https://www.openstreetmap.org/copyright", "used_for": "road network, POIs, metro lines"},
    {"name": "WorldPop (2020 constrained, 100 m)", "license": "CC BY 4.0",
     "url": "https://www.worldpop.org", "used_for": "population grid"},
    {"name": "Copernicus GLO-30 DEM (ESA)", "license": "Copernicus DEM licence (free)",
     "url": "https://spacedata.copernicus.eu", "used_for": "elevation (DSM, broad trends only)"},
    {"name": "Hanoi Sewerage and Drainage Co. via news (Tiền Phong, VOV Giao thông)",
     "license": "facts reported in press",
     "url": "https://tienphong.vn/danh-sach-65-diem-ung-ngap-tai-ha-noi-post1782650.tpo",
     "used_for": "30/9/2025 flood points and station rainfall"},
]
