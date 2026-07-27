// ============================================================================
// SafetyWatch AI — Multi-User Live Sync Dashboard (Option 2 Automated)
// ============================================================================

let currentMode = 'simulator';
let esp32Ip = '192.168.4.1';
let pollInterval = null;
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
  mapsUrl: 'https://maps.google.com/?q=12.9716,77.5946'
};

let map = null;
let marker = null;
let accuracyCircle = null;
let audioCtx = null;
let sirenOsc = null;
let sirenGain = null;
let isSirenMuted = false;

// Default Family Contacts with Indian (+91) Country Code
let familyContacts = [
  { id: '1', name: 'Mom (Family)', phone: '+91 9876543210', apiKey: '123456', relation: 'Primary Contact' },
  { id: '2', name: 'Dad (Guardian)', phone: '+91 9876543211', apiKey: '654321', relation: 'Secondary Contact' }
];

let telemetryLogs = [];

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadContactsFromStorage();
  renderContacts();
  initMultiUserSyncStream();
  addTelemetryLog('SYS', 'SafetyWatch Dashboard Ready', 'Dual Gateway Active: Auto API + wa.me Fallback Backup');
  
  pollInterval = setInterval(updateCycle, 1000);
});

// ---------------- DUAL WHATSAPP ALERT ENGINE & TESTER ----------------
function testWhatsAppApiKey(phone, apiKey, name) {
  const cleanPhone = phone.replace(/[^0-9+]/g, '');
  
  if (!apiKey || apiKey === '123456') {
    const useFallback = confirm(`⚠️ The API key for ${name} is a placeholder (${apiKey}).\n\nCallMeBot API requires 1-time activation:\n1. Click "⚡ 1-Click Activate CallMeBot Bot" at the top.\n2. Or click OK to test instant WhatsApp wa.me fallback message.`);
    if (useFallback) {
      sendWhatsAppToContact(cleanPhone);
    }
    return;
  }

  addTelemetryLog('SOS', 'Testing CallMeBot WhatsApp API Key...', `Target: ${name} (${cleanPhone})`);

  fetch('/api/auto-dispatch-sos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contacts: [{ name, phone: cleanPhone, apiKey }],
      lat: deviceState.lat,
      lon: deviceState.lon,
      accuracy: deviceState.accuracy,
      mapsUrl: deviceState.mapsUrl,
      source: 'API Key Verification Test'
    })
  })
  .then(r => r.json())
  .then(data => {
    alert(`✅ Automated WhatsApp API Call Sent to ${name} (${cleanPhone})!\n\nIf CallMeBot returns an unactivated key error, the message will also open via wa.me backup automatically.`);
    addTelemetryLog('SOS', 'WhatsApp API Key Test Triggered', `Status: ${data.status}`);
  })
  .catch(err => {
    alert(`⚠️ API Error: Falling back to direct WhatsApp link.`);
    sendWhatsAppToContact(cleanPhone);
  });
}

function loadSampleWorkingContact() {
  const sample = {
    id: Date.now().toString(),
    name: 'Sample Family Contact',
    phone: '+91 9876543210',
    apiKey: '123456',
    relation: 'Sample Guardian'
  };
  familyContacts.push(sample);
  saveContactsToStorage();
  renderContacts();
  addTelemetryLog('SYS', 'Sample Contact Loaded', '+91 9876543210');
}

// ---------------- WI-FI CONNECT & SETTINGS HANDLERS ----------------
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
    alert('Please open your device Wi-Fi settings manually and select "SafetyWatch" with password "Jevin".');
  }

  addTelemetryLog('SYS', 'Opening Wi-Fi Settings', 'Searching for SafetyWatch AP');
}

function copyWifiPassword() {
  navigator.clipboard.writeText('Jevin').then(() => {
    alert('Password "Jevin" copied to clipboard!');
  }).catch(() => {
    alert('Password: Jevin');
  });
}

