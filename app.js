// ============================================================================
// SafetyWatch AI — Mobile-First Dashboard Logic (MQTT Cloud + GPS Engine)
// ============================================================================

let deviceState = {
  online: false,
  wifi: 'Disconnected',
  ip: '192.168.4.1',
  oled: 'Not Detected',
  lat: '12.9716',
  lon: '77.5946',
  accuracy: '15m',
  sos: false,
  sosTimestamp: 0,
  uptime: 0,
  battery: 100,
  mapsUrl: 'https://maps.google.com/?q=12.9716,77.5946',
  gpsActive: false
};

let map = null;
let marker = null;
let accuracyCircle = null;
let audioCtx = null;
let sirenOsc = null;
let sirenGain = null;
let isSirenMuted = false;
let autoGpsWatchId = null;
let mqttClient = null;

let familyContacts = [
  { id: '1', name: 'Mom (Primary)',  phone: '+91 9876543210', apiKey: '123456', relation: 'Primary Contact'   },
  { id: '2', name: 'Dad (Guardian)', phone: '+91 9876543211', apiKey: '654321', relation: 'Secondary Contact' }
];

let telemetryLogs = [];

// ── PERMISSION SPLASH & AUTO-ENTER ───────────────────────────────────────
function grantPermissions() {
  const btn = document.getElementById('btnGrant');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Acquiring GPS & Notification Permissions...';
  }

  let locationAcquired = false;

  // 1. Request GPS Geolocation
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const badge = document.getElementById('ps-loc');
        if (badge) {
          badge.textContent = '✓ Granted';
          badge.className = 'perm-badge granted';
        }
        onGPSPosition(pos);
        locationAcquired = true;
        enterDashboard();
      },
      (err) => {
        const badge = document.getElementById('ps-loc');
        if (badge) {
          badge.textContent = '⚠️ Denied';
          badge.className = 'perm-badge denied';
        }
        addTelemetryLog('LOC', 'GPS Permission Denied', err.message);
        // Enter dashboard anyway so user isn't stuck
        enterDashboard();
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  } else {
    enterDashboard();
  }

  // 2. Request Notification Permission
  if ('Notification' in window) {
    Notification.requestPermission().then((perm) => {
      const badge = document.getElementById('ps-noti');
      if (badge) {
        if (perm === 'granted') {
          badge.textContent = '✓ Granted';
          badge.className = 'perm-badge granted';
        } else {
          badge.textContent = '⚠️ Declined';
          badge.className = 'perm-badge denied';
        }
      }
    });
  }
}

function enterDashboard() {
  const splash = document.getElementById('splash');
  const app = document.getElementById('app');

  if (splash) {
    splash.classList.add('exit');
    setTimeout(() => {
      splash.style.display = 'none';
    }, 600);
  }

  if (app) {
    app.classList.add('show');
  }

  // Init app subsystems
  initMap();
  loadContactsFromStorage();
  renderContacts();
  startAutomaticMobileGPS();
  initMQTTBridge();

  addTelemetryLog('SYS', 'SafetyWatch Ready', 'All permissions granted — Dashboard active');
  renderUI();
}

// ── GPS TRACKING ─────────────────────────────────────────────────────────
function startAutomaticMobileGPS() {
  if (!navigator.geolocation) return;

  autoGpsWatchId = navigator.geolocation.watchPosition(
    (pos) => onGPSPosition(pos),
    (err) => addTelemetryLog('LOC', 'GPS Watch Error', err.message),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
  );
}

function onGPSPosition(pos) {
  const lat = pos.coords.latitude.toString();
  const lon = pos.coords.longitude.toString();
  const acc = Math.round(pos.coords.accuracy).toString();

  deviceState.lat = lat;
  deviceState.lon = lon;
  deviceState.accuracy = acc;
  deviceState.gpsActive = true;

  updateMapPosition(lat, lon, acc);
  renderUI();
}

function requestBrowserLocation() {
  if (!navigator.geolocation) return alert('Geolocation not supported');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      onGPSPosition(pos);
      addTelemetryLog('LOC', 'Manual GPS Refresh', `Lat: ${parseFloat(pos.coords.latitude).toFixed(5)}, Lon: ${parseFloat(pos.coords.longitude).toFixed(5)}`);
    },
    (err) => alert('GPS Error: ' + err.message),
    { enableHighAccuracy: true }
  );
}

