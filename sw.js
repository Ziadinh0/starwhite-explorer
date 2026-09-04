// --- Position de départ : paramètres URL (lancement) ou localStorage (F5) ---
// Les paramètres URL sont immunisés contre toute race condition localStorage.
// Après lecture, on nettoie l'URL pour que F5 utilise la dernière position (shipLat/shipLon).
(function() {
    var urlParams = new URLSearchParams(window.location.search);
    var sLat = parseFloat(urlParams.get('spawnLat'));
    var sLon = parseFloat(urlParams.get('spawnLon'));
    if (!isNaN(sLat) && !isNaN(sLon)) {
        localStorage.setItem("shipLat", sLat.toString());
        localStorage.setItem("shipLon", sLon.toString());
        // Nettoyer l'URL : conserver captain=1 si présent, retirer spawnLat/spawnLon
        if (window.history && window.history.replaceState) {
            var captainVal = urlParams.get('captain') === '1' ? '?captain=1' : '';
            window.history.replaceState(null, '', 'StarwhiteExplorer.html' + captainVal);
        }
    }
    // Nettoyer les anciens flags localStorage (vestiges des tentatives précédentes)
    localStorage.removeItem("spawnLat");
    localStorage.removeItem("spawnLon");
    localStorage.removeItem("useInitialPosition");
})();

// Mode capitaine (ouvre la carte via startSimulation) ou spectateur (URL partagée)
var IS_CAPTAIN = new URLSearchParams(window.location.search).get('captain') === '1';
var lastFirebaseShipWrite = 0;
var viewerClosestPortsCounter = 0;

// Initialiser les coordonnées de départ depuis le localStorage
var initialLat = parseFloat(localStorage.getItem('initialLat')) || 32.40075;
var initialLon = parseFloat(localStorage.getItem('initialLon')) || 32.97203;

// Centrer la carte sur la position actuelle du navire (shipLat/shipLon déjà corrects après l'IIFE)
var _mapCenterLat = parseFloat(localStorage.getItem('shipLat')) || initialLat;
var _mapCenterLon = parseFloat(localStorage.getItem('shipLon')) || initialLon;

// Initialiser la carte centrée sur la position du navire
var map = L.map('map').setView([_mapCenterLat, _mapCenterLon], 6);

// Ajouter une couche de tuiles (OpenStreetMap)
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: 'Données cartographiques © OpenStreetMap',
    maxZoom: 18,
}).addTo(map);

// Facteur de vitesse temporaire pour tester (accélération)
// Initialiser la préférence speedFactor du navire
if (!localStorage.getItem("shipSpeedFactor")) {
    localStorage.setItem("shipSpeedFactor", "1");
}
var speedFactor = parseFloat(localStorage.getItem("shipSpeedFactor")) || 1;  // Récupérer depuis localStorage

// Variable pour tracker la visibilité du navire (Panne Cyber)
var shipMarkerVisible = true;

// Variables pour la Panne Cyber
var cyberFailureStartTime = null;  // Timestamp du début de la panne cyber
var cyberFailureCoords = null;     // Coordonnées du navire lors de la disparition
var cyberFailureTimer = null;      // ID de l'intervalle pour la mise à jour du chronomètre
var cyberFailureMarker = null;     // Marqueur rouge de la dernière localisation

// Variables pour le format de vitesse (nœuds ou km/h)
var useSpeedKmh = false;  // Par défaut en nœuds
var KNOTS_TO_KMH = 1.852;

var MAX_SHIP_SPEED_KNOTS = 25;
var SPEED_DIAL_MAX_KNOTS = MAX_SHIP_SPEED_KNOTS + 5;
var SPEED_DIAL_RED_THRESHOLD_KNOTS = 22;
var SPEED_DIAL_RADIUS = 63;
var SPEED_DIAL_START_ANGLE = 230;
var SPEED_DIAL_SWEEP_ANGLE = 260;
var speedDialBluePathLength = 0;
var speedDialRedPathLength = 0;

function getDialCartesian(centerX, centerY, radius, angleDeg) {
    var angleRad = angleDeg * Math.PI / 180;
    return {
        x: centerX + Math.sin(angleRad) * radius,
        y: centerY - Math.cos(angleRad) * radius
    };
}

function describeDialArc(centerX, centerY, radius, startAngle, endAngle) {
    var start = getDialCartesian(centerX, centerY, radius, startAngle);
    var end = getDialCartesian(centerX, centerY, radius, endAngle);
    var normalizedSweep = ((endAngle - startAngle) % 360 + 360) % 360;
    var largeArcFlag = normalizedSweep > 180 ? 1 : 0;

    return "M " + start.x.toFixed(2) + " " + start.y.toFixed(2) +
        " A " + radius + " " + radius + " 0 " + largeArcFlag + " 1 " + end.x.toFixed(2) + " " + end.y.toFixed(2);
}

// Fonction pour obtenir le max du cadran selon le format
function getSpeedDialMaxValue() {
    return useSpeedKmh ? Math.round(SPEED_DIAL_MAX_KNOTS * KNOTS_TO_KMH) : SPEED_DIAL_MAX_KNOTS;
}

// Fonction pour obtenir le seuil rouge selon le format
function getSpeedDialRedThreshold() {
    return useSpeedKmh ? Math.round(SPEED_DIAL_RED_THRESHOLD_KNOTS * KNOTS_TO_KMH) : SPEED_DIAL_RED_THRESHOLD_KNOTS;
}

