// Charger le fichier JSON et remplir le sélecteur de scénarios
fetch("data.json")
    .then(response => response.json())
    .then(data => {
        const selector = document.getElementById("scenario-selector");
        data.scenarios.forEach((scenario, index) => {
            let option = document.createElement("option");
            option.value = index;
            option.textContent = scenario.name;
            selector.appendChild(option);
        });
    })
    .catch(error => console.error("Erreur de chargement du fichier JSON :", error));

// Helper Firebase : écrit dans la base en ligne sans bloquer si Firebase est absent
function writeToFirebase(path, data) {
    if (typeof db === 'undefined') return;
    db.ref(path).update(data).catch(function(e) { console.error("Firebase write error:", e); });
}

const MAX_SHIP_SPEED_KNOTS = 25;
const MIN_ENGINE_POWER_PERCENT = 10;
const MAX_ENGINE_POWER_PERCENT = 100;
const INITIAL_FUEL_PERCENT = 89;

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function powerToSpeed(powerPercent) {
    var safePower = clamp(powerPercent, MIN_ENGINE_POWER_PERCENT, MAX_ENGINE_POWER_PERCENT);
    return ((safePower - MIN_ENGINE_POWER_PERCENT) / (MAX_ENGINE_POWER_PERCENT - MIN_ENGINE_POWER_PERCENT)) * MAX_SHIP_SPEED_KNOTS;
}

function speedToPower(speedKnots) {
    var safeSpeed = clamp(speedKnots, 0, MAX_SHIP_SPEED_KNOTS);
    return MIN_ENGINE_POWER_PERCENT + (safeSpeed / MAX_SHIP_SPEED_KNOTS) * (MAX_ENGINE_POWER_PERCENT - MIN_ENGINE_POWER_PERCENT);
}

function syncPowerFromSpeedInput(forceNormalize) {
    var speedInput = document.getElementById("vitesse");
    var powerInput = document.getElementById("puissanceMoteur");
    if (!speedInput || !powerInput) {
        return;
    }

    if (speedInput.value === "") {
        if (!forceNormalize) {
            return;
        }
        speedInput.value = "0";
    }

    var speedValue = parseFloat(speedInput.value);
    if (isNaN(speedValue)) {
        if (!forceNormalize) {
            return;
        }
        speedValue = 0;
    }

    var clampedSpeed = clamp(speedValue, 0, MAX_SHIP_SPEED_KNOTS);
    var computedPower = speedToPower(clampedSpeed);

    if (forceNormalize) {
        speedInput.value = clampedSpeed.toFixed(1);
    }
    powerInput.value = Math.round(computedPower);
}

function syncSpeedFromPowerInput(forceNormalize) {
    var speedInput = document.getElementById("vitesse");
    var powerInput = document.getElementById("puissanceMoteur");
    if (!speedInput || !powerInput) {
        return;
    }

    if (powerInput.value === "") {
        if (!forceNormalize) {
            return;
        }
        powerInput.value = String(MIN_ENGINE_POWER_PERCENT);
    }

    var powerValue = parseFloat(powerInput.value);
    if (isNaN(powerValue)) {
        if (!forceNormalize) {
            return;
        }
        powerValue = MIN_ENGINE_POWER_PERCENT;
    }

    var clampedPower = clamp(powerValue, MIN_ENGINE_POWER_PERCENT, MAX_ENGINE_POWER_PERCENT);
    var computedSpeed = powerToSpeed(clampedPower);

    if (forceNormalize) {
        powerInput.value = Math.round(clampedPower);
    }
    speedInput.value = computedSpeed.toFixed(1);
}

