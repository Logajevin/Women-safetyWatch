// ============================================================================
// SafetyWatch AI — Server-Side ESP32 Polling + SSE Push to All Browsers
// ============================================================================
// ARCHITECTURE:
//   Browser ──────────────> Node.js (localhost:3000) ──HTTP──> ESP32 (192.168.4.1)
//   Browser <── SSE Push ── Node.js (detects SOS change) 
//
// The Node.js server polls ESP32 every 400ms and pushes to browsers via SSE.
// Browser NEVER contacts ESP32 directly — eliminates all CORS/Mixed Content.
// ============================================================================

const express = require('express');
const http    = require('http');
const https   = require('https');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Disable browser caching completely
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname), { maxAge: 0 }));

// ─── GLOBAL STATE ─────────────────────────────────────────────────────────
let sseClients = [];

let espState = {
  online:         false,
  wifi:           'Disconnected',
  ip:             '192.168.4.1',
  oled:           'Not Detected',
  latitude:       'N/A',
  longitude:      'N/A',
  accuracy:       'N/A',
  sos:            false,
  sosTimestamp:   0,
  uptime:         0,
  lastPollMs:     0
};

const ESP32_IP    = '192.168.4.1';
const POLL_MS     = 400;       // Poll ESP32 every 400ms from server side
const TIMEOUT_MS  = 1000;      // HTTP request timeout

// ─── SSE STREAM ENDPOINT ──────────────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type',                'text/event-stream');
  res.setHeader('Cache-Control',               'no-cache');
  res.setHeader('Connection',                  'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send current state immediately on connect
  res.write(`data: ${JSON.stringify({ type: 'STATE', state: espState })}\n\n`);
  sseClients.push(res);
  console.log(`[SSE] Client connected. Total clients: ${sseClients.length}`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
    console.log(`[SSE] Client disconnected. Total clients: ${sseClients.length}`);
  });
});

function broadcastToAll(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// ─── SERVER-SIDE ESP32 POLLING ENGINE ────────────────────────────────────
// This runs on the SERVER (your PC), which is connected to SafetyWatch Wi-Fi.
// It can reach http://192.168.4.1 perfectly — no CORS issues!

function pollESP32() {
  const url = `http://${ESP32_IP}/status`;

  const req = http.get(url, { timeout: TIMEOUT_MS }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const data = JSON.parse(body);

        const prevSos    = espState.sos;
        const prevOnline = espState.online;

        espState.online    = true;
        espState.wifi      = 'Connected';
        espState.ip        = data.ip       || ESP32_IP;
        espState.oled      = data.oled     || 'OK';
        espState.latitude  = data.latitude || 'N/A';
        espState.longitude = data.longitude|| 'N/A';
        espState.uptime    = data.uptime   || 0;
        espState.lastPollMs = Date.now();

        // ── HARDWARE SOS BUTTON DETECTED! ─────────────────────────────────
        if (data.sos === true && !prevSos) {
          espState.sos          = true;
          espState.sosTimestamp = Date.now();

          console.log('\n🚨🚨🚨 HARDWARE SOS DETECTED BY SERVER! 🚨🚨🚨');
          console.log('  Broadcasting SOS_TRIGGERED to all browsers via SSE...\n');

          broadcastToAll({
            type:   'SOS_TRIGGERED',
            state:  espState,
            source: 'Hardware Watch Button'
          });
        } else if (data.sos === false && prevSos) {
          espState.sos = false;
          broadcastToAll({ type: 'SOS_RESET', state: espState });
        }

        // Broadcast online status change
        if (!prevOnline) {
          broadcastToAll({ type: 'DEVICE_ONLINE', state: espState });
          console.log('[ESP32] Device came ONLINE at', ESP32_IP);
        }

      } catch (e) {
        markOffline();
      }
    });
  });

  req.on('error', () => markOffline());
  req.on('timeout', () => { req.destroy(); markOffline(); });
}

function markOffline() {
  if (espState.online) {
    espState.online = false;
    espState.wifi   = 'Disconnected';
    espState.oled   = 'Not Detected';
    broadcastToAll({ type: 'DEVICE_OFFLINE', state: espState });
    console.log('[ESP32] Device went OFFLINE');
  }
}