// Fonction pour convertir nœuds en km/h ou réciproquement pour l'affichage
function getDisplaySpeed(speedKnots) {
    return useSpeedKmh ? speedKnots * KNOTS_TO_KMH : speedKnots;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function formatPercent(value) {
    return clamp(parseFloat(value) || 0, 0, 100).toFixed(1) + " %";
}

function updateGaugeFill(elementId, value) {
    var gaugeFill = document.getElementById(elementId);
    if (gaugeFill) {
        gaugeFill.style.width = clamp(parseFloat(value) || 0, 0, 100).toFixed(1) + "%";
    }
}

function initializeCompassTicks() {
    var ticksContainer = document.getElementById("compass-ticks");
    if (!ticksContainer || ticksContainer.childElementCount > 0) {
        return;
    }

    var center = 90;
    var outerRadius = 86;
    var innerRadius = 80.5;
    var svgNamespace = "http://www.w3.org/2000/svg";

    for (var angle = 0; angle < 360; angle += 10) {
        var tick = document.createElementNS(svgNamespace, "line");
        var angleRad = angle * Math.PI / 180;
        var x1 = center + Math.sin(angleRad) * innerRadius;
        var y1 = center - Math.cos(angleRad) * innerRadius;
        var x2 = center + Math.sin(angleRad) * outerRadius;
        var y2 = center - Math.cos(angleRad) * outerRadius;

        tick.setAttribute("x1", x1.toFixed(2));
        tick.setAttribute("y1", y1.toFixed(2));
        tick.setAttribute("x2", x2.toFixed(2));
        tick.setAttribute("y2", y2.toFixed(2));
        ticksContainer.appendChild(tick);
    }
}

function initializeSpeedDial() {
    var speedTicksContainer = document.getElementById("speed-ticks");
    var speedArcTrack = document.getElementById("speed-arc-track");
    var speedArcProgress = document.getElementById("speed-arc-progress");
    var speedArcProgressRed = document.getElementById("speed-arc-progress-red");
    var speedArcRedzone = document.getElementById("speed-arc-redzone");
    var speedNeedle = document.getElementById("speed-needle");
    var speedMinLabel = document.getElementById("speed-min-label");
    var speedMaxLabel = document.getElementById("speed-max-label");
    var center = 90;
    var startAngle = SPEED_DIAL_START_ANGLE;
    var endAngle = SPEED_DIAL_START_ANGLE + SPEED_DIAL_SWEEP_ANGLE;
    var maxValue = getSpeedDialMaxValue();
    var redThreshold = getSpeedDialRedThreshold();
    var thresholdRatio = clamp(redThreshold, 0, maxValue) / maxValue;
    var redZoneStartAngle = SPEED_DIAL_START_ANGLE + SPEED_DIAL_SWEEP_ANGLE * thresholdRatio;

    if (speedArcTrack) {
        speedArcTrack.setAttribute("d", describeDialArc(center, center, SPEED_DIAL_RADIUS, startAngle, endAngle));
    }

    if (speedArcRedzone) {
        speedArcRedzone.setAttribute("d", describeDialArc(center, center, SPEED_DIAL_RADIUS, redZoneStartAngle, endAngle));
    }

    if (speedArcProgress) {
        speedArcProgress.setAttribute("d", describeDialArc(center, center, SPEED_DIAL_RADIUS, startAngle, redZoneStartAngle));
        speedDialBluePathLength = speedArcProgress.getTotalLength();
        speedArcProgress.style.strokeDasharray = speedDialBluePathLength.toFixed(2);
        speedArcProgress.style.strokeDashoffset = speedDialBluePathLength.toFixed(2);
    }

    if (speedArcProgressRed) {
        speedArcProgressRed.setAttribute("d", describeDialArc(center, center, SPEED_DIAL_RADIUS, redZoneStartAngle, endAngle));
        speedDialRedPathLength = speedArcProgressRed.getTotalLength();
        speedArcProgressRed.style.strokeDasharray = speedDialRedPathLength.toFixed(2);
        speedArcProgressRed.style.strokeDashoffset = speedDialRedPathLength.toFixed(2);
    }

    if (speedNeedle) {
        speedNeedle.style.transform = "rotate(" + startAngle.toFixed(1) + "deg)";
    }

    if (speedMinLabel) {
        var minLabelPoint = getDialCartesian(center, center, SPEED_DIAL_RADIUS + 9, startAngle);
        speedMinLabel.setAttribute("x", (minLabelPoint.x + 18).toFixed(2));
        speedMinLabel.setAttribute("y", (9 + minLabelPoint.y + 3).toFixed(2));
    }

    if (speedMaxLabel) {
        var maxLabelPoint = getDialCartesian(center, center, SPEED_DIAL_RADIUS + 9, endAngle);
        speedMaxLabel.setAttribute("x", (maxLabelPoint.x - 18).toFixed(2));
        speedMaxLabel.setAttribute("y", (9 + maxLabelPoint.y + 3).toFixed(2));
        speedMaxLabel.textContent = String(getSpeedDialMaxValue());
    }

    if (!speedTicksContainer || speedTicksContainer.childElementCount > 0) {
        return;
    }

    var svgNamespace = "http://www.w3.org/2000/svg";
    var tickOuterRadius = SPEED_DIAL_RADIUS;

    for (var speed = 0; speed <= SPEED_DIAL_MAX_KNOTS; speed += 1) {
        var ratio = speed / SPEED_DIAL_MAX_KNOTS;
        var angle = SPEED_DIAL_START_ANGLE + ratio * SPEED_DIAL_SWEEP_ANGLE;
        var angleRad = angle * Math.PI / 180;
        var isMajor = speed % 5 === 0;
        var tickInnerRadius = isMajor ? tickOuterRadius - 8 : tickOuterRadius - 4.5;

        var tick = document.createElementNS(svgNamespace, "line");
        tick.setAttribute("x1", (center + Math.sin(angleRad) * tickInnerRadius).toFixed(2));
        tick.setAttribute("y1", (center - Math.cos(angleRad) * tickInnerRadius).toFixed(2));
        tick.setAttribute("x2", (center + Math.sin(angleRad) * tickOuterRadius).toFixed(2));
        tick.setAttribute("y2", (center - Math.cos(angleRad) * tickOuterRadius).toFixed(2));

        if (isMajor) {
            tick.setAttribute("class", "major");
        }

        speedTicksContainer.appendChild(tick);
    }
}

function updateSpeedDial() {
    var speedNeedle = document.getElementById("speed-needle");
    var speedArcProgress = document.getElementById("speed-arc-progress");
    var speedArcProgressRed = document.getElementById("speed-arc-progress-red");
    var speedDisplayCenter = document.getElementById("speed-display-center");
    var maxValue = getSpeedDialMaxValue();
    var redThreshold = getSpeedDialRedThreshold();
    var displaySpeed = getDisplaySpeed(shipSpeedKnots);
    var speedRatio = clamp(displaySpeed, 0, maxValue) / maxValue;
    var speedAngle = SPEED_DIAL_START_ANGLE + speedRatio * SPEED_DIAL_SWEEP_ANGLE;
    var clampedThreshold = clamp(redThreshold, 0, maxValue);

    if (speedNeedle) {
        speedNeedle.style.transform = "rotate(" + speedAngle.toFixed(1) + "deg)";
    }

    // Mettre à jour l'affichage de la vitesse au centre
    if (speedDisplayCenter) {
        speedDisplayCenter.textContent = displaySpeed.toFixed(1);
    }

    if (speedArcProgress) {
        if (speedDialBluePathLength <= 0) {
            speedDialBluePathLength = speedArcProgress.getTotalLength();
            speedArcProgress.style.strokeDasharray = speedDialBluePathLength.toFixed(2);
        }

        var blueSpeedRatio = clampedThreshold > 0 ? clamp(displaySpeed, 0, clampedThreshold) / clampedThreshold : 0;
        var blueDashOffset = speedDialBluePathLength * (1 - blueSpeedRatio);
        speedArcProgress.style.strokeDashoffset = blueDashOffset.toFixed(2);
    }

    if (speedArcProgressRed) {
        if (speedDialRedPathLength <= 0) {
            speedDialRedPathLength = speedArcProgressRed.getTotalLength();
            speedArcProgressRed.style.strokeDasharray = speedDialRedPathLength.toFixed(2);
        }

        var redRange = maxValue - clampedThreshold;
        var redSpeedRatio = redRange > 0
            ? (clamp(displaySpeed, clampedThreshold, maxValue) - clampedThreshold) / redRange
            : 0;
        var redDashOffset = speedDialRedPathLength * (1 - redSpeedRatio);
        speedArcProgressRed.style.strokeDashoffset = redDashOffset.toFixed(2);
    }
}

function updateNavigationDisplay() {
    var capDisplay = document.getElementById("ship-cap-display");
    var speedDisplay = document.getElementById("ship-speed-display");
    var compassArrow = document.getElementById("compass-arrow");
    var compassWidget = document.querySelector(".compass-widget");
    var compassSize = compassWidget ? compassWidget.offsetWidth : 180;
    var compassCenter = compassSize / 2;
    var capLabelRadius = compassCenter + 34;
    var angleRad = shipCap * Math.PI / 180;
    var labelX = compassCenter + Math.sin(angleRad) * capLabelRadius;
    var labelY = compassCenter - Math.cos(angleRad) * capLabelRadius;

    if (capDisplay) {
        capDisplay.textContent = shipCap.toFixed(0) + "°";
        capDisplay.style.left = labelX.toFixed(1) + "px";
        capDisplay.style.top = labelY.toFixed(1) + "px";
    }

    if (speedDisplay) {
        var displaySpeed = getDisplaySpeed(shipSpeedKnots);
        var unit = useSpeedKmh ? "km/h" : "nd";
        speedDisplay.textContent = displaySpeed.toFixed(1) + " " + unit;
    }

    if (compassArrow) {
        compassArrow.style.transform = "rotate(" + shipCap + "deg)";
    }

    updateSpeedDial();
    updateElectricPowerDisplay();
}

function updateElectricPowerDisplay() {
    var electricPower = calculateElectricPower();
    var powerStatusElement = document.getElementById("puissance-electrique-status");
    var powerGaugeFill = document.getElementById("puissance-electrique-gauge-fill");
    
    if (powerStatusElement) {
        powerStatusElement.textContent = electricPower.toFixed(0) + " %";
    }
    
    if (powerGaugeFill) {
        powerGaugeFill.style.width = electricPower.toFixed(0) + "%";
    }
}

// Fonction pour calculer la distance Haversine entre deux points en km
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    var R = 6371;  // Rayon de la Terre en km
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;  // Distance en km
}

// Fonction pour convertir km en nautiques
function kmToNautical(km) {
    return km / 1.852;
}

// Fonction pour formatter la distance selon la préférence utilisateur
function formatDistance(distanceKm) {
    var useNautical = localStorage.getItem("distanceFormat") === "nm";
    if (useNautical) {
        return kmToNautical(distanceKm).toFixed(1) + ' mn';
    } else {
        return distanceKm.toFixed(1) + ' km';
    }
}

// Fonction pour obtenir la distance en km ou nm selon la préférence
function getDistanceValue(distanceKm) {
    var useNautical = localStorage.getItem("distanceFormat") === "nm";
    if (useNautical) {
        return kmToNautical(distanceKm).toFixed(2);
    } else {
        return distanceKm.toFixed(2);
    }
}

