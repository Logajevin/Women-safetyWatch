// ============================================================================
// SafetyWatch AI — Smart Dual-Mode Dashboard
// AUTO-DETECTS: localhost:3000 (ESP32 via server SSE) vs GitHub Pages (GPS only)
// ============================================================================

// ── CONNECTION MODE DETECTION ─────────────────────────────────────────────
const IS_LOCALHOST = (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
const IS_GITHUB    = location.hostname.includes('github.io');

let autoGpsWatchId = null;
let lastSosState = false;
let sseSource = null;

let deviceState = {
  online: false,
  wifi: 'Disconnected',
  ip: '192.168.4.1',
  oled: 'Not Detected',
  lat: '12.9716',
  lon: '77.5946',
  accuracy: '12m',
  sos: false,
  sosTimestamp: 0,
  uptime: 0,
  battery: 98,
  pingMs: 0,
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

let familyContacts = [
  { id: '1', name: 'Mom (Primary)',  phone: '+91 9876543210', apiKey: '123456', relation: 'Primary Contact'   },
  { id: '2', name: 'Dad (Guardian)', phone: '+91 9876543211', apiKey: '654321', relation: 'Secondary Contact' }
];

let telemetryLogs = [];

// ── SPLASH SCREEN PERMISSION LOGIC ───────────────────────────────────────
function grantAllPermissions() {
  const btn = document.getElementById('btnGrantAll');
  btn.disabled = true;
  btn.textContent = 'Requesting permissions…';

  // 1. GPS Location
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        document.getElementById('ps-loc').textContent = '✅ Granted';
        document.getElementById('ps-loc').className = 'perm-status granted';
        onGPSPosition(pos);
      },
      () => {
        document.getElementById('ps-loc').textContent = '❌ Denied';
        document.getElementById('ps-loc').className = 'perm-status denied';
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // 2. Notification permission
  if ('Notification' in window) {
    Notification.requestPermission().then(perm => {
      const el = document.getElementById('ps-noti');
      if (perm === 'granted') { el.textContent = '✅ Granted'; el.className = 'perm-status granted'; }
      else { el.textContent = '⚠️ Declined'; el.className = 'perm-status denied'; }
    });
  } else {
    document.getElementById('ps-noti').textContent = 'N/A';
  }

  // 3. Vibration (no permission needed but show Auto)
  document.getElementById('ps-vib').textContent = '✅ Auto';
  document.getElementById('ps-vib').className = 'perm-status granted';

  // Close splash after 1.5s
  setTimeout(() => closeSplash(), 1500);
}

function skipSplash() {
  // Still start GPS silently
  startAutomaticMobileGPS();
  closeSplash();
}

function closeSplash() {
  const splash = document.getElementById('permSplash');
  splash.classList.add('hiding');
  setTimeout(() => splash.remove(), 500);
}

function onGPSPosition(pos) {
  const lat = pos.coords.latitude.toString();
  const lon = pos.coords.longitude.toString();
  const acc = Math.round(pos.coords.accuracy).toString();

  deviceState.lat      = lat;
  deviceState.lon      = lon;
  deviceState.accuracy = acc;
  deviceState.gpsActive = true;

  updateMapPosition(lat, lon, acc);
  updateGPSKpi(true, acc);

  if (IS_LOCALHOST) sendLocationToProxy(lat, lon, acc);

  addTelemetryLog('LOC', '📍 GPS Location Acquired', `Lat: ${parseFloat(lat).toFixed(5)}, Lon: ${parseFloat(lon).toFixed(5)}, Accuracy: ${acc}m`);
}

function updateGPSKpi(active, acc) {
  const el   = document.getElementById('gpsStatusText');
  const elAcc = document.getElementById('gpsAccText');
  const dot  = document.getElementById('dotGps');
  if (el) {
    el.textContent  = active ? 'Active ✅' : 'Searching…';
    el.style.color  = active ? 'var(--accent-green)' : '';
  }
  if (elAcc) elAcc.textContent = active ? `Accuracy: ~${acc}m` : 'Accuracy: --';
  if (dot)  dot.className = `status-dot ${active ? 'ok' : 'bad'}`;
}

// ── STARTUP ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadContactsFromStorage();
  renderContacts();
  updateConnectionModeBanner();

  if (IS_LOCALHOST) {
    // localhost: server polls ESP32 and pushes via SSE
    initSSEStream();
    addTelemetryLog('SYS', '🖥️ Local Server Mode', 'Server polls ESP32 every 400ms. Hardware SOS fully active!');
  } else {
    // GitHub Pages / remote: GPS + WhatsApp only. No direct ESP32.
    addTelemetryLog('SYS', '🌐 GitHub Pages Mode', 'GPS + WhatsApp active. For ESP32 HW SOS open localhost:3000');
    updateSplashBadge();
  }

  // Always start GPS tracking
  startAutomaticMobileGPS();
  renderUI();
});

