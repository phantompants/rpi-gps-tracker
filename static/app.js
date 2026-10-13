// RPi 3 4WD GPS & IMU Tracker Frontend
let map, marker, trackPolyline;
let autoCenter = true;
let gpsFix = null;  // last real GPS position (null until the first fix)
let speedUnit = "KMH";
let trackPoints = [];

document.addEventListener("DOMContentLoaded", () => {
    initMap();
    updateAutoCenterButton();
    initTapShutdown();
    startTelemetryLoop();
    initHistory();
    if (location.hash === "#sats") toggleSatModal();  // bookmarkable Satellites page
});

let currentTileLayer;
let currentLayerIndex = 0;

const freeMapLayers = [
    {
        name: "OpenStreetMap",
        icon: "🗺️",
        url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        options: { maxZoom: 19 }
    },
    {
        name: "Esri Satellite",
        icon: "🛰️",
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        options: { maxZoom: 18 }
    },
    {
        name: "Esri Topo",
        icon: "🏔️",
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
        options: { maxZoom: 18 }
    },
    {
        // Vector map stored on the Pi (pi_setup/offline_map.sh): works with no internet
        name: "Offline",
        icon: "📴",
        offline: true,
        url: "/tiles/route.pmtiles"
    }
];

function initMap() {
    map = L.map("map", {
        zoomControl: false,
        attributionControl: false,
        // On the LCD, multi-tap gestures (3 = recentre, 5 = shutdown) would otherwise zoom the map
        doubleClickZoom: document.documentElement.classList.contains("remote")
    }).setView([-25.8989, 137.9892], 14); // Outback Australia default view

    // Panning by hand stops the map following the GPS; 🎯 brings it back
    map.on("dragstart", () => {
        if (autoCenter) {
            autoCenter = false;
            updateAutoCenterButton();
        }
    });

    // Initialize with first free map layer
    setMapLayer(0);

    const customIcon = L.divIcon({
        className: 'gps-pulse-marker',
        iconSize: [20, 20],
        iconAnchor: [10, 10]
    });

    marker = L.marker([-25.8989, 137.9892], { icon: customIcon }).addTo(map);

    trackPolyline = L.polyline([], {
        color: '#00f0ff',
        weight: 4,
        opacity: 0.8,
        smoothFactor: 1
    }).addTo(map);

    updateAutoCenterButton();
}

function setMapLayer(index) {
    if (currentTileLayer) {
        map.removeLayer(currentTileLayer);
    }
    currentLayerIndex = index;
    const layerInfo = freeMapLayers[index];
    if (layerInfo.offline) {
        currentTileLayer = protomapsL.leafletLayer({ url: layerInfo.url, flavor: "dark", lang: "en", maxDataZoom: 15 }).addTo(map);
    } else {
        onlineTileErrors = 0;
        currentTileLayer = L.tileLayer(layerInfo.url, layerInfo.options).addTo(map);
        currentTileLayer.on("tileload", () => { onlineTileErrors = 0; });
        currentTileLayer.on("tileerror", onOnlineTileError);
    }

    const btn = document.getElementById("mapTypeBtn");
    if (btn) btn.textContent = layerInfo.icon;
}

function cycleMapLayer() {
    autoOffline = false;  // picking a map by hand turns off the automatic switch back
    const nextIndex = (currentLayerIndex + 1) % freeMapLayers.length;
    setMapLayer(nextIndex);
}

// No internet (Starlink down or stowed): online map images fail, so switch to the offline map,
// then check once a minute whether the online map is reachable again and switch back.
const OFFLINE_INDEX = freeMapLayers.findIndex(l => l.offline);
const TILE_ERRORS_BEFORE_OFFLINE = 4;
let onlineTileErrors = 0;
let autoOffline = false;        // true while showing the offline map because the internet dropped
let onlineIndexBeforeAuto = 0;

function onOnlineTileError() {
    onlineTileErrors += 1;
    if (onlineTileErrors < TILE_ERRORS_BEFORE_OFFLINE || autoOffline) return;
    onlineIndexBeforeAuto = currentLayerIndex;
    autoOffline = true;
    setMapLayer(OFFLINE_INDEX);
    showMapToast("No internet: offline map");
}