function initializePowerSpeedSync() {
    var speedInput = document.getElementById("vitesse");
    var powerInput = document.getElementById("puissanceMoteur");
    var speedLabel = document.getElementById("vitesse-label");
    var powerLabel = document.getElementById("puissance-moteur-label");
    if (!speedInput || !powerInput) {
        return;
    }

    speedInput.max = MAX_SHIP_SPEED_KNOTS;
    speedInput.min = 0;
    speedInput.step = 0.1;
    powerInput.min = MIN_ENGINE_POWER_PERCENT;
    powerInput.max = MAX_ENGINE_POWER_PERCENT;

    var carburantInput = document.getElementById("carburant");
    if (carburantInput) {
        var storedFuel = localStorage.getItem("carburant");
        carburantInput.value = storedFuel !== null ? parseFloat(storedFuel).toFixed(1) : INITIAL_FUEL_PERCENT;
        carburantInput._userEditing = false;
        carburantInput.addEventListener("focus", function () { carburantInput._userEditing = true; });
        carburantInput.addEventListener("blur", function () { carburantInput._userEditing = false; });
    }

    if (speedLabel) {
        speedLabel.textContent = "Vitesse du navire (en nœuds, max " + MAX_SHIP_SPEED_KNOTS + ") :";
    }
    if (powerLabel) {
        powerLabel.textContent = "Puissance moteur (en %, min " + MIN_ENGINE_POWER_PERCENT + ") :";
    }

    speedInput.addEventListener("input", function () {
        syncPowerFromSpeedInput(false);
    });
    speedInput.addEventListener("blur", function () {
        syncPowerFromSpeedInput(true);
    });

    powerInput.addEventListener("input", function () {
        syncSpeedFromPowerInput(false);
    });
    powerInput.addEventListener("blur", function () {
        syncSpeedFromPowerInput(true);
    });

    syncPowerFromSpeedInput(true);

    // Affichage temps réel du carburant en cours depuis localStorage
    setInterval(function () {
        var live = localStorage.getItem("carburant");
        var span = document.getElementById("carburant-live");
        if (span) {
            span.textContent = live !== null ? "(en cours : " + parseFloat(live).toFixed(1) + " %)" : "(en cours : --)";
        }
        // Mettre à jour le champ aussi, sauf si l'utilisateur est en train de le modifier
        var carburantInput = document.getElementById("carburant");
        if (carburantInput && !carburantInput._userEditing && live !== null) {
            carburantInput.value = parseFloat(live).toFixed(1);
        }
    }, 2000);
}

document.addEventListener("DOMContentLoaded", initializePowerSpeedSync);

// Charger le scénario sélectionné
function loadScenario() {
    var scenarioIndex = document.getElementById("scenario-selector").value;
    if (scenarioIndex !== "") {
        fetch("data.json")
            .then(response => response.json())
            .then(data => {
                var scenario = data.scenarios[scenarioIndex];
                document.getElementById("latitude").value = scenario.navire.latitude;
                document.getElementById("longitude").value = scenario.navire.longitude;
                document.getElementById("stormLat").value = scenario.tempete.latitude;
                document.getElementById("stormLon").value = scenario.tempete.longitude;

                // Remplir vitesse et cap du navire
                document.getElementById("vitesse").value = scenario.navire.vitesse;
                document.getElementById("cap").value = scenario.navire.cap;

                // Remplir les équipements
                if (scenario.equipements) {
                    document.getElementById("stabilisateur").value = scenario.equipements.stabilisateur || "OFF";
                    document.getElementById("ge1").value = scenario.equipements.ge1 || "OK";
                    document.getElementById("ge2").value = scenario.equipements.ge2 || "OK";
                    document.getElementById("ge3").value = scenario.equipements.ge3 || "OK";
                    document.getElementById("ge4").value = scenario.equipements.ge4 || "OK";
                    var puissanceInput = document.getElementById("puissanceMoteur");
                    if (puissanceInput) puissanceInput.value = scenario.equipements.puissanceMoteur || 77;
                }

                // Remplir les ports d'escale
                for (var i = 1; i <= 5; i++) {
                    document.getElementById(`port${i}_name`).value = scenario.ports[i - 1].name;
                    document.getElementById(`port${i}_lat`).value = scenario.ports[i - 1].lat;
                    document.getElementById(`port${i}_lon`).value = scenario.ports[i - 1].lon;
                }

                resetCarburant();
            })
            .catch(error => console.error("Erreur de chargement du scénario :", error));
    }
}

// Réinitialise le carburant à sa valeur initiale
function resetCarburant() {
    localStorage.setItem("carburant", INITIAL_FUEL_PERCENT);
    localStorage.setItem("fuiteCarburant", "0");
    var carburantInput = document.getElementById("carburant");
    if (carburantInput) {
        carburantInput.value = INITIAL_FUEL_PERCENT;
    }
    var fuiteCarburantInput = document.getElementById("fuiteCarburant");
    if (fuiteCarburantInput) {
        fuiteCarburantInput.checked = false;
    }
}