function updateConnectionModeBanner() {
  const b = document.getElementById('connModeBanner');
  if (!b) return;
  if (IS_LOCALHOST) {
    b.className = '';
    b.innerHTML = `<div class="conn-dot green"></div><div><strong style="color:#00d282;">Local Server Mode</strong> — Server polls ESP32 every 400ms. Hardware SOS button fully connected!</div>`;
    // Show local server hint in wifi modal
    const hint = document.getElementById('localServerHint');
    if (hint) hint.style.display = 'none'; // already local
  } else {
    b.className = 'github-mode';
    b.innerHTML = `<div class="conn-dot purple"></div><div><strong style="color:#8896ff;">GitHub Pages Mode</strong> — GPS &amp; WhatsApp alerts active. <span style="color:rgba(255,255,255,0.5)">For hardware SOS, also open <code style="color:#00d282">http://localhost:3000</code> on your PC.</span></div>`;
    const hint = document.getElementById('localServerHint');
    if (hint) hint.style.display = 'block';
  }
}

function updateSplashBadge() {
  const badge = document.getElementById('splashModeBadge');
  if (!badge) return;
  if (IS_LOCALHOST) {
    badge.className = 'splash-mode-badge badge-local';
    badge.textContent = '🖥️ Local Server — ESP32 SOS Active';
  } else {
    badge.className = 'splash-mode-badge badge-github';
    badge.textContent = '🌐 GitHub Pages — GPS + WhatsApp Mode';
  }
}

// ---------------- AUTOMATIC MOBILE GPS TRACKING ----------------
function startAutomaticMobileGPS() {
  if (!navigator.geolocation) return;

  autoGpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      onGPSPosition(pos); // reuse shared GPS handler
    },
    (err) => {
      addTelemetryLog('LOC', '⚠️ GPS Error', err.message || 'Location unavailable');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
  );
}

// ---------------- SERVER-SIDE SSE STREAM (All ESP32 State) ----------------
// The server polls ESP32 every 400ms and pushes events here.
// No direct browser → ESP32 connections needed.
function initSSEStream() {
  if (!window.EventSource) {
    addTelemetryLog('ERR', 'SSE Not Supported', 'Upgrade your browser');
    return;
  }

  sseSource = new EventSource('/api/stream');

  sseSource.onopen = () => {
    addTelemetryLog('SYS', '✅ Server SSE Connected', 'Receiving real-time ESP32 state from server...');
  };

  sseSource.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      applyServerState(payload);
    } catch (err) {}
  };

  sseSource.onerror = () => {
    addTelemetryLog('ERR', 'SSE Stream Error', 'Reconnecting...');
    // EventSource auto-reconnects
  };
}