setInterval(() => {
    if (!autoOffline) return;
    // Load one online tile for the current view; if it arrives, go back to the online map
    const layer = freeMapLayers[onlineIndexBeforeAuto];
    const z = Math.min(map.getZoom(), 15);
    const p = map.project(map.getCenter(), z).divideBy(256).floor();
    const probe = new Image();
    probe.onload = () => {
        if (!autoOffline) return;
        autoOffline = false;
        setMapLayer(onlineIndexBeforeAuto);
        showMapToast("Internet back: online map");
    };
    probe.src = L.Util.template(layer.url, { s: "a", z, x: p.x, y: p.y }) + `?probe=${Date.now()}`;
}, 60000);

function startTelemetryLoop() {
    fetchTelemetry();
    setInterval(fetchTelemetry, 1000);
}

async function fetchTelemetry() {
    try {
        const response = await fetch("/api/gps");
        const data = await response.json();
        updateUI(data);
        serviceFailures = 0;
    } catch (err) {
        console.warn("Telemetry fetch error:", err);
        serviceFailures += 1;
        if (serviceFailures >= 3) showAlerts([{ text: "⚠️ Tracker service not responding", critical: true }]);
    }
}

// Colour scales smoothly: green up to okAt, through amber at warnAt, to red at hotAt and above
function setSysValue(id, value, format, okAt, warnAt, hotAt) {
    const el = document.getElementById(id);
    if (value === null || value === undefined) {
        el.textContent = "--";
        el.style.color = "";
        return;
    }
    el.textContent = format(value);
    const clamp = x => Math.min(1, Math.max(0, x));
    const hue = value < warnAt
        ? 130 - 90 * clamp((value - okAt) / (warnAt - okAt))   // green 130 -> amber 40
        : 40 - 40 * clamp((value - warnAt) / (hotAt - warnAt)); // amber 40 -> red 0
    el.style.color = `hsl(${hue}, 100%, 55%)`;
}

function updateUI(data) {
    // Speedometer
    const displaySpeed = (speedUnit === "KMH") ? data.speed : data.speed_mph;
    document.getElementById("speedValue").textContent = Math.round(displaySpeed);

    // Satellites & HDOP
    document.getElementById("satValue").textContent = `${data.satellites} / ${data.hdop}`;

    // IMU: Pitch & Roll (Incline / Tilt)
    document.getElementById("inclineValue").textContent = `${Math.round(data.pitch)}° / ${Math.round(data.roll)}°`;

    // IMU: G-Force
    document.getElementById("gForceValue").textContent = `${data.g_total.toFixed(1)}g`;

    // Pi health strip: green / amber / red points (temp is red at the 80 °C overheat warning)
    setSysValue("sysCpu", data.cpu_percent, v => `${Math.round(v)}%`, 30, 70, 90);
    setSysValue("sysRam", data.ram_percent, v => `${Math.round(v)}%`, 50, 75, 90);
    setSysValue("sysTemp", data.cpu_temp, v => `${v.toFixed(0)}°C`, 55, 70, 80);

    // Status Badge
    const badge = document.getElementById("statusBadge");
    badge.textContent = data.status;
    badge.className = "status-badge";
    if (data.mode.includes("Simulation")) {
        badge.classList.add("sim");
    } else if (data.fix_quality > 0) {
        badge.classList.add("active");
    }

    // Coordinates & Corrugation Roughness
    document.getElementById("latLonDisplay").textContent = `Lat: ${data.lat.toFixed(6)} | Lon: ${data.lon.toFixed(6)}`;
    document.getElementById("roughnessDisplay").textContent = `Vibration Index: ${data.roughness.toFixed(2)} | Log: ${data.current_log_file || 'Active'}`;

    showAlerts(collectAlerts(data));

    // Log Counter
    document.getElementById("pointsLogged").textContent = `${data.points_logged_today} rows logged today`;
    document.getElementById("modeTag").textContent = data.mode;

    // Map Position Update
    if (data.lat !== 0 && data.lon !== 0) {
        const newLatLng = [data.lat, data.lon];
        gpsFix = newLatLng;
        marker.setLatLng(newLatLng);

        if (autoCenter) {
            map.panTo(newLatLng);
        }

        // Live trail since the last history refresh (history reloads replace it)
        trackPoints.push(newLatLng);
        if (trackPoints.length > 500) trackPoints.shift();
        trackPolyline.setLatLngs(trackPoints);
    }
}

// ---------- Track history & stop markers ----------
const HISTORY_REFRESH_MS = 60000;
const historyRanges = [
    { label: "1D", title: "Today", days: 1 },
    { label: "3D", title: "Last 3 days", days: 3 },
    { label: "7D", title: "Last 7 days", days: 7 },
    { label: "ALL", title: "All trips", days: null },
    { label: "OFF", title: "History hidden", off: true }
];
let historyIndex = 0;
let historyLayer, stopsLayer;
let historyRequest = 0;