// Fonction pour dessiner la triangulation des 3 ports les plus proches
function drawClosestPortsTriangulation() {
    // Supprimer les polylines et labels précédentes
    triangulationPolylines.forEach(function(polyline) {
        map.removeLayer(polyline);
    });
    triangulationPolylines = [];
    
    triangulationLabels.forEach(function(label) {
        map.removeLayer(label);
    });
    triangulationLabels = [];
    
    if (allPorts.length === 0) {
        return;  // Pas de ports chargés
    }
    
    // Calculer les distances à tous les ports
    var portDistances = [];
    allPorts.forEach(function(port) {
        if (port.latitude && port.longitude) {
            var lat = parseFloat(port.latitude);
            var lon = parseFloat(port.longitude);
            var distanceKm = calculateHaversineDistance(shipCoords.lat, shipCoords.lon, lat, lon);
            portDistances.push({
                port: port,
                distance: distanceKm,
                lat: lat,
                lon: lon
            });
        }
    });
    
    // Trier par distance et prendre les 3 plus proches
    portDistances.sort(function(a, b) {
        return a.distance - b.distance;
    });
    var closestPorts = portDistances.slice(0, 3);
    
    // Couleurs pour les 3 ports: plus proche en vert, intermédiaire en bleu, plus éloigné en noir
    var colors = ['#22c55e', '#3b82f6', '#000000'];  // Vert, bleu, noir
    
    // Dessiner les polylines et les labels de distance
    closestPorts.forEach(function(item, index) {
        var color = colors[index];
        
        // Créer la polyline pointillée
        var polyline = L.polyline(
            [[shipCoords.lat, shipCoords.lon], [item.lat, item.lon]],
            {
                color: color,
                weight: 2,
                opacity: 0.7,
                dashArray: '8, 6',  // Pointillé: 8px pointillé, 6px espace
                className: 'triangulation-line'
            }
        ).addTo(map);
        triangulationPolylines.push(polyline);
        
        // Calculer le point milieu pour placer le label
        var midLat = (shipCoords.lat + item.lat) / 2;
        var midLon = (shipCoords.lon + item.lon) / 2;
        
        // Formatter la distance selon la préférence utilisateur
        var distanceLabel = formatDistance(item.distance);
        
        // Créer un marker invisible avec un label de distance
        var labelMarker = L.marker([midLat, midLon], {
            icon: L.divIcon({
                className: 'distance-label',
                html: '<div style="background-color: ' + color + '; color: white; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.3); border: 1px solid rgba(0,0,0,0.2);">' + distanceLabel + '</div>',
                iconSize: [70, 20],
                iconAnchor: [35, 10]
            })
        }).addTo(map);
        triangulationLabels.push(labelMarker);
    });
}

function getRangeNmForSpeed(speedKnots) {
    var points = [
        { speed: 8, rangeNm: 4000 },
        { speed: 18, rangeNm: 3000 },
        { speed: 25, rangeNm: 2200 }
    ];

    if (speedKnots <= points[0].speed) {
        return points[0].rangeNm;
    }

    if (speedKnots >= points[points.length - 1].speed) {
        return points[points.length - 1].rangeNm;
    }

    for (var index = 0; index < points.length - 1; index++) {
        var currentPoint = points[index];
        var nextPoint = points[index + 1];

        if (speedKnots >= currentPoint.speed && speedKnots <= nextPoint.speed) {
            var ratio = (speedKnots - currentPoint.speed) / (nextPoint.speed - currentPoint.speed);
            return currentPoint.rangeNm + ratio * (nextPoint.rangeNm - currentPoint.rangeNm);
        }
    }

    return points[1].rangeNm;
}

function getFuelConsumptionPercentForDistance(speedKnots, distanceNm) {
    if (distanceNm <= 0) {
        return 0;
    }

    var rangeNm = getRangeNmForSpeed(speedKnots);
    if (rangeNm <= 0) {
        return 0;
    }

    return (distanceNm / rangeNm) * 200;  // Multiplier par 2 la consommation de base
}

// Paramètres du navire
var rawShipSpeed = parseFloat(localStorage.getItem("shipSpeed"));
var shipSpeedKnots = isNaN(rawShipSpeed) ? 18 : clamp(rawShipSpeed, 0, MAX_SHIP_SPEED_KNOTS);  // Vitesse initiale en nœuds
var shipSpeedKmh = shipSpeedKnots * 1.852;  // Convertir les nœuds en km/h
var shipCap = parseFloat(localStorage.getItem("shipCap")) || 10;
var shipCoords = {
    lat: parseFloat(localStorage.getItem("shipLat")) || initialLat,
    lon: parseFloat(localStorage.getItem("shipLon")) || initialLon
};  // Coordonnées actuelles du navire
var currentFuelPercent = parseFloat(localStorage.getItem("carburant")) || 100;

// Créer une icône personnalisée pour les hôtels
var hotelIcon = L.icon({
    iconUrl: 'assets/images/hotel.PNG',  // Icône pour les hôtels
    iconSize: [30, 30],  // Taille de l'icône
    iconAnchor: [15, 15],  // Point d'ancrage (au centre)
    popupAnchor: [0, -15]  // Ancre pour le popup
});

// Créer une icône personnalisée pour le navire
var shipIcon = L.icon({
    iconUrl: 'assets/images/navire.png',  // Icône du navire
    iconSize: [50, 50],  // Taille de l'icône
    iconAnchor: [25, 25],  // Point d'ancrage (au centre)
    popupAnchor: [0, -20]  // Ancre pour le popup
});

// Position initiale du navire
var shipMarker = L.marker([shipCoords.lat, shipCoords.lon], {
    icon: shipIcon,
    rotationAngle: shipCap  // Ajoute l'angle de rotation
}).addTo(map);

// Variables pour la triangulation des ports
var allPorts = [];  // Tous les ports chargés
var triangulationPolylines = [];  // Polylines de la triangulation
var triangulationLabels = [];  // Labels de distance
var updateClosestPortsCounter = 0;  // Compteur pour réduire la fréquence de mise à jour

function initializeDashboardUI() {
    initializeCompassTicks();
    initializeSpeedDial();
    updateNavigationDisplay();
}