// ── LEAFLET MAP ENGINE ───────────────────────────────────────────────────
function initMap() {
  const mapEl = document.getElementById('map');
  if (!mapEl || map) return;

  const defaultLat = parseFloat(deviceState.lat);
  const defaultLon = parseFloat(deviceState.lon);

  map = L.map('map', { zoomControl: false }).setView([defaultLat, defaultLon], 14);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 19
  }).addTo(map);

  const customIcon = L.divIcon({
    className: 'custom-map-marker',
    html: `<div style="width:20px; height:20px; background:#7C3AED; border:3px solid #fff; border-radius:50%; box-shadow:0 0 16px rgba(124,58,237,0.6);"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });

  marker = L.marker([defaultLat, defaultLon], { icon: customIcon }).addTo(map);

  accuracyCircle = L.circle([defaultLat, defaultLon], {
    color: '#7C3AED',
    fillColor: '#7C3AED',
    fillOpacity: 0.15,
    radius: 50
  }).addTo(map);
}

function updateMapPosition(lat, lon, accuracy = 15) {
  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);
  if (isNaN(latNum) || isNaN(lonNum)) return;

  const newLatLng = new L.LatLng(latNum, lonNum);
  if (marker) marker.setLatLng(newLatLng);
  if (accuracyCircle) {
    accuracyCircle.setLatLng(newLatLng);
    accuracyCircle.setRadius(parseFloat(accuracy) || 20);
  }

  if (map) map.panTo(newLatLng);

  const mapsUrl = `https://maps.google.com/?q=${latNum},${lonNum}`;
  deviceState.mapsUrl = mapsUrl;

  const mapsBtn = document.getElementById('googleMapsBtn');
  if (mapsBtn) mapsBtn.href = mapsUrl;

  const latEl = document.getElementById('latVal');
  const lonEl = document.getElementById('lonVal');
  const accEl = document.getElementById('accVal');
  const timeEl = document.getElementById('lastLocTime');

  if (latEl) latEl.textContent = latNum.toFixed(5);
  if (lonEl) lonEl.textContent = lonNum.toFixed(5);
  if (accEl) accEl.textContent = `${accuracy}m`;
  if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── MQTT CLOUD BRIDGE (HiveMQ Public) ────────────────────────────────────
const MQTT_BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const MQTT_SOS    = 'safetywatch/Jevin/sos';
const MQTT_LOC    = 'safetywatch/Jevin/location';
const MQTT_STATUS = 'safetywatch/Jevin/status';

function initMQTTBridge() {
  if (window.mqtt) {
    connectMQTT();
    return;
  }
  const s = document.createElement('script');
  s.src = 'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js';
  s.onload = connectMQTT;
  s.onerror = () => {
    updateMqttUI('error', 'Script Error', 'Failed to load MQTT.js');
    addTelemetryLog('ERR', 'MQTT Script Error', 'Failed to load CDN script');
  };
  document.head.appendChild(s);
}

function connectMQTT() {
  const cid = 'sw_mobile_' + Math.random().toString(16).slice(2, 8);
  updateMqttUI('connecting', 'Connecting...', 'Broker: broker.hivemq.com');
  addTelemetryLog('SYS', 'MQTT Connecting', 'HiveMQ Cloud Broker');

  mqttClient = mqtt.connect(MQTT_BROKER, {
    clientId: cid,
    clean: true,
    connectTimeout: 10000,
    reconnectPeriod: 3000,
    keepalive: 30
  });

  mqttClient.on('connect', () => {
    updateMqttUI('connected', 'Cloud Active ✓', 'Listening for ESP32 Watch SOS');
    mqttClient.subscribe([MQTT_SOS, MQTT_LOC, MQTT_STATUS], { qos: 1 });
    addTelemetryLog('SYS', 'MQTT Connected!', `Subscribed to ${MQTT_SOS}`);
    deviceState.online = true;
    renderUI();
  });

  mqttClient.on('message', (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());

      if (topic === MQTT_SOS) {
        if (payload.sos === true && !deviceState.sos) {
          deviceState.sos = true;
          deviceState.sosTimestamp = Date.now();
          if (payload.lat && payload.lat !== 'N/A') {
            deviceState.lat = payload.lat;
            deviceState.lon = payload.lon;
            updateMapPosition(payload.lat, payload.lon, 20);
          }
          addTelemetryLog('SOS', '🚨 HARDWARE SOS DETECTED!', 'ESP32 Button → MQTT Cloud → Mobile Dashboard');
          onInstantSOSDetected('Hardware Watch Button (MQTT)');
        } else if (payload.sos === false && deviceState.sos) {
          deviceState.sos = false;
          addTelemetryLog('SYS', 'SOS Reset via MQTT', 'Cleared from ESP32 Watch');
          triggerAudioSiren(false);
          renderUI();
        }
      }

      if (topic === MQTT_LOC && payload.lat && payload.lat !== 'N/A') {
        deviceState.lat = payload.lat;
        deviceState.lon = payload.lon;
        updateMapPosition(payload.lat, payload.lon, 20);
        addTelemetryLog('LOC', 'ESP32 GPS via MQTT', `Lat: ${payload.lat}, Lon: ${payload.lon}`);
      }

      if (topic === MQTT_STATUS) {
        deviceState.online = true;
        deviceState.wifi   = 'Online (MQTT)';
        deviceState.oled   = payload.oled || 'OK';
        deviceState.uptime = payload.uptime || 0;
        renderUI();
      }
    } catch (err) {}
  });

  mqttClient.on('error', (err) => {
    updateMqttUI('error', 'MQTT Error', err.message);
    addTelemetryLog('ERR', 'MQTT Error', err.message);
  });

  mqttClient.on('reconnect', () => {
    updateMqttUI('connecting', 'Reconnecting...', 'Retrying MQTT Cloud connection');
  });
}