// Réinitialise tous les champs du formulaire
function resetFields() {
    resetCarburant();
    console.log("Carburant réinitialisé.");
}

// Fonction pour lancer la simulation
function startSimulation() {
    var lat = document.getElementById("latitude").value;
    var lon = document.getElementById("longitude").value;
    var stormLat = document.getElementById("stormLat").value;
    var stormLon = document.getElementById("stormLon").value;
    var speedInput = document.getElementById("vitesse");
    var powerInput = document.getElementById("puissanceMoteur");
    var clampedSpeed = clamp(parseFloat(speedInput.value) || 0, 0, MAX_SHIP_SPEED_KNOTS);
    var clampedPower = clamp(parseFloat(powerInput.value) || MIN_ENGINE_POWER_PERCENT, MIN_ENGINE_POWER_PERCENT, MAX_ENGINE_POWER_PERCENT);

    // Priorité à la vitesse saisie: la puissance suit proportionnellement
    clampedPower = speedToPower(clampedSpeed);
    speedInput.value = clampedSpeed.toFixed(1);
    powerInput.value = Math.round(clampedPower);

    // --- Navire : position et navigation ---
    localStorage.setItem("initialLat", lat);
    localStorage.setItem("initialLon", lon);
    // spawnLat/spawnLon : clés réservées au démarrage, jamais écrites par moveShip()
    // Immunise contre la race condition : l'ancienne fenêtre peut écrire shipLat sans danger
    localStorage.setItem("spawnLat", lat);
    localStorage.setItem("spawnLon", lon);
    localStorage.setItem("shipCap", document.getElementById("cap").value);
    localStorage.setItem("shipSpeed", clampedSpeed.toFixed(1));
    localStorage.setItem("puissanceMoteur", Math.round(clampedPower));
    localStorage.setItem("cyberFailure", "OFF");

    // --- Tempête ---
    localStorage.setItem("initialStormLat", stormLat);
    localStorage.setItem("initialStormLon", stormLon);
    localStorage.setItem("stormCap", document.getElementById("stormCap").value);
    localStorage.setItem("stormSpeed", document.getElementById("stormSpeed").value);
    localStorage.setItem("stormCoreSize", document.getElementById("stormCoreSize").value);
    localStorage.setItem("stormFrontSize", document.getElementById("stormFrontSize").value);

    // --- Équipements ---
    localStorage.setItem("stabilisateur", document.getElementById("stabilisateur").value);
    localStorage.setItem("ge1", document.getElementById("ge1").value);
    localStorage.setItem("ge2", document.getElementById("ge2").value);
    localStorage.setItem("ge3", document.getElementById("ge3").value);
    localStorage.setItem("ge4", document.getElementById("ge4").value);

    resetCarburant();

    for (var i = 1; i <= 5; i++) {
        var portName = document.getElementById(`port${i}_name`).value;
        var portLat = document.getElementById(`port${i}_lat`).value;
        var portLon = document.getElementById(`port${i}_lon`).value;
        localStorage.setItem(`port${i}_name`, portName);
        localStorage.setItem(`port${i}_lat`, portLat);
        localStorage.setItem(`port${i}_lon`, portLon);
    }

    // Écrire l'état initial complet dans Firebase pour tous les spectateurs
    if (typeof db !== 'undefined') {
        db.ref('simulation').set({
            ship: {
                lat: parseFloat(lat),
                lon: parseFloat(lon),
                cap: parseFloat(document.getElementById("cap").value),
                speed: clampedSpeed,
                speedFactor: 1,
                carburant: INITIAL_FUEL_PERCENT,
                puissanceMoteur: Math.round(clampedPower),
                cyberFailure: "OFF"
            },
            storm: {
                lat: parseFloat(stormLat),
                lon: parseFloat(stormLon),
                cap: parseFloat(document.getElementById("stormCap").value),
                speed: parseFloat(document.getElementById("stormSpeed").value),
                speedFactor: parseFloat(document.getElementById("stormSpeedFactor").value) || 1,
                coreSize: parseFloat(document.getElementById("stormCoreSize").value),
                frontSize: parseFloat(document.getElementById("stormFrontSize").value),
                radarAnalysis: localStorage.getItem("stormRadarAnalysis") || ""
            },
            equipment: {
                ge1: document.getElementById("ge1").value,
                ge2: document.getElementById("ge2").value,
                ge3: document.getElementById("ge3").value,
                ge4: document.getElementById("ge4").value,
                stabilisateur: document.getElementById("stabilisateur").value,
                stabilite: "normal",
                vigilanceLevel: "0"
            }
        }).catch(function(e) { console.error("Firebase init error:", e); });
    }

    // "swexplorer" : nom fixe + lat/lon en paramètres URL + mode capitaine
    window.open("StarwhiteExplorer.html?captain=1&spawnLat=" + lat + "&spawnLon=" + lon, "swexplorer");
}