// Fonction pour initialiser le format de vitesse
function initializeSpeedFormat() {
    // Restaurer la préférence depuis localStorage
    useSpeedKmh = localStorage.getItem("speedFormat") === "kmh";
    
    var speedToggle = document.getElementById("speed-format-toggle");
    var speedLabel = document.getElementById("speed-format-label");
    
    if (!speedToggle || !speedLabel) {
        return;
    }
    
    // Definir l'état du checkbox
    speedToggle.checked = useSpeedKmh;
    speedLabel.textContent = useSpeedKmh ? "km/h" : "nœuds";
    
    // Listener pour les changements
    speedToggle.addEventListener("change", function() {
        useSpeedKmh = this.checked;
        localStorage.setItem("speedFormat", this.checked ? "kmh" : "knots");
        speedLabel.textContent = this.checked ? "km/h" : "nœuds";
        
        // Réinitialiser le cadran avec le nouveau format
        speedDialBluePathLength = 0;
        speedDialRedPathLength = 0;
        initializeSpeedDial();
        updateSpeedDial();
        updateNavigationDisplay();
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function() {
        initializeDashboardUI();
        initializeSpeedFormat();
    });
} else {
    initializeDashboardUI();
    initializeSpeedFormat();
}

// Fonction pour déplacer le navire en fonction de son cap
function moveShip() {
    // Recharger le speedFactor depuis localStorage à chaque mouvement
    speedFactor = parseFloat(localStorage.getItem("shipSpeedFactor")) || 1;
    
    // Vérifier l'état de la Panne Cyber
    var cyberFailure = localStorage.getItem("cyberFailure") || "OFF";
    
    // Calculer le mouvement en km par seconde (vitesse × facteur / 3600)
    var movementKm = (shipSpeedKmh * speedFactor / 3600);
    
    var movementNm = movementKm / 1.852;
    var angleRad = shipCap * Math.PI / 180;  // Convertir le cap en radians

    // Calculer le déplacement en latitude et longitude
    var deltaLat = movementKm * Math.cos(angleRad) / 111;  // 111 km = 1° de latitude
    var deltaLon = movementKm * Math.sin(angleRad) / (111 * Math.cos(shipCoords.lat * Math.PI / 180));

    // Mettre à jour les coordonnées du navire
    shipCoords.lat += deltaLat;
    shipCoords.lon += deltaLon;

    // Sauvegarder les coordonnées dans le localStorage
    localStorage.setItem("shipLat", shipCoords.lat.toString());
    localStorage.setItem("shipLon", shipCoords.lon.toString());

    // Resynchroniser si le carburant a été modifié manuellement depuis control.html
    var externalFuel = parseFloat(localStorage.getItem("carburant"));
    if (!isNaN(externalFuel) && Math.abs(externalFuel - currentFuelPercent) > 0.5) {
        currentFuelPercent = clamp(externalFuel, 0, 100);
    }

    var fuiteMultiplier = localStorage.getItem("fuiteCarburant") === "1" ? (parseFloat(localStorage.getItem("fuiteMultiplicateur")) || 50) : 1;
    var fuelConsumed = getFuelConsumptionPercentForDistance(shipSpeedKnots, movementNm) * fuiteMultiplier;
    currentFuelPercent = clamp(currentFuelPercent - fuelConsumed, 0, 100);
    localStorage.setItem("carburant", currentFuelPercent.toFixed(1));

    // Envoyer position et carburant dans Firebase toutes les secondes (capitaine uniquement)
    if (IS_CAPTAIN && typeof db !== 'undefined') {
        var nowTs = Date.now();
        if (nowTs - lastFirebaseShipWrite >= 1000) {
            lastFirebaseShipWrite = nowTs;
            db.ref('simulation/ship').update({
                lat: shipCoords.lat,
                lon: shipCoords.lon,
                carburant: parseFloat(currentFuelPercent.toFixed(1))
            }).catch(function(e) { console.error("Firebase ship:", e); });
        }
    }

    // Gérer la visibilité du navire selon l'état de la Panne Cyber
    if (cyberFailure === "ON") {
        // Masquer le navire et la triangulation
        if (shipMarkerVisible) {
            // Capturer les coordonnées avant de disparaître
            cyberFailureCoords = { lat: shipCoords.lat, lon: shipCoords.lon };
            
            shipMarker.remove();
            shipMarkerVisible = false;
            
            // Démarrer le chronomètre et afficher le panneau
            startCyberFailureTimer();
        }
        
        // Nettoyer la triangulation
        triangulationPolylines.forEach(function(polyline) {
            map.removeLayer(polyline);
        });
        triangulationPolylines = [];
        
        triangulationLabels.forEach(function(label) {
            map.removeLayer(label);
        });
        triangulationLabels = [];
    } else {
        // Afficher le navire et la triangulation
        if (!shipMarkerVisible) {
            // Arrêter le chronomètre et masquer le panneau
            stopCyberFailureTimer();
            
            shipMarker.addTo(map);
            shipMarkerVisible = true;
        }
        
        // Mettre à jour la position du navire sur la carte
        shipMarker.setLatLng([shipCoords.lat, shipCoords.lon]);

        // Appliquer la rotation de l'icône du navire en fonction du cap
        rotateShipIcon(shipMarker, shipCap);
        updateNavigationDisplay();

        // Mettre à jour le popup avec les nouvelles coordonnées et la vitesse
        shipMarker.bindPopup(`<b>SW Explorer</b><br>Latitude: ${shipCoords.lat.toFixed(2)}<br>Longitude: ${shipCoords.lon.toFixed(2)}<br>Vitesse : ${shipSpeedKmh.toFixed(2)} km/h<br>Cap : ${shipCap}°<br>Carburant : ${currentFuelPercent.toFixed(1)} %`);

        // Mettre à jour la triangulation des 3 ports les plus proches
        drawClosestPortsTriangulation();
    }

    // Mettre à jour les distances et temps des ports d'escale et des 6 ports les plus proches
    updateEscalePorts();
    
    // Réduire la fréquence d'appel à updateClosestPorts pour stabiliser les popups
    updateClosestPortsCounter++;
    if (updateClosestPortsCounter >= 5) {  // Appeler tous les 5 ticks (toutes les 5 secondes)
        updateClosestPorts();
        updateClosestPortsCounter = 0;
    }

    // Appeler la fonction toutes les secondes pour continuer le mouvement
    setTimeout(moveShip, 1000);
}

// Fonction pour charger et afficher les hôtels à partir d'un fichier CSV
function displayHotels() {
    Papa.parse("hotels.csv", {
        download: true,
        header: true,
        complete: function (results) {
            const hotels = results.data;

            hotels.forEach(function (hotel) {
                if (hotel.latitude && hotel.longitude) {
                    // Ajouter chaque hôtel avec son icône et son popup
                    var marker = L.marker([parseFloat(hotel.latitude), parseFloat(hotel.longitude)], { icon: hotelIcon }).addTo(map)
                        .bindPopup(`<b>Hôtel : ${hotel.name}</b><br>Latitude: ${hotel.latitude}<br>Longitude: ${hotel.longitude}`);
                    
                    addHoverPopup(marker);  // Ajoute le comportement de survol pour afficher le popup
                }
            });
        }
    });
}

// Fonction pour afficher les popups au survol
function addHoverPopup(marker) {
    marker.on('mouseover', function () {
        marker.openPopup();
    });
    marker.on('mouseout', function () {
        marker.closePopup();
    });
}

// Afficher les hôtels sur la carte
displayHotels();

// Fonction pour appliquer une rotation au navire pour indiquer le cap
function rotateShipIcon(marker, angle) {
    marker.setRotationAngle(angle);
}

// Stub: Met à jour les ports d'escale
function updateEscalePorts() {
    // TODO: Implémenter mise à jour des distances/temps des ports d'escale
}

// Stub: Met à jour les 6 ports les plus proches
function updateClosestPorts() {
    // TODO: Implémenter affichage des 6 ports les plus proches
}

// Calcule la puissance électrique basée sur les GE et la puissance moteur
function calculateElectricPower() {
    // Puissance moteur: 10-20% (minimum 10 car puissance moteur min 10%)
    var motorPower = parseFloat(localStorage.getItem("puissanceMoteur")) || 10;
    var motorContribution = Math.min(20, Math.max(10, motorPower));
    
    // Compter les GE en état "OK": 20% chacun
    var geCount = 0;
    var ge1Status = localStorage.getItem("ge1") || "OK";
    var ge2Status = localStorage.getItem("ge2") || "OK";
    var ge3Status = localStorage.getItem("ge3") || "OK";
    var ge4Status = localStorage.getItem("ge4") || "OK";
    
    if (ge1Status === "OK") geCount++;
    if (ge2Status === "OK") geCount++;
    if (ge3Status === "OK") geCount++;
    if (ge4Status === "OK") geCount++;
    
    var geContribution = geCount * 20;
    
    // Total: moteur (10-20%) + groupes électrogènes (0-80%)
    return Math.min(100, motorContribution + geContribution);
}

// Fonction pour surveiller les changements du cap dans le localStorage
function watchShipCap() {
    setInterval(function () {
        var newCap = parseFloat(localStorage.getItem("shipCap"));
        if (!isNaN(newCap)) {
            shipCap = newCap;
            // Seulement mettre à jour l'affichage si le navire est visible (pas en panne cyber)
            var cyberFailure = localStorage.getItem("cyberFailure") || "OFF";
            if (cyberFailure === "OFF" && shipMarkerVisible) {
                rotateShipIcon(shipMarker, shipCap);
                updateNavigationDisplay();
            }
        }
    }, 500);  // Vérifie deux fois par seconde
}

// Fonction pour surveiller les changements des groupes électrogènes et puissance moteur
function watchEquipmentState() {
    setInterval(function () {
        updateElectricPowerDisplay();
    }, 1000);  // Vérifie toutes les secondes
}

// Fonction pour surveiller les changements de la vitesse dans le localStorage
function watchShipSpeed() {
    setInterval(function () {
        var newSpeed = parseFloat(localStorage.getItem("shipSpeed"));
        if (!isNaN(newSpeed)) {
            var clampedSpeed = clamp(newSpeed, 0, MAX_SHIP_SPEED_KNOTS);
            if (clampedSpeed !== shipSpeedKnots) {
                shipSpeedKnots = clampedSpeed;
                shipSpeedKmh = shipSpeedKnots * 1.852;  // Mettre à jour la vitesse en km/h
                updateNavigationDisplay();
            }

            if (newSpeed !== clampedSpeed) {
                localStorage.setItem("shipSpeed", clampedSpeed.toFixed(1));
            }
        }
    }, 2000);  // Vérifie toutes les 2 secondes
}

// Récupérer la date initiale depuis le localStorage
// Si pas trouvée, créer avec la date ACTUELLE du système
var initialDate = localStorage.getItem("simulationDate");

if (!initialDate) {
    var now = new Date();
    var year = now.getFullYear();
    var month = String(now.getMonth() + 1).padStart(2, "0");
    var day = String(now.getDate()).padStart(2, "0");
    
    initialDate = year + "-" + month + "-" + day;
    
    // Sauvegarder en localStorage pour la cohérence
    localStorage.setItem("simulationDate", initialDate);
}

// L'heure interne est toujours fixée à 12:00 (non affichée, pour la cohérence interne)
var initialTime = "12:00";


function parseSimulationDateTime(dateValue, timeValue) {
    // Créer une date locale simple avec simplement la date et l'heure
    var parsed = new Date(dateValue + "T" + timeValue);
    if (isNaN(parsed.getTime())) {
        return new Date();
    }
    return parsed;
}

// Créer une variable pour la date courante de la simulation
var currentSimulationTime = parseSimulationDateTime(initialDate, initialTime);
var lastSimulationDate = initialDate;

// Fonction pour surveiller les changements de date et mettre à jour la date interne
function watchSimulationDateTime() {
    setInterval(function () {
        var storedDate = localStorage.getItem("simulationDate") || lastSimulationDate;

        // Vérifier si la date a changé
        if (storedDate !== lastSimulationDate) {
            lastSimulationDate = storedDate;
            currentSimulationTime = parseSimulationDateTime(storedDate, initialTime);
        }
    }, 1000);
}

// Date et heure - gérées en interne, pas affichées

// Initialiser au démarrage
watchSimulationDateTime();

// Fonction pour surveiller les changements des paramètres dans le localStorage et mettre à jour la légende
function watchEngineParameters() {
    setInterval(function () {
        // Récupérer les valeurs actuelles du localStorage
        var stabilisateur = localStorage.getItem("stabilisateur") || "OFF";
        var ge1 = localStorage.getItem("ge1") || "OK";
        var ge2 = localStorage.getItem("ge2") || "OK";
        var ge3 = localStorage.getItem("ge3") || "OK";
        var ge4 = localStorage.getItem("ge4") || "EnMaintenance";
        var carburant = localStorage.getItem("carburant") || "100";
        var puissanceMoteur = localStorage.getItem("puissanceMoteur") || "77";

        // Mettre à jour la légende sur la carte
        document.querySelector("#stabilisateur-status").textContent = stabilisateur;
        document.querySelector("#stabilisateur-status").className = `status ${stabilisateur.toLowerCase() === "on" ? "ok" : "off"}`;

        function applyGeneratorStatus(elementId, generatorIndex, generatorState) {
            var isOk = generatorState.toLowerCase() === "ok";
            var generatorElement = document.querySelector(elementId);
            generatorElement.textContent = String(generatorIndex);
            generatorElement.className = `generator-status status ${isOk ? "ok" : "danger"}`;
        }

        applyGeneratorStatus("#ge1-status", 1, ge1);
        applyGeneratorStatus("#ge2-status", 2, ge2);
        applyGeneratorStatus("#ge3-status", 3, ge3);
        applyGeneratorStatus("#ge4-status", 4, ge4);

        // Mettre à jour la puissance électrique calculée, le carburant et la puissance moteur
        var calculatedElectricPower = calculateElectricPower();
        document.querySelector("#puissance-electrique-status").textContent = calculatedElectricPower.toFixed(0) + " %";
        document.querySelector("#carburant-status").textContent = formatPercent(carburant);
        document.querySelector("#puissance-moteur-status").textContent = formatPercent(puissanceMoteur);
        updateGaugeFill("puissance-electrique-gauge-fill", calculatedElectricPower.toFixed(0));
        updateGaugeFill("carburant-gauge-fill", carburant);
        updateGaugeFill("puissance-moteur-gauge-fill", puissanceMoteur);
    }, 2000);  // Vérifie toutes les 2 secondes
}

function watchShipParameters() {
    setInterval(function () {
        var stabilite = localStorage.getItem("stabilite") || "normal";

        document.querySelector("#stabilite-status").textContent = stabilite;
        document.querySelector("#stabilite-status").className = `status ${stabilite.toLowerCase()}`;
    }, 2000);  // Vérifie toutes les 2 secondes
}

// Appeler la fonction de surveillance
watchEngineParameters();

// Appeler la fonction des axes du navire
watchShipParameters();

// Appeler la fonction de surveillance de la vitesse
watchShipSpeed();

// Appeler la fonction de surveillance
watchShipCap();

// Fonction pour animer l'indicateur de stabilité
var stabilityAnimationId = null;
var stabilityStartTime = Date.now(); // Temps de démarrage pour centrage initial

function animateStabilityBall() {
    const ball = document.getElementById("stabilityBall");
    const label = document.getElementById("stabilityLabel");
    
    if (!ball || !label) return;
    
    // Réinitialiser le temps de démarrage
    stabilityStartTime = Date.now();
    
    // Arrêter la précédente animation s'il existe
    if (stabilityAnimationId !== null) {
        clearInterval(stabilityAnimationId);
    }
    
    function updateStability() {
        const stabilite = localStorage.getItem("stabilite") || "normal";
        const stabiliteId = stabilite.toLowerCase();
        
        // Paramètres selon le niveau de stabilité
        let amplitudeX, amplitudeY, speed, statusClass;
        
        switch(stabiliteId) {
            case "normal":
                // Quasi immobile
                amplitudeX = 0.5;
                amplitudeY = 0;
                speed = 6000;
                statusClass = "status-normal";
                label.textContent = "Normal";
                break;
            case "moyen":
                // Oscillation gauche-droite uniquement, plus lente et moins large
                amplitudeX = 12; // Réduit
                amplitudeY = 0;  // Pas de mouvement vertical
                speed = 5000;    // Plus lent
                statusClass = "status-moyen";
                label.textContent = "Moyen";
                break;
            case "important":
                // Oscillation avec mouvement aléatoire, moins rapide
                amplitudeX = 30; // Largeur réduite
                amplitudeY = 15; // Hauteur réduite
                speed = 3500;    // Plus lent
                statusClass = "status-important";
                label.textContent = "Important";
                break;
            case "danger":
                // Oscillation sur diamètre réduit avec aléatoire, plus lent
                amplitudeX = 35; // Réduit de 55
                amplitudeY = 30; // Réduit de 50
                speed = 2000;    // Plus lent
                statusClass = "status-danger";
                label.textContent = "DANGER";
                break;
            default:
                amplitudeX = 0.5;
                amplitudeY = 0;
                speed = 1500;
                statusClass = "status-normal";
                label.textContent = stabilite;
        }
        
        // Mettre à jour la classe de couleur
        ball.className = "stability-ball " + statusClass;
        
        // Mouvement sinusoïdal contrôlé
        const elapsedTime = Date.now() - stabilityStartTime;
        const timeNormalized = (elapsedTime % speed) / speed * Math.PI * 2;
        let moveX = Math.sin(timeNormalized) * amplitudeX;
        let moveY = Math.sin(timeNormalized * 0.8) * amplitudeY;
        
        // Ajouter du mouvement aléatoire pour important et danger
        if (stabiliteId === "important" || stabiliteId === "danger") {
            const randomOffsetX = (Math.random() - 0.5) * 8; // Bruit aléatoire ±4px
            const randomOffsetY = (Math.random() - 0.5) * 6; // Bruit aléatoire ±3px
            moveX += randomOffsetX;
            moveY += randomOffsetY;
        }
        
        ball.style.transform = `translate(calc(-50% + ${moveX}px), calc(-50% + ${moveY}px))`;
    }
    
    // Mettre à jour immédiatement
    updateStability();
    
    // Ensuite à intervalles réguliers
    stabilityAnimationId = setInterval(updateStability, 30); // 30ms = ~33 FPS pour fluidité
}

// Lancer l'animation de stabilité avec délai pour s'assurer que les éléments existent
setTimeout(() => {
    animateStabilityBall();
}, 500);

// Fonction de mise à jour de l'affichage de vigilance
var vigilanceMarker = null;

function updateVigilanceDisplay() {
    var vigilanceContainer = document.getElementById("vigilanceDisplay");
    if (!vigilanceContainer) return;
    
    var level = "0";
    var vigilanceTimes = {};
    
    // Tenter d'accéder à localStorage (peut être bloqué par le navigateur)
    try {
        level = localStorage.getItem("vigilanceLevel") || "0";
        vigilanceTimes = JSON.parse(localStorage.getItem("vigilanceTimes")) || {};
    } catch(e) {
        // localStorage est bloqué - utiliser la valeur par défaut
        console.warn("localStorage non disponible:", e.message);
        level = "0";
    }
    
    // Si niveau 0, ne rien afficher
    if (level === "0") {
        vigilanceContainer.innerHTML = "";
        return;
    }
    
    // Afficher UNE SEULE alerte (le niveau le plus élevé)
    var html = "";
    
    var levelLabels = {
        "1": "⚠️ Vigilance",
        "2": "🚨 Crise",
        "3": "💀 Critique"
    };
    
    var levelTooltips = {
        "1": "⚠️ Vigilance niveau 1<br><br>Situation anormale détectée à bord, nécessitant une surveillance renforcée et une préparation à une possible dégradation.",
        "2": "🚨 Vigilance niveau 2 : Cellule de crise activée<br><br>Événement avéré impactant le navire ou ses passagers, nécessitant une mobilisation immédiate des équipes et une gestion active de la situation.",
        "3": "💀 Vigilance niveau 3 : Décès ou Navire endommagé<br><br>Situation critique avec perte de vie humaine ou menace grave sur l'intégrité du navire, engageant des décisions majeures et des mesures exceptionnelles."
    };
    
    var className = "";
    var tooltipClass = "";
    if (level === "1") {
        className = "vigilance-level-1";
        tooltipClass = "level-1";
    }
    else if (level === "2") {
        className = "vigilance-level-2";
        tooltipClass = "level-2";
    }
    else if (level === "3") {
        className = "vigilance-level-3";
        tooltipClass = "level-3";
    }
    
    html += '<div class="vigilance-alert ' + className + '">';
    html += '<div class="vigilance-tooltip ' + tooltipClass + '">' + levelTooltips[level] + '</div>';
    html += levelLabels[level];
    html += '</div>';
    
    vigilanceContainer.innerHTML = html;
    
    // Mettre à jour le marqueur sur la carte
    updateVigilanceMarker(level);
}

function updateVigilanceMarker(level) {
    if (!map) return;
    
    // Supprimer l'ancien marqueur
    if (vigilanceMarker) {
        map.removeLayer(vigilanceMarker);
        vigilanceMarker = null;
    }
    
    // Fonction désactivée - pas de marqueur sur la carte
}

// Appel initial immédiat
console.log("DEBUG: Appel updateVigilanceDisplay");
try {
    updateVigilanceDisplay();
} catch(e) {
    console.error("ERREUR updateVigilanceDisplay:", e);
}

// Mettre à jour la vigilance chaque 200ms pour capturer les changements
setInterval(updateVigilanceDisplay, 200);

// Appelle la fonction de rotation après le déplacement du navire
rotateShipIcon(shipMarker, shipCap);

// Créer une icône personnalisée pour les 6 ports les plus proches
var closestPortIcon = L.icon({
    iconUrl: 'assets/images/closest_port.png',  // Une icône plus grande pour les 6 ports les plus proches
    iconSize: [33, 33],  // Taille de l'icône
    iconAnchor: [15, 15],  // Point d'ancrage (au centre)
    popupAnchor: [0, -10]  // Ancre pour le popup
});

// Créer une icône personnalisée pour tous les autres ports
var smallPortIcon = L.icon({
    iconUrl: 'assets/images/small_port.png',  // Petite icône ronde pour les autres ports
    iconSize: [15, 15],  // Taille plus petite
    iconAnchor: [5, 5],  // Point d'ancrage au centre
    popupAnchor: [0, -5]  // Ancre pour le popup
});

// Liste des ports d'escale habituels avec une icône différente
var escalePorts = getEscalePortsFromStorage();

// Créer une icône personnalisée pour les ports d'escale
var escaleIcon = L.icon({
    iconUrl: 'assets/images/escale.png',  // Icône pour les ports d'escale
    iconSize: [50, 50],  // Taille de l'icône
    iconAnchor: [25, 25],  // Point d'ancrage (au centre)
    popupAnchor: [0, -20]  // Ancre pour le popup
});

// Ajouter les ports d'escale sur la carte et lier les marqueurs
escalePorts.forEach(function (port) {
    var portLatLng = L.latLng(port.lat, port.lon);
    var distance = map.distance([shipCoords.lat, shipCoords.lon], portLatLng);  // Distance en mètres
    var distanceKm = (distance / 1000).toFixed(2);  // Convertir en km
    var travelTime = (distanceKm / shipSpeedKmh).toFixed(2);  // Temps estimé en heures

    var marker = L.marker([port.lat, port.lon], { icon: escaleIcon }).addTo(map)
        .bindPopup(`<b>Port d'escale : ${port.name}</b><br>Distance : ${distanceKm} km<br>Temps estimé : ${travelTime} heures`);
    port.marker = marker;  // Lier le marqueur au port pour pouvoir le mettre à jour
});

// Fonction pour récupérer les ports d'escale depuis le localStorage
function getEscalePortsFromStorage() {
    var ports = [];
    for (var i = 1; i <= 5; i++) {
        var portName = localStorage.getItem(`port${i}_name`);
        var portLat = parseFloat(localStorage.getItem(`port${i}_lat`));
        var portLon = parseFloat(localStorage.getItem(`port${i}_lon`));

        if (portName && !isNaN(portLat) && !isNaN(portLon)) {
            ports.push({ name: portName, lat: portLat, lon: portLon });
        }
    }
    return ports;
}

function updateEscalePorts() {
    escalePorts.forEach(function (port) {
        var portLatLng = L.latLng(port.lat, port.lon);
        var distance = map.distance([shipCoords.lat, shipCoords.lon], portLatLng);  // Distance en mètres
        var distanceKm = (distance / 1000).toFixed(2);  // Convertir en km
        var travelTime = (distanceKm / shipSpeedKmh).toFixed(2);  // Temps estimé en heures

        // Mettre à jour le popup pour chaque port d'escale
        var popupContent = `<b>Port d'escale : ${port.name}</b><br>Distance : ${distanceKm} km<br>Temps estimé : ${travelTime} heures`;
        port.marker.setPopupContent(popupContent);  // Met à jour le contenu du popup
    });
}

var portMarkers = []; // Stocke les marqueurs des ports

// Fonction pour charger les ports les plus proches et les afficher
function updateClosestPorts() {
    Papa.parse("ports.csv", {
        download: true,
        header: true,
        complete: function (results) {
            const ports = results.data;
            const shipPosition = L.latLng(shipCoords.lat, shipCoords.lon);  // Position du navire

            // Ajouter une distance pour chaque port par rapport au navire
            ports.forEach(function (port) {
                if (port.latitude && port.longitude) {
                    port.distance = shipPosition.distanceTo([parseFloat(port.latitude), parseFloat(port.longitude)]);
                }
            });

            // Filtrer les ports avec des coordonnées valides
            const validPorts = ports.filter(port => port.latitude && port.longitude);

            // Trier les ports par distance croissante
            validPorts.sort((a, b) => a.distance - b.distance);

            // Effacer les anciens marqueurs des ports les plus proches
            portMarkers.forEach(marker => map.removeLayer(marker));
            portMarkers = [];

            // Afficher uniquement les 6 ports les plus proches
            const closestPorts = validPorts.slice(0, 6);
            closestPorts.forEach(function (port) {
                var distanceKm = parseFloat(port.distance / 1000);
                var distanceValue = getDistanceValue(distanceKm);
                var distanceUnit = localStorage.getItem("distanceFormat") === "nm" ? "mn" : "km";
                var travelTime = (distanceKm / shipSpeedKmh).toFixed(2);

                // Créer le popup avec le bon format
                var popupContent = `<b>${port.port_name}</b><br>Distance : ${distanceValue} ${distanceUnit}<br>Temps estimé : ${travelTime} heures`;
                
                // Ajouter un marqueur pour chaque port
                var marker = L.marker([parseFloat(port.latitude), parseFloat(port.longitude)], { icon: closestPortIcon })
                    .bindPopup(popupContent)
                    .addTo(map);

                addHoverPopup(marker);  // Applique le comportement hover similaire aux ports d'escale et au navire

                portMarkers.push(marker);  // Ajouter le marqueur dans le tableau pour une future mise à jour
            });
        }
    });
}

// Charger les ports au début - utiliser setTimeout pour s'assurer que le DOM est prêt
setTimeout(updateClosestPorts, 100);


// Paramètres de la tempête récupérés du localStorage ou valeurs par défaut
var stormCoords = {
    lat: parseFloat(localStorage.getItem('initialStormLat')) || 35.0,  // Latitude par défaut
    lon: parseFloat(localStorage.getItem('initialStormLon')) || 35.0   // Longitude par défaut
};
var stormCap = parseFloat(localStorage.getItem("stormCap")) || 180; // Cap initial récupéré du localStorage
var stormSpeedKmh = parseFloat(localStorage.getItem("stormSpeed")) || 80;  // Vitesse initiale de la tempête
var stormCoreRadius = parseFloat(localStorage.getItem("stormCoreSize")) || 50;  // Taille du cœur en km
var stormFrontRadius = parseFloat(localStorage.getItem("stormFrontSize")) || 150;  // Taille du front en km

// Supprimer les anciennes couches de tempête
var stormCore = null;
var stormFront = null;
var stormMiddle1 = null;
var stormMiddle2 = null;

// Fonction pour créer ou mettre à jour la tempête avec dégradé et animation
function updateStormDisplay() {
    var stormLatLng = [stormCoords.lat, stormCoords.lon];
    var coreRadiusM = stormCoreRadius * 1000;
    var frontRadiusM = stormFrontRadius * 1000;
    var radius2 = stormCoreRadius + (stormFrontRadius - stormCoreRadius) * 0.66;
    var radius1 = stormCoreRadius + (stormFrontRadius - stormCoreRadius) * 0.33;

    // Couche 1: Front externe (orange clair)
    if (!stormFront) {
        stormFront = L.circle(stormLatLng, {
            color: 'rgba(255, 140, 0, 0.3)',
            fillColor: '#ff8c00',
            fillOpacity: 0.1,
            weight: 1,
            radius: frontRadiusM,
            className: 'storm-layer storm-front'
        }).addTo(map).bindPopup("Front de la tempête");
    } else {
        stormFront.setLatLng(stormLatLng);
        stormFront.setRadius(frontRadiusM);
    }

    // Couche 2: Intermédiaire 2 (orange moyen)
    if (!stormMiddle2) {
        stormMiddle2 = L.circle(stormLatLng, {
            color: 'rgba(255, 100, 0, 0.4)',
            fillColor: '#ff6400',
            fillOpacity: 0.25,
            weight: 1,
            radius: radius2 * 1000,
            className: 'storm-layer storm-middle-2'
        }).addTo(map);
    } else {
        stormMiddle2.setLatLng(stormLatLng);
        stormMiddle2.setRadius(radius2 * 1000);
    }

    // Couche 3: Intermédiaire 1 (orange-rouge)
    if (!stormMiddle1) {
        stormMiddle1 = L.circle(stormLatLng, {
            color: 'rgba(220, 50, 0, 0.6)',
            fillColor: '#dc3200',
            fillOpacity: 0.5,
            weight: 2,
            radius: radius1 * 1000,
            className: 'storm-layer storm-middle-1'
        }).addTo(map);
    } else {
        stormMiddle1.setLatLng(stormLatLng);
        stormMiddle1.setRadius(radius1 * 1000);
    }

    // Couche 4: Cœur (rouge vif)
    if (!stormCore) {
        var radarAnalysis = localStorage.getItem("stormRadarAnalysis") || "Aucune analyse entrée pour le moment";
        var popupContent = "<b>🌪️ Tempête</b><br><br><b>Analyse Radar:</b><br>" + (radarAnalysis || "Aucune analyse entrée pour le moment").replace(/\n/g, '<br>');
        stormCore = L.circle(stormLatLng, {
            color: '#cc0000',
            fillColor: '#ff0000',
            fillOpacity: 0.8,
            weight: 2,
            radius: coreRadiusM,
            className: 'storm-layer storm-core'
        }).addTo(map).bindPopup(popupContent);
        
        // Ajouter le comportement hover une seule fois
        stormCore.on('mouseover', function() {
            stormCore.openPopup();
        }).on('mouseout', function() {
            stormCore.closePopup();
        });
        
        console.log("stormCore créé avec analyse:", radarAnalysis);
    } else {
        // Mettre à jour uniquement la position et le rayon
        stormCore.setLatLng(stormLatLng);
        stormCore.setRadius(coreRadiusM);
    }
}

// Fonction pour déplacer la tempête en fonction de son cap
function moveStorm() {
    // Récupérer le multiplicateur depuis localStorage ou utiliser la valeur par défaut
    var stormSpeedFactor = parseFloat(localStorage.getItem("stormSpeedFactor")) || 1;
    
    // Utiliser le stormSpeedFactor pour rendre le déplacement visible
    var movementKm = (stormSpeedKmh * stormSpeedFactor / 3600);  // Distance parcourue en km par seconde
    var angleRad = stormCap * Math.PI / 180;  // Convertir le cap en radians

    // Calculer le déplacement en latitude et longitude
    var deltaLat = movementKm * Math.cos(angleRad) / 111;  // 111 km = 1° de latitude
    var deltaLon = movementKm * Math.sin(angleRad) / (111 * Math.cos(stormCoords.lat * Math.PI / 180));

    // Mettre à jour les coordonnées de la tempête
    stormCoords.lat += deltaLat;
    stormCoords.lon += deltaLon;

    // Mettre à jour les cercles de la tempête avec les nouvelles coordonnées
    updateStormDisplay();

    // Envoyer position tempête dans Firebase (capitaine uniquement)
    if (IS_CAPTAIN && typeof db !== 'undefined') {
        db.ref('simulation/storm').update({
            lat: stormCoords.lat,
            lon: stormCoords.lon
        }).catch(function(e) { console.error("Firebase storm:", e); });
    }

    // Appeler la fonction plus fréquemment (tous les 500ms au lieu de 1s) pour plus de fluidité
    setTimeout(moveStorm, 500);
}

// Fonction pour surveiller les changements des paramètres de la tempête dans le localStorage
function watchStormParameters() {
    var lastRadarAnalysis = localStorage.getItem("stormRadarAnalysis") || "";
    
    setInterval(function () {
        // Récupérer les nouvelles valeurs du localStorage
        var newCap = parseFloat(localStorage.getItem("stormCap")) || stormCap;
        var newSpeed = parseFloat(localStorage.getItem("stormSpeed")) || stormSpeedKmh;
        var newCoreSize = parseFloat(localStorage.getItem("stormCoreSize")) || stormCoreRadius;
        var newFrontSize = parseFloat(localStorage.getItem("stormFrontSize")) || stormFrontRadius;
        var newRadarAnalysis = localStorage.getItem("stormRadarAnalysis") || "";

        // Mettre à jour si les paramètres physiques ont changé
        if (newCap !== stormCap || newSpeed !== stormSpeedKmh || newCoreSize !== stormCoreRadius || newFrontSize !== stormFrontRadius) {
            stormCap = newCap;
            stormSpeedKmh = newSpeed;
            stormCoreRadius = newCoreSize;
            stormFrontRadius = newFrontSize;

            // Mettre à jour l'affichage de la tempête
            updateStormDisplay();
            console.log("Paramètres de la tempête mis à jour !");
        }
        
        // Mettre à jour le popup si l'analyse radar a changé
        if (newRadarAnalysis !== lastRadarAnalysis && stormCore) {
            lastRadarAnalysis = newRadarAnalysis;
            var popupContent = "<b>🌪️ Tempête</b><br><br><b>Analyse Radar:</b><br>" + newRadarAnalysis.replace(/\n/g, '<br>');
            
            // Rebinder le popup pour forcer la mise à jour du contenu
            stormCore.unbindPopup();
            stormCore.bindPopup(popupContent);
            
            // Réattacher les event listeners
            stormCore.off('mouseover mouseout');
            stormCore.on('mouseover', function() {
                stormCore.openPopup();
            }).on('mouseout', function() {
                stormCore.closePopup();
            });
            
            console.log("Analyse radar mise à jour !");
        }
    }, 2000);  // Vérifie toutes les 2 secondes
}

// Fonction pour afficher tous les ports avec une petite icône
function displayAllPorts() {
    Papa.parse("ports.csv", {
        download: true,
        header: true,
        complete: function (results) {
            const ports = results.data;
            
            // Stocker tous les ports pour la triangulation
            allPorts = ports.filter(function(port) {
                return port.latitude && port.longitude;
            });

            // Afficher tous les ports avec une petite icône
            ports.forEach(function (port) {
                if (port.latitude && port.longitude) {
                    var marker = L.marker([parseFloat(port.latitude), parseFloat(port.longitude)], { icon: smallPortIcon }).addTo(map)
                        .bindPopup(`<b>${port.port_name}</b><br>Latitude: ${parseFloat(port.latitude).toFixed(2)}<br>Longitude: ${parseFloat(port.longitude).toFixed(2)}`);

                    // Ajouter un comportement de popup conditionnel si besoin
                    addHoverPopup(marker);
                } else {
                    console.warn(`Coordonnées manquantes pour le port : ${port.port_name}`);
                }
            });
        }
    });
}

// Initialiser l'affichage de la tempête
updateStormDisplay();

// Lancer la surveillance des changements
watchStormParameters();

// Appeler la fonction pour afficher tous les ports
displayAllPorts();

// =========================================================
// MODE SPECTATEUR : écouter Firebase en temps réel
// =========================================================
if (!IS_CAPTAIN && typeof db !== 'undefined') {
    db.ref('simulation').on('value', function(snapshot) {
        var data = snapshot.val();
        if (!data) return;

        // -- Navire --
        if (data.ship) {
            if (data.ship.lat != null) { shipCoords.lat = data.ship.lat; localStorage.setItem("shipLat", data.ship.lat); }
            if (data.ship.lon != null) { shipCoords.lon = data.ship.lon; localStorage.setItem("shipLon", data.ship.lon); }
            if (data.ship.cap != null) { shipCap = data.ship.cap; localStorage.setItem("shipCap", data.ship.cap); }
            if (data.ship.speed != null) { shipSpeedKnots = data.ship.speed; shipSpeedKmh = shipSpeedKnots * 1.852; localStorage.setItem("shipSpeed", data.ship.speed); }
            if (data.ship.carburant != null) { currentFuelPercent = data.ship.carburant; localStorage.setItem("carburant", data.ship.carburant); }
            if (data.ship.puissanceMoteur != null) localStorage.setItem("puissanceMoteur", data.ship.puissanceMoteur);
            if (data.ship.cyberFailure != null) localStorage.setItem("cyberFailure", data.ship.cyberFailure);

            var cyberF = data.ship.cyberFailure || "OFF";
            if (cyberF === "ON") {
                if (shipMarkerVisible) {
                    cyberFailureCoords = { lat: shipCoords.lat, lon: shipCoords.lon };
                    shipMarker.remove();
                    shipMarkerVisible = false;
                    startCyberFailureTimer();
                }
            } else {
                if (!shipMarkerVisible) { stopCyberFailureTimer(); shipMarker.addTo(map); shipMarkerVisible = true; }
                shipMarker.setLatLng([shipCoords.lat, shipCoords.lon]);
                rotateShipIcon(shipMarker, shipCap);
                shipMarker.bindPopup('<b>SW Explorer</b><br>Lat: ' + shipCoords.lat.toFixed(2) + '<br>Lon: ' + shipCoords.lon.toFixed(2) + '<br>Vitesse: ' + shipSpeedKmh.toFixed(1) + ' km/h<br>Cap: ' + shipCap + '°<br>Carburant: ' + currentFuelPercent.toFixed(1) + ' %');
                drawClosestPortsTriangulation();
                updateEscalePorts();
            }
            updateNavigationDisplay();

            viewerClosestPortsCounter++;
            if (viewerClosestPortsCounter >= 5) {
                updateClosestPorts();
                viewerClosestPortsCounter = 0;
            }
        }

        // -- Tempête --
        if (data.storm) {
            if (data.storm.lat != null) stormCoords.lat = data.storm.lat;
            if (data.storm.lon != null) stormCoords.lon = data.storm.lon;
            if (data.storm.cap != null) { stormCap = data.storm.cap; localStorage.setItem("stormCap", data.storm.cap); }
            if (data.storm.speed != null) { stormSpeedKmh = data.storm.speed; localStorage.setItem("stormSpeed", data.storm.speed); }
            if (data.storm.coreSize != null) { stormCoreRadius = data.storm.coreSize; localStorage.setItem("stormCoreSize", data.storm.coreSize); }
            if (data.storm.frontSize != null) { stormFrontRadius = data.storm.frontSize; localStorage.setItem("stormFrontSize", data.storm.frontSize); }
            if (data.storm.radarAnalysis != null) localStorage.setItem("stormRadarAnalysis", data.storm.radarAnalysis);
            updateStormDisplay();
        }

        // -- Équipements --
        if (data.equipment) {
            if (data.equipment.ge1) localStorage.setItem("ge1", data.equipment.ge1);
            if (data.equipment.ge2) localStorage.setItem("ge2", data.equipment.ge2);
            if (data.equipment.ge3) localStorage.setItem("ge3", data.equipment.ge3);
            if (data.equipment.ge4) localStorage.setItem("ge4", data.equipment.ge4);
            if (data.equipment.stabilisateur) localStorage.setItem("stabilisateur", data.equipment.stabilisateur);
            if (data.equipment.stabilite) localStorage.setItem("stabilite", data.equipment.stabilite);
            if (data.equipment.vigilanceLevel != null) localStorage.setItem("vigilanceLevel", String(data.equipment.vigilanceLevel));
        }
    });
}

// =========================================================
// MODE CAPITAINE : lancer la simulation physique
// =========================================================
if (IS_CAPTAIN) {
    moveStorm();
    moveShip();
}

// Initialiser la préférence de format de distance (par défaut en nm) et gérer le checkbox
function initializeDistanceFormat() {
    // Initialiser la préférence de format de distance (par défaut en nm)
    if (!localStorage.getItem("distanceFormat")) {
        localStorage.setItem("distanceFormat", "nm");
    }

    // Élément du checkbox et du label
    var distanceToggle = document.getElementById("distance-format-toggle");
    var distanceLabel = document.getElementById("distance-format-label");

    if (!distanceToggle || !distanceLabel) {
        console.warn("Distance format elements not found in DOM");
        return;
    }

    // Restaurer l'état du checkbox
    var isNautical = localStorage.getItem("distanceFormat") === "nm";
    distanceToggle.checked = isNautical;
    distanceLabel.textContent = isNautical ? "MN" : "KM";

    // Listener pour le changement de format
    distanceToggle.addEventListener("change", function() {
        var newFormat = this.checked ? "nm" : "km";
        localStorage.setItem("distanceFormat", newFormat);
        distanceLabel.textContent = this.checked ? "MN" : "KM";
        
        // Redessiner la triangulation avec le nouveau format
        drawClosestPortsTriangulation();
        
        // Recharger les 6 ports avec le nouveau format
        updateClosestPorts();
    });
}

// Exécuter quand le DOM est prêt
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeDistanceFormat);
} else {
    initializeDistanceFormat();
}