function updateMqttUI(state, pillText, subText) {
  const pill = document.getElementById('mqttPill');
  const sub  = document.getElementById('mqttSub');

  if (pill) {
    pill.className = `mqtt-status-pill ${state}`;
    pill.textContent = pillText;
  }
  if (sub) sub.textContent = subText;
}

// ── SOS TRIGGER & WHATSAPP ENGINE ────────────────────────────────────────
function triggerSOSEvent() {
  deviceState.sos = true;
  deviceState.sosTimestamp = Date.now();

  // Publish to MQTT cloud broker if connected
  if (mqttClient && mqttClient.connected) {
    const payload = JSON.stringify({ sos: true, lat: deviceState.lat, lon: deviceState.lon, ts: Date.now() });
    mqttClient.publish(MQTT_SOS, payload, { qos: 1 });
  }

  onInstantSOSDetected('Mobile Web SOS Button');
}

function onInstantSOSDetected(triggerSource) {
  addTelemetryLog('SOS', '🚨 SOS EMERGENCY ACTIVATED', `Source: ${triggerSource}`);

  triggerAudioSiren(true);
  renderUI();
  broadcastAutoWhatsAppEmergency(triggerSource);
}

function broadcastAutoWhatsAppEmergency(source = 'SOS Emergency') {
  addTelemetryLog('SOS', 'Dispatching Automated WhatsApp Alerts...', `Contacts count: ${familyContacts.length}`);

  fetch('/api/auto-dispatch-sos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contacts: familyContacts,
      lat: deviceState.lat,
      lon: deviceState.lon,
      accuracy: deviceState.accuracy,
      mapsUrl: deviceState.mapsUrl,
      source: source
    })
  })
  .then((r) => r.json())
  .then((data) => {
    addTelemetryLog('SOS', '✅ CallMeBot API Dispatched', `Targeted ${data.dispatchedCount || familyContacts.length} numbers.`);
  })
  .catch(() => {
    addTelemetryLog('SOS', 'Launching wa.me WhatsApp Backup', 'Direct deep-link gateway active');
  });

  if (familyContacts.length > 0) {
    sendWhatsAppToContact(familyContacts[0].phone);
  }
}

function buildEmergencyMessage() {
  const mapsUrl = deviceState.mapsUrl || `https://maps.google.com/?q=${deviceState.lat},${deviceState.lon}`;
  const timestamp = new Date().toLocaleString();

  return `🚨 EMERGENCY ALERT - SAFETY WATCH 🚨\n\n` +
         `HARDWARE SOS BUTTON PRESSED!\n` +
         `📅 Time: ${timestamp}\n` +
         `📍 Location: ${deviceState.lat}, ${deviceState.lon}\n` +
         `🎯 Accuracy: ~${deviceState.accuracy}\n\n` +
         `🗺 Live Map: ${mapsUrl}`;
}

function sendWhatsAppToContact(phone) {
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const msg = encodeURIComponent(buildEmergencyMessage());
  const url = `https://wa.me/${cleanPhone}?text=${msg}`;
  window.open(url, '_blank');
  addTelemetryLog('SOS', 'WhatsApp Deep-Link Launched', `Target: ${phone}`);
}