function initHistory() {
    historyLayer = L.layerGroup().addTo(map);
    stopsLayer = L.layerGroup().addTo(map);
    try {
        const saved = parseInt(localStorage.getItem("historyIndex"), 10);
        if (saved >= 0 && saved < historyRanges.length) historyIndex = saved;
    } catch (e) { /* storage unavailable: use default */ }
    updateHistoryButton();
    loadHistory(false);
    setInterval(() => loadHistory(false), HISTORY_REFRESH_MS);
}

function cycleHistoryRange() {
    historyIndex = (historyIndex + 1) % historyRanges.length;
    try { localStorage.setItem("historyIndex", historyIndex); } catch (e) { /* ignore */ }
    updateHistoryButton();
    loadHistory(true);
}

function updateHistoryButton() {
    const btn = document.getElementById("historyBtn");
    const range = historyRanges[historyIndex];
    btn.textContent = range.label;
    btn.title = `Track history: ${range.title}`;
    btn.classList.toggle("active", !range.off);
}

function historySince(range) {
    if (!range.days) return null;
    const start = new Date();
    start.setHours(0, 0, 0, 0);                   // local midnight today
    start.setDate(start.getDate() - (range.days - 1));
    return Math.floor(start.getTime() / 1000);
}

async function loadHistory(fitToRoute) {
    const range = historyRanges[historyIndex];
    const requestId = ++historyRequest;
    if (range.off) {
        historyLayer.clearLayers();
        stopsLayer.clearLayers();
        return;
    }
    const since = historySince(range);
    try {
        const res = await fetch(since ? `/api/history?since=${since}` : "/api/history");
        const data = await res.json();
        if (requestId !== historyRequest) return;   // range changed while loading
        drawHistory(data);
        if (fitToRoute) {
            const bounds = L.latLngBounds(data.segments.flat().concat(data.stops.map(s => [s.lat, s.lon])));
            if (bounds.isValid()) {
                autoCenter = false;
                updateAutoCenterButton();
                map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
            }
        }
    } catch (err) {
        console.warn("History fetch error:", err);
    }
}

function drawHistory(data) {
    historyLayer.clearLayers();
    stopsLayer.clearLayers();
    data.segments.forEach(seg => {
        if (seg.length > 1) {
            L.polyline(seg, { color: "#00f0ff", weight: 3, opacity: 0.7, smoothFactor: 1.5 }).addTo(historyLayer);
        }
    });
    data.stops.forEach(stop => {
        const icon = L.divIcon({
            className: "stop-marker",
            html: `<span>${formatDurationShort(stop.minutes)}</span>`,
            iconSize: null
        });
        L.marker([stop.lat, stop.lon], { icon, zIndexOffset: -100 })
            .bindPopup(stopPopupHtml(stop))
            .addTo(stopsLayer);
    });
    // History now includes everything logged so far; restart the live trail from here.
    trackPoints = trackPoints.slice(-1);
    trackPolyline.setLatLngs(trackPoints);
}