// Fonction pour démarrer le chronomètre de panne cyber
function startCyberFailureTimer() {
    // Arrêter tout chronomètre existant
    if (cyberFailureTimer) {
        clearInterval(cyberFailureTimer);
    }
    
    // Capturer l'heure actuelle et réinitialiser le chronomètre à 0
    cyberFailureStartTime = Date.now();
    
    // Afficher immédiatement 00:00:00.00
    var timerValue = document.getElementById("cyberTimerValue");
    if (timerValue) {
        timerValue.textContent = "00:00:00.00";
    }
    
    // Créer un marqueur rouge à la dernière localisation du navire
    if (cyberFailureCoords) {
        // Créer une icône personnalisée triangle rouge
        var redIcon = L.icon({
            iconUrl: 'assets/images/signal-lost.png',
            iconSize: [32, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -32]
        });
        
        // Créer le marqueur
        cyberFailureMarker = L.marker([cyberFailureCoords.lat, cyberFailureCoords.lon], { icon: redIcon });
        cyberFailureMarker.addTo(map);
        cyberFailureMarker.bindPopup('Dernière position<br>Lat: ' + cyberFailureCoords.lat.toFixed(4) + '<br>Lon: ' + cyberFailureCoords.lon.toFixed(4));
    }
    
    // Afficher le panneau
    var cyberPanel = document.getElementById("cyberFailurePanel");
    if (cyberPanel) {
        cyberPanel.style.display = "block";
    }
    
    // Afficher les coordonnées
    if (cyberFailureCoords && document.getElementById("cyberFailureCoords")) {
        var coordsText = cyberFailureCoords.lat.toFixed(4) + "°N, " + cyberFailureCoords.lon.toFixed(4) + "°E";
        document.getElementById("cyberFailureCoords").textContent = coordsText;
    }
    
    // Mettre à jour le chronomètre immédiatement
    updateCyberFailureTimer();
    
    // Mettre à jour le chronomètre toutes les 50ms pour l'effet de chiffres qui tournent vite
    cyberFailureTimer = setInterval(updateCyberFailureTimer, 50);
}

