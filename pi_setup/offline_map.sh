#!/bin/bash
# Download the offline map for the trip area into tiles/route.pmtiles (served at /tiles/route.pmtiles).
# A Protomaps vector basemap (OpenStreetMap data), cut to a box from Port Augusta/Flinders Ranges to
# Sydney and Melbourne at full street detail (zoom 15): about 0.9 GB, 1-2 minutes on a good connection.
# Run as the normal user from the repo folder: bash pi_setup/offline_map.sh [west,south,east,north]
set -e
APP=$(cd "$(dirname "$0")/.." && pwd)
BBOX=${1:-137.5,-38.6,152.6,-30.0}
PMTILES_VERSION=1.31.2
PMTILES_SHA256=f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1   # Linux_arm64 build

if ! [ -x "$HOME/bin/pmtiles" ]; then
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/p.tgz" "https://github.com/protomaps/go-pmtiles/releases/download/v$PMTILES_VERSION/go-pmtiles_${PMTILES_VERSION}_Linux_arm64.tar.gz"
    echo "$PMTILES_SHA256  $tmp/p.tgz" | sha256sum -c
    tar -xzf "$tmp/p.tgz" -C "$tmp" pmtiles
    install -D -m 755 "$tmp/pmtiles" "$HOME/bin/pmtiles"
    rm -r "$tmp"
fi

# Newest daily planet build (each is ~140 GB; extract only fetches the tiles inside the box)
BUILD=$(curl -fsSL https://build-metadata.protomaps.dev/builds.json | python3 -c "import sys,json;print(json.load(sys.stdin)[-1]['key'])")
mkdir -p "$APP/tiles"
cd "$APP/tiles"
"$HOME/bin/pmtiles" extract "https://build.protomaps.com/$BUILD" route.pmtiles.part --bbox="$BBOX" --maxzoom=15
"$HOME/bin/pmtiles" verify route.pmtiles.part
mv route.pmtiles.part route.pmtiles
echo "Offline map ready: $APP/tiles/route.pmtiles ($BUILD, box $BBOX)"