function resetSOSState() {
  deviceState.sos = false;
  addTelemetryLog('SYS', 'SOS Cleared', 'System returned to Normal');
  triggerAudioSiren(false);

  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(MQTT_SOS, JSON.stringify({ sos: false }), { qos: 1 });
  }

  renderUI();
}

function triggerVibrationTest() {
  if (navigator.vibrate) {
    navigator.vibrate([300, 100, 300, 100, 500]);
    addTelemetryLog('SYS', 'Vibration Haptic Pulse', 'Triggered mobile motor');
  } else {
    alert('Haptic vibration triggered!');
  }
}

// ── AUDIO SIREN SYNTHESIZER ──────────────────────────────────────────────
function toggleAudioSiren() {
  isSirenMuted = !isSirenMuted;
  const btn = document.getElementById('sirenSoundBtn');
  if (btn) btn.style.opacity = isSirenMuted ? '0.4' : '1';

  if (isSirenMuted && sirenOsc) {
    triggerAudioSiren(false);
  } else if (!isSirenMuted && deviceState.sos) {
    triggerAudioSiren(true);
  }
}

function triggerAudioSiren(enable) {
  if (isSirenMuted) return;
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  if (enable) {
    if (sirenOsc) return;
    sirenOsc = audioCtx.createOscillator();
    sirenGain = audioCtx.createGain();

    sirenOsc.type = 'sawtooth';
    sirenOsc.frequency.setValueAtTime(600, audioCtx.currentTime);

    let high = false;
    setInterval(() => {
      if (sirenOsc && audioCtx) {
        sirenOsc.frequency.exponentialRampToValueAtTime(high ? 600 : 1200, audioCtx.currentTime + 0.3);
        high = !high;
      }
    }, 400);

    sirenGain.gain.setValueAtTime(0.18, audioCtx.currentTime);
    sirenOsc.connect(sirenGain);
    sirenGain.connect(audioCtx.destination);
    sirenOsc.start();
  } else {
    if (sirenOsc) {
      sirenOsc.stop();
      sirenOsc.disconnect();
      sirenOsc = null;
    }
  }
}

// ── UI RENDERING & TAB NAVIGATION ────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.tab-section').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));

  const tab = document.getElementById(`tab-${tabName}`);
  const nav = document.getElementById(`nav-${tabName}`);

  if (tab) tab.classList.add('active');
  if (nav) nav.classList.add('active');

  if (tabName === 'map' && map) {
    setTimeout(() => map.invalidateSize(), 200);
  }
}