// Fonction pour mettre à jour le chronomètre
function updateCyberFailureTimer() {
    if (!cyberFailureStartTime) return;
    
    var totalElapsed = Date.now() - cyberFailureStartTime;
    var elapsed = Math.floor(totalElapsed / 1000);
    var milliseconds = Math.floor(totalElapsed % 1000 / 10); // Centièmes de seconde (00-99)
    var minutes = Math.floor(elapsed / 60);
    var seconds = elapsed % 60;
    var hours = Math.floor(minutes / 60);
    minutes = minutes % 60;
    
    // Formater le temps avec milliseconds
    var timeString = String(hours).padStart(2, '0') + ":" + 
                     String(minutes).padStart(2, '0') + ":" + 
                     String(seconds).padStart(2, '0') + "." +
                     String(milliseconds).padStart(2, '0');
    
    // Afficher le temps
    var timerValue = document.getElementById("cyberTimerValue");
    if (timerValue) {
        timerValue.textContent = timeString;
    }
    
    // Déterminer la couleur en fonction du temps écoulé (en minutes totales)
    var totalMinutes = Math.floor(elapsed / 60);
    var timerElement = document.getElementById("cyberTimerDisplay");
    
    if (timerElement) {
        timerElement.classList.remove("timer-black", "timer-orange", "timer-red-light", "timer-red-scarlet", "timer-pulse");
        
        if (totalMinutes < 10) {
            // 0-9 min: Blanc (noir de base du thème)
            timerElement.classList.add("timer-black");
        } else if (totalMinutes < 20) {
            // 10-19 min: Orange
            timerElement.classList.add("timer-orange");
        } else if (totalMinutes < 30) {
            // 20-29 min: Rouge clair
            timerElement.classList.add("timer-red-light");
        } else {
            // 30+ min: Rouge écarlate avec pulse
            timerElement.classList.add("timer-red-scarlet");
            timerElement.classList.add("timer-pulse");
        }
    }
}

// Fonction pour arrêter le chronomètre de panne cyber
function stopCyberFailureTimer() {
    // Arrêter l'intervalle
    if (cyberFailureTimer) {
        clearInterval(cyberFailureTimer);
        cyberFailureTimer = null;
    }
    
    // Réinitialiser les variables
    cyberFailureStartTime = null;
    cyberFailureCoords = null;
    
    // Supprimer le marqueur rouge
    if (cyberFailureMarker) {
        map.removeLayer(cyberFailureMarker);
        cyberFailureMarker = null;
    }
    
    // Masquer le panneau
    var cyberPanel = document.getElementById("cyberFailurePanel");
    if (cyberPanel) {
        cyberPanel.style.display = "none";
    }
}