function applyServerState(payload) {
  const s = payload.state || {};

  // Update device state from server
  if (s.online !== undefined) deviceState.online = s.online;
  if (s.wifi)      deviceState.wifi = s.wifi;
  if (s.ip)        deviceState.ip   = s.ip;
  if (s.oled)      deviceState.oled = s.oled;
  if (s.uptime)    deviceState.uptime = s.uptime;
  if (s.latitude  && s.latitude  !== 'N/A') { deviceState.lat = s.latitude; }
  if (s.longitude && s.longitude !== 'N/A') { deviceState.lon = s.longitude; }

  // ── HARDWARE SOS BUTTON DETECTED! ──────────────────────────────────────
  if (payload.type === 'SOS_TRIGGERED') {
    deviceState.sos          = true;
    deviceState.sosTimestamp = s.sosTimestamp || Date.now();
    onInstantSOSDetected(payload.source || 'Hardware Watch Button');
    return;
  }

  if (payload.type === 'SOS_RESET') {
    deviceState.sos = false;
    addTelemetryLog('SYS', '✅ SOS Reset', 'Cleared from ESP32 or Web');
    triggerAudioSiren(false);
    renderUI();
    return;
  }

  if (payload.type === 'DEVICE_ONLINE') {
    addTelemetryLog('SYS', '📡 ESP32 Watch Online!', `IP: ${s.ip || '192.168.4.1'}`);
    if (s.latitude && s.latitude !== 'N/A') {
      updateMapPosition(s.latitude, s.longitude, 20);
    }
  }

  if (payload.type === 'DEVICE_OFFLINE') {
    addTelemetryLog('SYS', '⚠️ ESP32 Watch Offline', 'Connect PC to SafetyWatch Wi-Fi');
  }

  renderUI();
}

// Send GPS to server proxy (server pushes to ESP32 OLED)
function sendLocationToProxy(lat, lon, acc) {
  fetch(`/api/proxy/location?lat=${lat}&lon=${lon}&acc=${acc}`)
    .catch(() => {});
}

// ---------------- SOS TRIGGER & WHATSAPP ALERT ENGINE ----------------
function triggerSOSEvent() {
  deviceState.sos = true;
  deviceState.sosTimestamp = Date.now();
  
  // All commands route through server proxy — no direct ESP32 contact
  fetch('/api/proxy/sos').catch(() => {});

  onInstantSOSDetected('Web SOS Button Click');
}

function onInstantSOSDetected(triggerSource) {
  addTelemetryLog('SOS', '🚨 HARDWARE SOS DETECTED ON WEB!', `Source: ${triggerSource}`);
  
  triggerAudioSiren(true);
  renderUI();
  broadcastAutoWhatsAppEmergency(triggerSource);
}

function broadcastAutoWhatsAppEmergency(source = 'SOS Trigger') {
  addTelemetryLog('SOS', 'Dispatching Emergency WhatsApp Alerts...', `Contacts: ${familyContacts.length}`);

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
  .then(r => r.json())
  .then(data => {
    addTelemetryLog('SOS', '✅ Automated WhatsApp API Delivered', `Targeted ${data.dispatchedCount || familyContacts.length} numbers.`);
  })
  .catch(err => {
    addTelemetryLog('SOS', 'API Notice: Launching wa.me Backup', err.message);
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
  addTelemetryLog('SOS', 'WhatsApp wa.me Gateway Launched', `Target: ${phone}`);
}

function resetSOSState() {
  deviceState.sos = false;
  lastSosState = false;
  addTelemetryLog('SYS', 'SOS Cleared', 'System returned to Normal');
  triggerAudioSiren(false);

  // Route through server proxy
  fetch('/api/proxy/reset').catch(() => {});

  renderUI();
}

function triggerVibrationTest() {
  addTelemetryLog('SYS', 'Vibration Test', 'Motor pulse (1.5s)');
  fetch('/api/proxy/sos').catch(() => {});
}

// ---------------- WI-FI CONNECT & MOBILE DEEP-LINK HANDLERS ----------------
function showWifiConnectModal() {
  document.getElementById('wifiModal').style.display = 'flex';
  addTelemetryLog('SYS', 'Wi-Fi Connect Dialog Opened', 'SSID: SafetyWatch | Pass: Jevin');
}

function closeWifiConnectModal() {
  document.getElementById('wifiModal').style.display = 'none';
}

function triggerAutoWifiSettings() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android')) {
    window.location.href = 'intent://#Intent;action=android.settings.WIFI_SETTINGS;end';
  } else if (ua.includes('iphone') || ua.includes('ipad')) {
    window.location.href = 'App-Prefs:root=WIFI';
  } else if (ua.includes('win')) {
    window.location.href = 'ms-settings:network-wifi';
  } else {
    alert('Please open your phone Wi-Fi settings, select "SafetyWatch", and enter password "Jevin".');
  }
}