function renderUI() {
  // SOS Banner
  const banner = document.getElementById('sosBanner');
  if (banner) banner.classList.toggle('show', deviceState.sos);

  if (deviceState.sos) {
    const bannerTime = document.getElementById('sosBannerTime');
    if (bannerTime) bannerTime.textContent = `Activated at ${new Date(deviceState.sosTimestamp || Date.now()).toLocaleTimeString()}`;
  }

  // Header stats
  const hdrDevDot = document.getElementById('hdrDevDot');
  const hdrDevice = document.getElementById('hdrDevice');
  if (hdrDevDot) hdrDevDot.className = `stat-dot ${deviceState.online ? 'dot-on' : 'dot-off'}`;
  if (hdrDevice) hdrDevice.textContent = deviceState.online ? 'Connected' : 'Offline';

  const hdrGpsDot = document.getElementById('hdrGpsDot');
  const hdrGps    = document.getElementById('hdrGps');
  if (hdrGpsDot) hdrGpsDot.className = `stat-dot ${deviceState.gpsActive ? 'dot-on' : 'dot-off'}`;
  if (hdrGps)    hdrGps.textContent    = deviceState.gpsActive ? 'Active' : 'Searching';

  const hdrSosDot = document.getElementById('hdrSosDot');
  const hdrSos    = document.getElementById('hdrSos');
  if (hdrSosDot) hdrSosDot.className = `stat-dot ${deviceState.sos ? 'dot-off' : 'dot-on'}`;
  if (hdrSos)    hdrSos.textContent  = deviceState.sos ? 'EMERGENCY' : 'Normal';

  // Status Cards
  const devTxt = document.getElementById('deviceStatusText');
  const dotDev = document.getElementById('dotDevice');
  if (devTxt) devTxt.textContent = deviceState.online ? 'Online ✓' : 'Offline';
  if (dotDev) dotDev.className   = `sc-dot ${deviceState.online ? 'ok' : 'bad'}`;

  const gpsTxt = document.getElementById('gpsStatusText');
  const dotGps = document.getElementById('dotGps');
  if (gpsTxt) gpsTxt.textContent = deviceState.gpsActive ? 'Active ✓' : 'Searching';
  if (dotGps) dotGps.className   = `sc-dot ${deviceState.gpsActive ? 'ok' : 'bad'}`;

  const sosTxt = document.getElementById('sosStatusText');
  const dotSos = document.getElementById('dotSos');
  if (sosTxt) {
    sosTxt.textContent = deviceState.sos ? 'EMERGENCY' : 'Normal';
    sosTxt.style.color = deviceState.sos ? 'var(--red)' : 'var(--text-1)';
  }
  if (dotSos) dotSos.className = `sc-dot ${deviceState.sos ? 'bad' : 'ok'}`;

  // GPS Map Pill
  const gpsPill = document.getElementById('gpsPill');
  const gpsAcc  = document.getElementById('gpsAccText');
  if (gpsPill) gpsPill.className = `gps-pill ${deviceState.gpsActive ? '' : 'off'}`;
  if (gpsAcc)  gpsAcc.textContent  = deviceState.gpsActive ? `Accuracy: ~${deviceState.accuracy}` : 'Searching...';

  // OLED Display Mirror
  const oledEl = document.getElementById('oledScreen');
  if (oledEl) {
    if (deviceState.sos) {
      oledEl.innerHTML = `🚨 EMERGENCY ALERT 🚨\nHELP NEEDED NOW!\nLat: ${deviceState.lat.substring(0, 7)}\nLon: ${deviceState.lon.substring(0, 7)}`;
    } else {
      oledEl.innerHTML = `SafetyWatch AI\nWiFi: ${deviceState.wifi}\nSOS: Normal\nLat: ${deviceState.lat.substring(0, 7)}\nLon: ${deviceState.lon.substring(0, 7)}`;
    }
  }
}

// ── CONTACTS MANAGEMENT ─────────────────────────────────────────────────
function toggleAddForm() {
  const form = document.getElementById('addForm');
  if (form) form.classList.toggle('show');
}

function formatIndianPhone(phone) {
  let cleaned = phone.replace(/[^0-9+]/g, '');
  if (/^[6-9]\d{9}$/.test(cleaned)) {
    cleaned = '+91' + cleaned;
  } else if (!cleaned.startsWith('+')) {
    cleaned = '+91' + cleaned;
  }
  return cleaned;
}

function saveContact() {
  const nameEl = document.getElementById('cName');
  const phoneEl = document.getElementById('cPhone');
  const keyEl = document.getElementById('cApiKey');
  const relEl = document.getElementById('cRelation');

  const name = nameEl ? nameEl.value.trim() : '';
  let phone = phoneEl ? phoneEl.value.trim() : '';
  const apiKey = keyEl ? keyEl.value.trim() || '123456' : '123456';
  const rel = relEl ? relEl.value.trim() || 'Family' : 'Family';

  if (!name || !phone || phone === '+91') {
    return alert('Please enter both name and phone number.');
  }

  phone = formatIndianPhone(phone);

  const newContact = { id: Date.now().toString(), name, phone, apiKey, relation: rel };
  familyContacts.push(newContact);
  saveContactsToStorage();
  renderContacts();

  if (nameEl) nameEl.value = '';
  if (phoneEl) phoneEl.value = '+91 ';
  if (keyEl) keyEl.value = '';
  if (relEl) relEl.value = '';
  toggleAddForm();

  addTelemetryLog('SYS', 'Contact Saved', `${name} (${phone})`);
}

function deleteContact(id) {
  familyContacts = familyContacts.filter((c) => c.id !== id);
  saveContactsToStorage();
  renderContacts();
  addTelemetryLog('SYS', 'Contact Deleted', `ID: ${id}`);
}

function saveContactsToStorage() {
  localStorage.setItem('safetyWatchFamilyContacts', JSON.stringify(familyContacts));
}

function loadContactsFromStorage() {
  const saved = localStorage.getItem('safetyWatchFamilyContacts');
  if (saved) {
    try { familyContacts = JSON.parse(saved); } catch (e) {}
  }
}