function formatDurationShort(minutes) {
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / 1440)}d`;
}

function formatDurationLong(minutes) {
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const m = minutes % 60;
    return [d && `${d} d`, h && `${h} h`, (m || (!d && !h)) && `${m} min`].filter(Boolean).join(" ");
}

function formatStopTime(epoch) {
    return new Date(epoch * 1000).toLocaleString([], {
        weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
}

function stopPopupHtml(stop) {
    const lines = stop.ongoing
        ? [`<b>Here since</b> ${formatStopTime(stop.start)}`, `${formatDurationLong(stop.minutes)} so far`]
        : [`<b>Stopped</b> ${formatDurationLong(stop.minutes)}`,
           `${formatStopTime(stop.start)} → ${formatStopTime(stop.end)}`];
    lines.push(`<span class="popup-coords">${stop.lat.toFixed(5)}, ${stop.lon.toFixed(5)}</span>`);
    return lines.join("<br>");
}

// ---------- Satellite status page ----------
const SAT_REFRESH_MS = 2000;
const GNSS_ORDER = ["GPS", "GLONASS", "Galileo", "BeiDou", "QZSS", "SBAS", "NavIC", "IMES", "Other"];
let satTimer = null;

function toggleSatModal() {
    const modal = document.getElementById("satModal");
    if (modal.style.display === "none") {
        modal.style.display = "flex";
        fetchSatellites();
        satTimer = setInterval(fetchSatellites, SAT_REFRESH_MS);
    } else {
        modal.style.display = "none";
        clearInterval(satTimer);
        satTimer = null;
    }
}

async function fetchSatellites() {
    try {
        const res = await fetch("/api/sats");
        renderSatellites(await res.json());
    } catch (err) {
        console.warn("Satellite fetch error:", err);
    }
}

function snrClass(snr) {
    if (!snr) return "none";
    if (snr >= 30) return "good";
    if (snr >= 20) return "fair";
    return "weak";
}

function renderSatellites(data) {
    const fixText = { 3: "3D Fix", 2: "2D Fix" }[data.fix_quality] || (data.status.includes("Simulation") ? "3D Fix" : "No Fix");
    const fix = document.getElementById("satFix");
    fix.textContent = `${fixText} · ${data.used}/${data.visible} used · HDOP ${data.hdop}`;
    fix.className = "sat-fix " + (data.fix_quality >= 2 ? "ok" : "bad");

    renderSkyplot(data.satellites);
    renderSnrBars(data.satellites);
}

function renderSkyplot(sats) {
    const svg = document.getElementById("skyplot");
    const R = 100;
    let html = "";
    // Elevation rings: horizon, 30°, 60°
    [0, 30, 60].forEach(el => {
        html += `<circle class="sky-ring" cx="0" cy="0" r="${(90 - el) / 90 * R}"/>`;
    });
    html += `<line class="sky-ring" x1="${-R}" y1="0" x2="${R}" y2="0"/><line class="sky-ring" x1="0" y1="${-R}" x2="0" y2="${R}"/>`;
    html += `<text class="sky-compass" x="0" y="${-R - 4}">N</text><text class="sky-compass" x="${R + 8}" y="4">E</text>`;
    html += `<text class="sky-compass" x="0" y="${R + 12}">S</text><text class="sky-compass" x="${-R - 8}" y="4">W</text>`;

    sats.filter(s => s.el != null && s.az != null && s.el >= 0).forEach(s => {
        const r = (90 - s.el) / 90 * R;
        const a = s.az * Math.PI / 180;
        const x = (r * Math.sin(a)).toFixed(1);
        const y = (-r * Math.cos(a)).toFixed(1);
        html += `<g class="sat ${snrClass(s.snr)} ${s.used ? "used" : ""}">
            <circle cx="${x}" cy="${y}" r="6"/>
            <text x="${x}" y="${(y - 9).toFixed(1)}">${s.prn}</text></g>`;
    });
    svg.innerHTML = html;
}

function renderSnrBars(sats) {
    const container = document.getElementById("snrBars");
    const groups = {};
    sats.forEach(s => (groups[s.gnss] = groups[s.gnss] || []).push(s));
    const names = Object.keys(groups).sort((a, b) => GNSS_ORDER.indexOf(a) - GNSS_ORDER.indexOf(b));
    if (!names.length) {
        container.innerHTML = `<p class="sat-empty">No satellites reported yet. The GPS needs a clear view of the sky.</p>`;
        return;
    }
    container.innerHTML = names.map(name => {
        const bars = groups[name]
            .sort((a, b) => (b.used - a.used) || ((b.snr || 0) - (a.snr || 0)))
            .map(s => {
                const h = Math.min(100, (s.snr || 0) / 50 * 100);
                return `<div class="snr-col ${s.used ? "used" : ""}" title="PRN ${s.prn}: ${s.snr || 0} dB">
                    <span class="snr-val">${s.snr || 0}</span>
                    <div class="snr-track"><div class="snr-fill ${snrClass(s.snr)}" style="height:${h}%"></div></div>
                    <span class="snr-prn">${s.prn}</span></div>`;
            }).join("");
        return `<div class="snr-group"><div class="snr-group-name">${name}</div><div class="snr-row">${bars}</div></div>`;
    }).join("");
}

function toggleSpeedUnit() {
    speedUnit = (speedUnit === "KMH") ? "MPH" : "KMH";
    document.getElementById("speedUnit").textContent = speedUnit;
}

function toggleAutoCenter() {
    autoCenter = !autoCenter;
    updateAutoCenterButton();
}

function updateAutoCenterButton() {
    const btn = document.getElementById("autoCenterToggle");
    if (autoCenter) {
        btn.classList.add("active");
        btn.title = "Auto-Center Locked";
    } else {
        btn.classList.remove("active");
        btn.title = "Auto-Center Unlocked";
    }
}

// Centre on the GPS position and follow it again
function recenterMap() {
    if (!gpsFix) {
        showMapToast("No GPS fix yet");
        return;
    }
    autoCenter = true;
    updateAutoCenterButton();
    map.setView(gpsFix, Math.max(map.getZoom(), 16));
}

let toastTimer = null;
function showMapToast(text) {
    let toast = document.getElementById("mapToast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "mapToast";
        toast.className = "map-toast";
        document.querySelector(".map-container").appendChild(toast);
    }
    toast.textContent = text;
    toast.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = "none"; }, 2500);
}

// Shutdown dialog: SHUT DOWN stays disabled until the tick box is ticked
function toggleShutdownModal() {
    const modal = document.getElementById("shutdownModal");
    const opening = modal.style.display === "none";
    document.getElementById("shutdownConfirm").checked = false;
    updateShutdownButton();
    modal.style.display = opening ? "flex" : "none";
}

function updateShutdownButton() {
    document.getElementById("shutdownGo").disabled = !document.getElementById("shutdownConfirm").checked;
}

async function shutdownPi() {
    if (!document.getElementById("shutdownConfirm").checked) return;
    const note = document.getElementById("shutdownNote");
    try {
        const res = await fetch("/api/system/shutdown", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirm: true })
        });
        if (!res.ok) throw new Error((await res.json()).detail || res.status);
        note.textContent = "Shutting down. Wait for the Pi's green light to stop flashing before removing power.";
        document.querySelector("#shutdownModal .confirm-check").style.display = "none";
        document.querySelector("#shutdownModal .shutdown-buttons").style.display = "none";
    } catch (err) {
        note.textContent = `Shutdown failed: ${err.message}`;
    }
}

async function toggleLogsModal() {
    const modal = document.getElementById("logsModal");
    if (modal.style.display === "none") {
        modal.style.display = "flex";
        loadBackupStatus();
        await loadDailyLogsList();
    } else {
        modal.style.display = "none";
    }
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function loadDailyLogsList() {
    const container = document.getElementById("logsList");
    container.innerHTML = "Loading logs...";
    try {
        const res = await fetch("/api/logs/list");
        const data = await res.json();
        
        if (!data.logs || data.logs.length === 0) {
            container.innerHTML = `<p>No log files in the last ${data.days || 10} days.</p>`;
            return;
        }

        let html = "";
        data.logs.forEach(group => {
            html += `<div class="log-date-group">
                <div class="log-date-header">📅 ${group.date}${group.files.length > 1 ? ` · ${group.files.length} files (one per boot)` : ""}</div>`;
            group.files.forEach(f => {
                const url = `/api/logs/download/${encodeURIComponent(group.date)}/${encodeURIComponent(f.name)}`;
                html += `<div class="log-file-item">
                    <span>📄 ${f.name} <small>${formatBytes(f.size)}</small></span>
                    <a href="${url}" download>DOWNLOAD</a>
                </div>`;
            });
            html += `</div>`;
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = "<p>Error loading log list.</p>";
    }
}

// Alerts: a sensor that stops sending (a USB plug shaken loose), overheating, shutdown.
// GPS "no data" means gpsd hears nothing at all; searching for satellites is not an alert.
const GPS_SILENT_S = 15;
const IMU_SILENT_S = 10;
const ALERT_GRACE_MS = 10000;  // sensors take a few seconds to report after the page or service starts
const pageLoadedAt = Date.now();
let serviceFailures = 0;

function collectAlerts(data) {
    const alerts = [];
    if (data.shutting_down) return [{ text: "⏻ Shutting down", critical: true }];
    if (data.overheat_shutdown_in != null) {
        alerts.push({ text: `🔥 CPU ${Math.round(data.cpu_temp)}°C: overheat shutdown in ${data.overheat_shutdown_in}s`, critical: true });
    } else if (data.overheat_warn) {
        alerts.push({ text: `🌡️ CPU ${Math.round(data.cpu_temp)}°C: running hot` });
    }
    if (Date.now() - pageLoadedAt > ALERT_GRACE_MS && data.mode !== "Simulation") {
        if (data.gps_data_age_s == null || data.gps_data_age_s > GPS_SILENT_S) {
            alerts.push({ text: "📡 GPS: no data, check its USB plug", critical: true });
        }
        if (data.imu_data_age_s == null || data.imu_data_age_s > IMU_SILENT_S) {
            alerts.push({ text: "📳 IMU: no data, check the M5Stick" });
        }
    }
    return alerts;
}

function showAlerts(alerts) {
    const banner = document.getElementById("alertBanner");
    if (!alerts.length) {
        banner.style.display = "none";
        return;
    }
    banner.replaceChildren(...alerts.map(a => {
        const line = document.createElement("div");
        line.textContent = a.text;
        if (a.critical) line.className = "critical";
        return line;
    }));
    banner.classList.toggle("critical", alerts.some(a => a.critical));
    banner.style.display = "flex";
}

// Quick taps anywhere on the Pi's LCD:
//   3 taps then a pause -> centre the map on the GPS position and follow it
//   5 taps -> 10 s shutdown countdown with a CANCEL button.
// The countdown is there because bumps can register as touches on the resistive screen.
const TAP_COUNT = 5;
const TAP_RECENTER_COUNT = 3;
const TAP_WINDOW_MS = 3000;
const TAP_SETTLE_MS = 700;  // no tap for this long ends a sequence (so 3 can't fire on the way to 5)
const TAP_COUNTDOWN_S = 10;
let tapTimes = [];
let tapCountdownTimer = null;
let tapSettleTimer = null;

function initTapShutdown() {
    if (document.documentElement.classList.contains("remote")) return;  // LCD only
    document.addEventListener("pointerdown", () => {
        if (tapCountdownTimer || document.getElementById("shutdownModal").style.display !== "none") return;
        const now = Date.now();
        tapTimes = tapTimes.filter(t => now - t < TAP_WINDOW_MS);
        tapTimes.push(now);
        clearTimeout(tapSettleTimer);
        if (tapTimes.length >= TAP_COUNT) {
            tapTimes = [];
            startTapShutdown();
            return;
        }
        tapSettleTimer = setTimeout(() => {
            if (tapTimes.length === TAP_RECENTER_COUNT) recenterMap();
            tapTimes = [];
        }, TAP_SETTLE_MS);
    }, true);
}

function startTapShutdown() {
    let left = TAP_COUNTDOWN_S;
    const count = document.getElementById("tapCountdown");
    count.textContent = left;
    document.getElementById("tapShutdownNote").textContent = "5 taps detected. Tap CANCEL to keep running.";
    document.getElementById("tapShutdownCancel").style.display = "";
    document.getElementById("tapShutdownModal").style.display = "flex";
    tapCountdownTimer = setInterval(async () => {
        left -= 1;
        count.textContent = left;
        if (left > 0) return;
        clearInterval(tapCountdownTimer);
        const note = document.getElementById("tapShutdownNote");
        document.getElementById("tapShutdownCancel").style.display = "none";
        try {
            const res = await fetch("/api/system/shutdown", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirm: true, source: "taps" })
            });
            if (!res.ok) throw new Error((await res.json()).detail || res.status);
            note.textContent = "Shutting down. Wait for the Pi's green light to stop flashing before removing power.";
        } catch (err) {
            note.textContent = `Shutdown failed: ${err.message}`;
            setTimeout(cancelTapShutdown, 4000);
        }
    }, 1000);
}

function cancelTapShutdown() {
    clearInterval(tapCountdownTimer);
    tapCountdownTimer = null;
    tapTimes = [];
    document.getElementById("tapShutdownModal").style.display = "none";
}

// Google Drive backup line in the LOGS window (from the gps-log-backup service, every 3 h)
function timeAgo(unix) {
    const mins = Math.round((Date.now() / 1000 - unix) / 60);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    return hours < 48 ? `${hours} h ${mins % 60} min ago` : `${Math.floor(hours / 24)} days ago`;
}

function clockTime(unix) {
    return new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function loadBackupStatus() {
    const el = document.getElementById("backupStatus");
    el.className = "backup-status";
    try {
        const b = await (await fetch("/api/backup/status")).json();
        if (!b.configured) {
            el.textContent = "☁️ Drive backup: not set up";
            return;
        }
        const next = b.next_run ? ` · next ${clockTime(b.next_run)}` : "";
        if (b.last_result === "success") {
            el.textContent = `☁️ Backed up to Drive ${timeAgo(b.last_success)}${next}`;
            el.classList.add("ok");
        } else if (b.last_run) {
            const good = b.last_success ? `last good ${timeAgo(b.last_success)}` : "never succeeded";
            el.textContent = `☁️ Last backup failed (no internet?), ${good}${next}`;
            el.classList.add("warn");
        } else {
            el.textContent = `☁️ Drive backup: waiting for first run${next}`;
        }
    } catch (err) {
        el.textContent = "☁️ Drive backup: status unavailable";
    }
}