function copyWifiPassword() {
  navigator.clipboard.writeText('Jevin').then(() => {
    alert('Password "Jevin" copied to clipboard!');
  }).catch(() => alert('Password: Jevin'));
}

// initSSEStream() is defined above and replaces initMultiUserSyncStream()
// The server now pushes ALL ESP32 state to the browser via SSE.

function initMap() {
  const defaultLat = parseFloat(deviceState.lat);
  const defaultLon = parseFloat(deviceState.lon);

  map = L.map('map').setView([defaultLat, defaultLon], 14);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(map);

  const customIcon = L.divIcon({
    className: 'custom-map-marker',
    html: `<div style="width:22px; height:22px; background:#ff3b5c; border:3px solid #fff; border-radius:50%; box-shadow:0 0 20px #ff3b5c;"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });

  marker = L.marker([defaultLat, defaultLon], { icon: customIcon }).addTo(map);
  marker.bindPopup('<b>SafetyWatch Device Location</b>').openPopup();

  accuracyCircle = L.circle([defaultLat, defaultLon], {
    color: '#00f2fe',
    fillColor: '#00f2fe',
    fillOpacity: 0.15,
    radius: 50
  }).addTo(map);
}

function updateMapPosition(lat, lon, accuracy = 20) {
  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);
  if (isNaN(latNum) || isNaN(lonNum)) return;

  const newLatLng = new L.LatLng(latNum, lonNum);
  marker.setLatLng(newLatLng);
  accuracyCircle.setLatLng(newLatLng);
  accuracyCircle.setRadius(parseFloat(accuracy) || 30);

  map.panTo(newLatLng);

  const mapsUrl = `https://maps.google.com/?q=${latNum},${lonNum}`;
  deviceState.mapsUrl = mapsUrl;
  
  const mapsBtn = document.getElementById('googleMapsBtn');
  mapsBtn.href = mapsUrl;
  mapsBtn.classList.remove('disabled');

  document.getElementById('latVal').textContent = latNum.toFixed(5);
  document.getElementById('lonVal').textContent = lonNum.toFixed(5);
  document.getElementById('accVal').textContent = `${accuracy}m`;
  document.getElementById('lastLocTime').textContent = new Date().toLocaleTimeString();
}

function requestBrowserLocation() {
  if (!navigator.geolocation) return alert('Geolocation not supported');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude.toString();
      const lon = pos.coords.longitude.toString();
      const acc = Math.round(pos.coords.accuracy).toString();

      deviceState.lat = lat;
      deviceState.lon = lon;
      deviceState.accuracy = acc;

      updateMapPosition(lat, lon, acc);
      addTelemetryLog('LOC', 'Manual GPS Refresh', `Lat: ${lat}, Lon: ${lon}`);

      if (currentMode === 'live') sendLocationToESP32(lat, lon, acc);
    },
    (err) => alert('Unable to retrieve location: ' + err.message),
    { enableHighAccuracy: true }
  );
}

function setMode(mode) {
  // Mode buttons kept for UI compatibility — server always polls ESP32
  currentMode = mode;
  addTelemetryLog('SYS', 'Mode UI', `Display mode: ${mode}`);
  renderUI();
}

function connectLiveDevice() {
  addTelemetryLog('SYS', 'ESP32 Polling', 'Server is polling ESP32 at 192.168.4.1 every 400ms');
}