// Start polling immediately
setInterval(pollESP32, POLL_MS);
console.log(`[POLL] Server polling ESP32 at http://${ESP32_IP}/status every ${POLL_MS}ms`);

// ─── STATE API (used by browser to get current state on load) ────────────
app.get('/api/state', (req, res) => {
  res.json(espState);
});

// ─── LOCATION PUSH (browser → server → ESP32) ───────────────────────────
app.get('/api/proxy/location', (req, res) => {
  const lat = req.query.lat || '12.9716';
  const lon = req.query.lon || '77.5946';
  const acc = req.query.acc || '10m';

  espState.latitude  = lat;
  espState.longitude = lon;
  espState.accuracy  = acc;

  const espUrl = `http://${ESP32_IP}/location?lat=${lat}&lon=${lon}&acc=${acc}`;
  http.get(espUrl, { timeout: 1000 }).on('error', () => {});

  res.json({ status: 'ok' });
});

// ─── WEB SOS TRIGGER (browser → server → ESP32) ─────────────────────────
app.get('/api/proxy/sos', (req, res) => {
  espState.sos          = true;
  espState.sosTimestamp = Date.now();

  broadcastToAll({ type: 'SOS_TRIGGERED', state: espState, source: 'Web Button' });

  http.get(`http://${ESP32_IP}/sos`, { timeout: 1000 }).on('error', () => {});
  res.json({ status: 'sos_activated' });
});

// ─── RESET (browser → server → ESP32) ───────────────────────────────────
app.get('/api/proxy/reset', (req, res) => {
  espState.sos = false;
  broadcastToAll({ type: 'SOS_RESET', state: espState });

  http.get(`http://${ESP32_IP}/reset`, { timeout: 1000 }).on('error', () => {});
  res.json({ status: 'reset_ok' });
});

// ─── CALLMEBOT WHATSAPP AUTO-DISPATCH ───────────────────────────────────
app.post('/api/auto-dispatch-sos', (req, res) => {
  const { contacts, lat, lon, accuracy, mapsUrl, source } = req.body;
  if (!contacts || contacts.length === 0) {
    return res.status(400).json({ error: 'No contacts provided' });
  }

  const mapLink   = mapsUrl || `https://maps.google.com/?q=${lat},${lon}`;
  const timestamp = new Date().toLocaleString();

  contacts.forEach(contact => {
    const cleanPhone = (contact.phone || '').replace(/[^0-9+]/g, '');
    const apiKey     = contact.apiKey || '123456';

    const msg = `🚨 EMERGENCY ALERT - SAFETY WATCH 🚨\n\n` +
                `HARDWARE SOS BUTTON PRESSED!\n` +
                `📅 Time: ${timestamp}\n` +
                `📍 Coords: ${lat}, ${lon}\n` +
                `🎯 Accuracy: ~${accuracy || '15m'}\n\n` +
                `🗺 Live Map: ${mapLink}`;

    const callMeBotUrl = `https://api.callmebot.com/whatsapp.php` +
      `?phone=${encodeURIComponent(cleanPhone)}` +
      `&text=${encodeURIComponent(msg)}` +
      `&apikey=${encodeURIComponent(apiKey)}`;

    https.get(callMeBotUrl, r => {
      console.log(`[WhatsApp] Dispatched to ${cleanPhone} — Status: ${r.statusCode}`);
    }).on('error', err => {
      console.log('[WhatsApp] Error:', err.message);
    });
  });

  res.json({ status: 'dispatched', dispatchedCount: contacts.length });
});

// ─── START SERVER ─────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const ifaces = require('os').networkInterfaces();
  let localIp = 'localhost';
  Object.values(ifaces).flat().forEach(i => {
    if (i.family === 'IPv4' && !i.internal) localIp = i.address;
  });

  console.log(`\n${'='.repeat(55)}`);
  console.log(` SafetyWatch AI — Server-Side ESP32 Polling Active!`);
  console.log(`${'='.repeat(55)}`);
  console.log(` 🏠 Local:  http://localhost:${PORT}`);
  console.log(` 📱 Mobile: http://${localIp}:${PORT}`);
  console.log(` 🔄 Polling ESP32 at http://${ESP32_IP} every ${POLL_MS}ms`);
  console.log(`${'='.repeat(55)}\n`);
});