const AVATAR_COLORS = ['av-purple', 'av-orange', 'av-pink', 'av-teal', 'av-blue'];

function renderContacts() {
  const grid = document.getElementById('contactsGrid');
  if (!grid) return;

  if (familyContacts.length === 0) {
    grid.innerHTML = `<div style="text-align:center; padding:24px; color:var(--text-2); font-size:13px;">No emergency contacts added yet. Tap below to add your family members.</div>`;
    return;
  }

  grid.innerHTML = familyContacts.map((c, idx) => {
    const colorClass = AVATAR_COLORS[idx % AVATAR_COLORS.length];
    const initial = escapeHtml(c.name.charAt(0).toUpperCase());

    return `
      <div class="contact-card">
        <div class="contact-avatar ${colorClass}">${initial}</div>
        <div class="contact-info">
          <div class="contact-name">${escapeHtml(c.name)}</div>
          <div class="contact-phone">🇮🇳 ${escapeHtml(c.phone)}</div>
          <div class="contact-key">🔑 CallMeBot API Key: ${escapeHtml(c.apiKey || '123456')}</div>
        </div>
        <div class="contact-actions">
          <button class="contact-test-btn" onclick="testWhatsAppApiKey('${escapeHtml(c.phone)}', '${escapeHtml(c.apiKey)}', '${escapeHtml(c.name)}')">🧪 Test</button>
          <button class="contact-del-btn" onclick="deleteContact('${c.id}')">🗑</button>
        </div>
      </div>
    `;
  }).join('');
}

function testWhatsAppApiKey(phone, apiKey, name) {
  const cleanPhone = phone.replace(/[^0-9+]/g, '');
  addTelemetryLog('SOS', 'Testing WhatsApp API...', `${name} (${cleanPhone})`);

  fetch('/api/auto-dispatch-sos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contacts: [{ name, phone: cleanPhone, apiKey }],
      lat: deviceState.lat,
      lon: deviceState.lon,
      accuracy: deviceState.accuracy,
      mapsUrl: deviceState.mapsUrl,
      source: 'Verification Test'
    })
  })
  .then(() => alert(`✅ Test Message Sent to ${name} (${cleanPhone})!`))
  .catch(() => sendWhatsAppToContact(cleanPhone));
}

// ── WI-FI MODAL HANDLERS ────────────────────────────────────────────────
function showWifiModal() {
  const modal = document.getElementById('wifiModal');
  if (modal) modal.classList.add('show');
}

function closeWifiModal() {
  const modal = document.getElementById('wifiModal');
  if (modal) modal.classList.remove('show');
}

function openWifiSettings() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android')) {
    window.location.href = 'intent://#Intent;action=android.settings.WIFI_SETTINGS;end';
  } else if (ua.includes('iphone') || ua.includes('ipad')) {
    window.location.href = 'App-Prefs:root=WIFI';
  } else {
    alert('Please open your phone Settings → Wi-Fi, connect to "SafetyWatch" with password "Jevin".');
  }
}

function copyWifiPass() {
  navigator.clipboard.writeText('Jevin').then(() => {
    alert('Password "Jevin" copied to clipboard!');
  }).catch(() => alert('Password: Jevin'));
}

// ── LOG ENGINE ───────────────────────────────────────────────────────────
function addTelemetryLog(source, eventType, details) {
  const item = { time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), source, type: eventType, details };
  telemetryLogs.unshift(item);
  if (telemetryLogs.length > 50) telemetryLogs.pop();

  const container = document.getElementById('logEntries');
  if (!container) return;

  const tagClass = source === 'SOS' ? 'tag-sos' : (source === 'LOC' ? 'tag-loc' : (source === 'ERR' ? 'tag-err' : 'tag-sys'));
  const entryClass = source === 'SOS' ? 'sos' : (source === 'LOC' ? 'loc' : '');

  container.innerHTML = telemetryLogs.map((l) => `
    <div class="log-entry ${entryClass}">
      <span class="log-tag ${tagClass}">${l.source}</span>
      <div class="log-text">
        <strong>${escapeHtml(l.type)}</strong>
        <div style="color:var(--text-2); font-size:11px; margin-top:2px;">${escapeHtml(l.details || '')}</div>
      </div>
      <div class="log-time">${l.time}</div>
    </div>
  `).join('');
}

function clearLogs() {
  telemetryLogs = [];
  const container = document.getElementById('logEntries');
  if (container) container.innerHTML = '';
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
}