// ---------------- CONTACTS MANAGEMENT WITH +91 FORMATTING ----------------
function toggleAddContactForm() {
  const form = document.getElementById('addContactForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
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

function saveNewContact() {
  const name = document.getElementById('contactName').value.trim();
  let phone = document.getElementById('contactPhone').value.trim();
  const apiKey = document.getElementById('contactApiKey').value.trim() || '123456';
  const rel = document.getElementById('contactRelation').value.trim() || 'Family';

  if (!name || !phone || phone === '+91') return alert('Please enter both contact name and phone number.');

  phone = formatIndianPhone(phone);

  const newContact = { id: Date.now().toString(), name, phone, apiKey, relation: rel };
  familyContacts.push(newContact);
  saveContactsToStorage();
  renderContacts();

  document.getElementById('contactName').value = '';
  document.getElementById('contactPhone').value = '+91 ';
  document.getElementById('contactApiKey').value = '';
  document.getElementById('contactRelation').value = '';
  toggleAddContactForm();

  addTelemetryLog('SYS', 'Contact Saved (+91)', `${name} (${phone}) - Key: ${apiKey}`);
}

function deleteContact(id) {
  familyContacts = familyContacts.filter(c => c.id !== id);
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
    try { familyContacts = JSON.parse(saved); } catch(e) {}
  }
}

function renderContacts() {
  const grid = document.getElementById('contactsGrid');
  if (familyContacts.length === 0) {
    grid.innerHTML = `<p style="color:var(--text-muted); grid-column: 1/-1; text-align:center; padding:20px;">No family emergency contacts added yet. Click "Add Contact" above to configure your CallMeBot WhatsApp API keys.</p>`;
    return;
  }

  grid.innerHTML = familyContacts.map(c => `
    <div class="contact-card">
      <div class="contact-info">
        <h3>${escapeHtml(c.name)} <span class="contact-rel">${escapeHtml(c.relation)}</span></h3>
        <p>🇮🇳 ${escapeHtml(c.phone)}</p>
        <p style="font-size:10px; color:var(--accent-green); margin-top:2px;">🔑 CallMeBot API Key: ${escapeHtml(c.apiKey || '123456')}</p>
        <button class="btn-test-api" onclick="testWhatsAppApiKey('${escapeHtml(c.phone)}', '${escapeHtml(c.apiKey)}', '${escapeHtml(c.name)}')">
          🧪 Test WhatsApp API
        </button>
      </div>
      <div class="contact-btns">
        <button class="btn-del-contact" title="Delete Contact" onclick="deleteContact('${c.id}')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
  `).join('');
}

function testWhatsAppApiKey(phone, apiKey, name) {
  const cleanPhone = phone.replace(/[^0-9+]/g, '');
  addTelemetryLog('SOS', 'Testing WhatsApp API Key...', `Target: ${name} (${cleanPhone})`);

  fetch('/api/auto-dispatch-sos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contacts: [{ name, phone: cleanPhone, apiKey }],
      lat: deviceState.lat,
      lon: deviceState.lon,
      accuracy: deviceState.accuracy,
      mapsUrl: deviceState.mapsUrl,
      source: 'API Verification Test'
    })
  })
  .then(r => r.json())
  .then(data => {
    alert(`✅ Test Message Sent to ${name} (${cleanPhone})!`);
  })
  .catch(err => {
    sendWhatsAppToContact(cleanPhone);
  });
}