// Fonction pour mettre à jour le cap du navire
function updateShipCap() {
    var newCap = document.getElementById("cap").value;
    localStorage.setItem("shipCap", newCap);
    writeToFirebase('simulation/ship', { cap: parseFloat(newCap) });
    alert("Le cap du navire a été mis à jour à " + newCap + "°.");
}

// Fonction pour mettre à jour la vitesse du navire
function updateShipSpeed() {
    var speedInput = document.getElementById("vitesse");
    var powerInput = document.getElementById("puissanceMoteur");
    var clampedSpeed = clamp(parseFloat(speedInput.value) || 0, 0, MAX_SHIP_SPEED_KNOTS);
    var computedPower = speedToPower(clampedSpeed);

    speedInput.value = clampedSpeed.toFixed(1);
    powerInput.value = Math.round(computedPower);

    localStorage.setItem("shipSpeed", clampedSpeed.toFixed(1));
    localStorage.setItem("puissanceMoteur", Math.round(computedPower));
    writeToFirebase('simulation/ship', { speed: clampedSpeed, puissanceMoteur: Math.round(computedPower) });
    alert("Vitesse mise à jour à " + clampedSpeed.toFixed(1) + " noeuds, puissance moteur à " + Math.round(computedPower) + " %.");
}

// Fonction pour mettre à jour le multiplicateur de vitesse du navire
function updateShipSpeedFactor() {
    var speedFactorInput = document.getElementById("shipSpeedFactor");
    var factor = parseFloat(speedFactorInput.value) || 1;
    var clampedFactor = Math.max(0.1, Math.min(factor, 1000));  // Limiter entre 0.1 et 1000
    
    speedFactorInput.value = clampedFactor.toFixed(1);
    localStorage.setItem("shipSpeedFactor", clampedFactor.toFixed(1));
    writeToFirebase('simulation/ship', { speedFactor: clampedFactor });
    alert("Multiplicateur de vitesse mis à jour à " + clampedFactor.toFixed(1) + "x");
}

// Fonction pour mettre à jour les équipements du navire
function updateEquipements() {
    var stabilisateur = document.getElementById("stabilisateur").value;
    var ge1 = document.getElementById("ge1").value;
    var ge2 = document.getElementById("ge2").value;
    var ge3 = document.getElementById("ge3").value;
    var ge4 = document.getElementById("ge4").value;
    var carburantRaw = document.getElementById("carburant").value;
    var carburant = carburantRaw !== "" ? carburantRaw : (localStorage.getItem("carburant") || INITIAL_FUEL_PERCENT);
    var fuiteCarburant = document.getElementById("fuiteCarburant").checked ? "1" : "0";
    var fuiteMultiplicateur = parseFloat(document.getElementById("fuiteMultiplicateur").value) || 50;
    var puissanceMoteur = document.getElementById("puissanceMoteur").value;
    var powerInput = document.getElementById("puissanceMoteur");
    var speedInput = document.getElementById("vitesse");
    var clampedPower = clamp(parseFloat(puissanceMoteur) || MIN_ENGINE_POWER_PERCENT, MIN_ENGINE_POWER_PERCENT, MAX_ENGINE_POWER_PERCENT);
    var computedSpeed = powerToSpeed(clampedPower);

    localStorage.setItem("stabilisateur", stabilisateur);
    localStorage.setItem("ge1", ge1);
    localStorage.setItem("ge2", ge2);
    localStorage.setItem("ge3", ge3);
    localStorage.setItem("ge4", ge4);
    localStorage.setItem("carburant", carburant);
    localStorage.setItem("fuiteCarburant", fuiteCarburant);
    localStorage.setItem("fuiteMultiplicateur", fuiteMultiplicateur);
    localStorage.setItem("puissanceMoteur", Math.round(clampedPower));
    localStorage.setItem("shipSpeed", computedSpeed.toFixed(1));

    powerInput.value = Math.round(clampedPower);
    speedInput.value = computedSpeed.toFixed(1);

    writeToFirebase('simulation/equipment', {
        ge1: ge1, ge2: ge2, ge3: ge3, ge4: ge4,
        stabilisateur: stabilisateur,
        puissanceMoteur: Math.round(clampedPower)
    });
    writeToFirebase('simulation/ship', {
        speed: parseFloat(computedSpeed.toFixed(1)),
        carburant: parseFloat(carburant),
        puissanceMoteur: Math.round(clampedPower)
    });

    alert("Les équipements ont été mis à jour.");
}