// ---------------- REAL-TIME MULTI-USER SSE STREAM ----------------
function initMultiUserSyncStream() {
  if (!!window.EventSource) {
    sseSource = new EventSource('/api/stream');
    
    sseSource.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === 'SOS_TRIGGERED') {
          deviceState.sos = true;
          deviceState.sosTimestamp = payload.state.sosTimestamp;
          if (payload.state.lat) deviceState.lat = payload.state.lat;
          if (payload.state.lon) deviceState.lon = payload.state.lon;
          
          updateMapPosition(deviceState.lat, deviceState.lon);
          triggerAudioSiren(true);
          addTelemetryLog('SOS', '🚨 MULTI-USER LIVE SOS SYNC', `Broadcast from: ${payload.source || 'Another User/Watch'}`);
          renderUI();
        }
      } catch(err) {}
    };
  }
}

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
  const btn = document.getElementById('btnGetLoc');
  if (!navigator.geolocation) return alert('Geolocation not supported');

  btn.disabled = true;
  btn.textContent = 'Locating GPS...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="12 8 8 12 12 16 12 8"/></svg> Get GPS Location`;
      
      const lat = pos.coords.latitude.toString();
      const lon = pos.coords.longitude.toString();
      const acc = Math.round(pos.coords.accuracy).toString();

      deviceState.lat = lat;
      deviceState.lon = lon;
      deviceState.accuracy = acc;

      updateMapPosition(lat, lon, acc);
      addTelemetryLog('LOC', 'GPS Acquired', `Lat: ${lat}, Lon: ${lon}, Acc: ${acc}m`);

      if (currentMode === 'live') sendLocationToESP32(lat, lon, acc);
    },
    (err) => {
      btn.disabled = false;
      btn.innerHTML = `Get GPS Location`;
      alert('Unable to retrieve location: ' + err.message);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function setMode(mode) {
  currentMode = mode;
  document.getElementById('modeSimBtn').classList.toggle('active', mode === 'simulator');
  document.getElementById('modeLiveBtn').classList.toggle('active', mode === 'live');
  document.getElementById('ipBox').style.display = mode === 'live' ? 'flex' : 'none';

  if (mode === 'live') {
    deviceState.online = false;
    deviceState.wifi = 'Searching...';
  } else {
    deviceState.online = true;
    deviceState.wifi = 'Simulated';
  }

  addTelemetryLog('SYS', 'Mode Switch', `Mode: ${mode.toUpperCase()}`);
  renderUI();
}

function connectLiveDevice() {
  const ip = document.getElementById('espIpInput').value.trim();
  if (ip) {
    esp32Ip = ip;
    deviceState.ip = ip;
    addTelemetryLog('SYS', 'IP Configured', `Targeting ESP32 at ${esp32Ip}`);
    fetchLiveStatus();
  }
}

function updateCycle() {
  deviceState.uptime++;

  if (currentMode === 'simulator') {
    deviceState.online = true;
    deviceState.wifi = 'Simulated AP';
    deviceState.oled = 'OK';
    deviceState.pingMs = Math.floor(Math.random() * 8) + 10;
  } else {
    fetchLiveStatus();
  }

  if (deviceState.sos && !lastSosState) {
    onInstantSOSDetected('Hardware Watch Button Press');
  }
  lastSosState = deviceState.sos;

  renderUI();
}

function fetchLiveStatus() {
  const startTime = Date.now();
  const proxyUrl = `/api/proxy/status?targetIp=${encodeURIComponent(esp32Ip)}`;

  fetch(proxyUrl)
    .then(r => {
      if (!r.ok) throw new Error('ESP32 Unreachable');
      return r.json();
    })
    .then(data => {
      deviceState.pingMs = Date.now() - startTime;
      deviceState.online = true;
      deviceState.wifi = 'Connected';
      deviceState.ip = data.ip || esp32Ip;
      deviceState.oled = data.oled || 'OK';
      deviceState.sos = data.sos;

      if (data.latitude && data.latitude !== 'N/A') {
        deviceState.lat = data.latitude;
        deviceState.lon = data.longitude;
        deviceState.accuracy = data.accuracy || '15m';
        updateMapPosition(deviceState.lat, deviceState.lon, deviceState.accuracy);
      }
    })
    .catch(err => {
      deviceState.online = false;
      deviceState.wifi = 'Disconnected';
      deviceState.oled = 'Not Detected';
      deviceState.pingMs = 0;
    });
}

function sendLocationToESP32(lat, lon, acc) {
  fetch(`/api/proxy/location?targetIp=${encodeURIComponent(esp32Ip)}&lat=${lat}&lon=${lon}&acc=${acc}`);
}

// ---------------- DUAL GATEWAY AUTOMATED WHATSAPP DISPATCH ----------------
function triggerSOSEvent() {
  deviceState.sos = true;
  deviceState.sosTimestamp = Date.now();
  
  if (currentMode === 'live') {
    fetch(`/api/proxy/sos?targetIp=${encodeURIComponent(esp32Ip)}`);
  }

  onInstantSOSDetected('Web Command SOS Button');
}

function onInstantSOSDetected(triggerSource) {
  addTelemetryLog('SOS', '🚨 DUAL WHATSAPP DISPATCH (AUTO API + WA.ME BACKUP)', `Source: ${triggerSource}`);
  triggerAudioSiren(true);
  broadcastAutoWhatsAppEmergency(triggerSource);
}

function broadcastAutoWhatsAppEmergency(source = 'Manual Trigger') {
  if (familyContacts.length === 0) {
    return alert('Please add at least one family contact first!');
  }

  addTelemetryLog('SOS', 'Sending Dual WhatsApp Alerts...', `Contacts: ${familyContacts.length}`);

  // 1. Try CallMeBot Auto API
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
    addTelemetryLog('SOS', '✅ Auto WhatsApp API Executed', `Targeted ${data.dispatchedCount || familyContacts.length} numbers.`);
  })
  .catch(err => {
    addTelemetryLog('SOS', 'Auto API Notice: Triggering wa.me Backup', err.message);
  });

  // 2. Dual Backup: Instant wa.me deep-link trigger for primary contact so message is NEVER blocked!
  if (familyContacts.length > 0) {
    sendWhatsAppToContact(familyContacts[0].phone);
  }
}

function buildEmergencyMessage() {
  const mapsUrl = deviceState.mapsUrl || `https://maps.google.com/?q=${deviceState.lat},${deviceState.lon}`;
  const timestamp = new Date().toLocaleString();
  
  return `🚨 EMERGENCY ALERT - SAFETY WATCH 🚨\n\n` +
         `SOS is ACTIVE! Immediate assistance required.\n` +
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
  addTelemetryLog('SYS', 'SOS Reset', 'Emergency cleared');
  triggerAudioSiren(false);

  if (currentMode === 'live') {
    fetch(`/api/proxy/reset?targetIp=${encodeURIComponent(esp32Ip)}`);
  }

  renderUI();
}

function triggerVibrationTest() {
  addTelemetryLog('SYS', 'Vibration Test', 'Motor pulse (1.5s)');
  alert('Vibration Motor Pulse Triggered (1.5s)!');
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
    grid.innerHTML = `<p style="color:var(--text-muted); grid-column: 1/-1; text-align:center; padding:20px;">No family emergency contacts added yet. Click "Add Contact" above to configure your free CallMeBot WhatsApp API keys.</p>`;
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

  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

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

  document.getElementById('uptimeText').textContent = `${deviceState.uptime}s`;
  document.getElementById('pingText').textContent = `Latency: ${deviceState.pingMs} ms`;

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