// ---------------- AUDIO SIREN SYNTHESIZER ----------------
function toggleAudioSiren() {
  isSirenMuted = !isSirenMuted;
  const btn = document.getElementById('sirenSoundBtn');
  btn.classList.toggle('active-siren', !isSirenMuted);

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

// ---------------- UI & OLED MIRROR ----------------
function renderUI() {
  const banner = document.getElementById('sosEmergencyBanner');
  banner.classList.toggle('show', deviceState.sos);
  
  if (deviceState.sos) {
    document.getElementById('sosBannerTime').textContent = `Activated at ${new Date(deviceState.sosTimestamp || Date.now()).toLocaleTimeString()}`;
  }

  document.getElementById('deviceStatusText').textContent = deviceState.online ? 'Online' : 'Offline';
  document.getElementById('dotDevice').className = `status-dot ${deviceState.online ? 'ok' : 'bad'}`;
  document.getElementById('deviceIpText').textContent = `IP: ${deviceState.ip}`;

  document.getElementById('wifiStatusText').textContent = deviceState.wifi;
  document.getElementById('dotWifi').className = `status-dot ${deviceState.online ? 'ok' : 'bad'}`;

  document.getElementById('sosStatusText').textContent = deviceState.sos ? 'EMERGENCY' : 'NORMAL';
  document.getElementById('sosStatusText').style.color = deviceState.sos ? 'var(--accent-danger)' : 'var(--text-main)';
  document.getElementById('dotSos').className = `status-dot ${deviceState.sos ? 'bad' : 'ok'}`;

  document.getElementById('oledStatusText').textContent = deviceState.oled;
  document.getElementById('dotOled').className = `status-dot ${deviceState.oled === 'OK' ? 'ok' : 'bad'}`;

  document.getElementById('batteryText').textContent = `${deviceState.battery}%`;
  document.getElementById('batteryBar').style.width = `${deviceState.battery}%`;

  const oledEl = document.getElementById('oledScreen');
  
  if (deviceState.sos) {
    const isFlashOn = Math.floor(Date.now() / 500) % 2 === 0;
    oledEl.className = 'oled-screen-content flashing';
    if (isFlashOn) {
      oledEl.innerHTML = `
        <div class="oled-line font-header">**************</div>
        <div class="oled-line" style="font-size:16px; font-weight:bold; color:#ff3b5c;">EMERGENCY</div>
        <div class="oled-line" style="font-size:16px; font-weight:bold; color:#ff3b5c;">HELP NEEDED</div>
        <div class="oled-line font-header">**************</div>
      `;
    } else {
      oledEl.innerHTML = `<div style="height:100px;"></div>`;
    }
  } else {
    oledEl.className = 'oled-screen-content';
    oledEl.innerHTML = `
      <div class="oled-line font-header">Safety Watch</div>
      <div class="oled-line">WiFi: ${deviceState.wifi}</div>
      <div class="oled-line">IP: ${deviceState.ip}</div>
      <div class="oled-line">Lat: ${deviceState.lat.substring(0, 7)}</div>
      <div class="oled-line">Lon: ${deviceState.lon.substring(0, 7)}</div>
      <div class="oled-line">SOS: ${deviceState.sos ? 'ACTIVE' : 'Normal'}</div>
      <div class="oled-line">Up: ${deviceState.uptime}s</div>
    `;
  }
}

function addTelemetryLog(source, eventType, details) {
  const item = { time: new Date().toLocaleTimeString(), source, type: eventType, details };
  telemetryLogs.unshift(item);
  if (telemetryLogs.length > 50) telemetryLogs.pop();

  const tbody = document.getElementById('logTableBody');
  const typeClass = source === 'SOS' ? 'log-type-sos' : (source === 'LOC' ? 'log-type-loc' : 'log-type-sys');

  tbody.innerHTML = telemetryLogs.map(l => `
    <tr>
      <td>${l.time}</td>
      <td><span class="${typeClass}">${l.source}</span></td>
      <td>${escapeHtml(l.type)}</td>
      <td>${escapeHtml(l.details)}</td>
    </tr>
  `).join('');
}

function clearLogs() {
  telemetryLogs = [];
  document.getElementById('logTableBody').innerHTML = '';
}

function exportLogsJSON() {
  const blob = new Blob([JSON.stringify(telemetryLogs, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `safetywatch_telemetry_${Date.now()}.json`;
  a.click();
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
}