// Fonction pour mettre à jour la stabilité du navire
function updateShipState() {
    var stabilite = document.getElementById("stabilite").value;
    localStorage.setItem("stabilite", stabilite);
    writeToFirebase('simulation/equipment', { stabilite: stabilite });
    alert("L'état du navire a été mis à jour.");
}

// Fonction pour mettre à jour les paramètres de la tempête
function updateStormParameters() {
    var newCap = document.getElementById("stormCap").value;
    var newSpeed = document.getElementById("stormSpeed").value;
    var newSpeedFactor = document.getElementById("stormSpeedFactor").value;
    var newCoreSize = document.getElementById("stormCoreSize").value;
    var newFrontSize = document.getElementById("stormFrontSize").value;

    localStorage.setItem("stormCap", newCap);
    localStorage.setItem("stormSpeed", newSpeed);
    localStorage.setItem("stormSpeedFactor", newSpeedFactor);
    localStorage.setItem("stormCoreSize", newCoreSize);
    localStorage.setItem("stormFrontSize", newFrontSize);

    writeToFirebase('simulation/storm', {
        cap: parseFloat(newCap),
        speed: parseFloat(newSpeed),
        speedFactor: parseFloat(newSpeedFactor),
        coreSize: parseFloat(newCoreSize),
        frontSize: parseFloat(newFrontSize)
    });

    alert("Les paramètres de la tempête ont été mis à jour !");
}

// Fonction pour mettre à jour l'analyse radar de la tempête
function updateStormRadarAnalysis() {
    var radarText = document.getElementById("stormRadarAnalysis").value;
    console.log("Texte saisi:", radarText);
    
    if (radarText.trim() === "") {
        alert("Veuillez écrire une analyse avant de sauvegarder !");
        return;
    }
    
    localStorage.setItem("stormRadarAnalysis", radarText);
    console.log("Analyse radar sauvegardée dans localStorage:", radarText);
    alert("✓ Analyse radar sauvegardée !\n\nElle s'affichera dans le popup de la tempête dans quelques secondes.");
}

// Fonction pour mettre à jour le niveau de vigilance
function updateVigilanceLevel() {
    var level = document.getElementById("vigilanceLevel").value;
    
    // Tenter d'accéder à localStorage (peut être bloqué par le navigateur)
    try {
        localStorage.setItem("vigilanceLevel", level);
        writeToFirebase('simulation/equipment', { vigilanceLevel: level });
        
        // Récupérer ou initialiser l'objet des horaires de transition
        var vigilanceTimes = JSON.parse(localStorage.getItem("vigilanceTimes")) || {};
        
        // Enregistrer l'heure de transition si c'est un nouveau niveau
        if (level !== "0" && !vigilanceTimes[level]) {
            var now = new Date();
            var timeString = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            vigilanceTimes[level] = timeString;
            localStorage.setItem("vigilanceTimes", JSON.stringify(vigilanceTimes));
        }
        
        // Si on revient à 0, réinitialiser
        if (level === "0") {
            localStorage.setItem("vigilanceTimes", JSON.stringify({}));
        }
    } catch(e) {
        // localStorage est bloqué - afficher un avertissement
        console.warn("localStorage non disponible - vigilance ne sera pas persistée:", e.message);
    }
    
    var levelLabels = {
        "0": "RAS - Tout va bien",
        "1": "Vigilance",
        "2": "Crise en cours",
        "3": "Décès ou navire endommagé"
    };
    
    alert("✓ Niveau de vigilance mis à jour : " + levelLabels[level] + "\n(Note: Le stockage est désactivé dans ce navigateur)");
    console.log("Niveau de vigilance mis à jour:", level);
}
