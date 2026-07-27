const express = require('express');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

// SSE Real-Time Connected Clients List for Multi-User Live Sync
let sseClients = [];

// Shared Global State for Multi-User Live Sync
let globalState = {
  sos: false,
  sosTimestamp: 0,
  lat: '12.9716',
  lon: '77.5946',
  accuracy: '12m',
  mapsUrl: 'https://maps.google.com/?q=12.9716,77.5946',
  uptime: 0
};

// Real-Time Server-Sent Events (SSE) Stream for Multi-User Broadcast
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  sseClients.push(res);
  console.log(`👤 New Family Member / Viewer Connected! Total Active Viewers: ${sseClients.length}`);

  // Send initial state to new viewer
  res.write(`data: ${JSON.stringify({ type: 'INIT', state: globalState })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
    console.log(`👤 Viewer disconnected. Remaining Viewers: ${sseClients.length}`);
  });
});

function broadcastToAllViewers(data) {
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// Proxy endpoint to pass requests directly to ESP32 device
app.get('/api/proxy/*', (req, meRes) => {
  const esp32Ip = req.query.targetIp || '192.168.4.1';
  const targetPath = req.params[0];
  const queryStr = url.parse(req.url).query || '';

  const cleanQuery = queryStr.split('&').filter(p => !p.startsWith('targetIp=')).join('&');
  const forwardUrl = `http://${esp32Ip}/${targetPath}${cleanQuery ? '?' + cleanQuery : ''}`;

  http.get(forwardUrl, { timeout: 3000 }, (espRes) => {
    let body = '';
    espRes.on('data', chunk => body += chunk);
    espRes.on('end', () => {
      meRes.setHeader('Access-Control-Allow-Origin', '*');
      meRes.setHeader('Content-Type', espRes.headers['content-type'] || 'application/json');
      meRes.status(espRes.statusCode).send(body);
    });
  }).on('error', (err) => {
    meRes.setHeader('Access-Control-Allow-Origin', '*');
    meRes.status(502).json({ error: 'ESP32 Device Unreachable', details: err.message, targetUrl: forwardUrl });
  });
});

// 100% AUTOMATED BACKGROUND WHATSAPP DISPATCHER (Option 2 — Zero Taps)
app.post('/api/auto-dispatch-sos', (req, res) => {
  const { contacts, lat, lon, accuracy, mapsUrl, source } = req.body;

  globalState.sos = true;
  globalState.sosTimestamp = Date.now();
  if (lat) globalState.lat = lat;
  if (lon) globalState.lon = lon;
  if (mapsUrl) globalState.mapsUrl = mapsUrl;

  // Broadcast SOS state change instantly to all connected family members' phones!
  broadcastToAllViewers({ type: 'SOS_TRIGGERED', state: globalState, source });

  console.log(`\n🚨 [MULTI-USER AUTOMATED SOS DISPATCH] Source: ${source}`);
  console.log(`📍 Coordinates: ${lat}, ${lon}`);

  const timestamp = new Date().toLocaleString();
  const alertMsg = `🚨 EMERGENCY ALERT - SAFETY WATCH 🚨\n\nSOS Activated!\nTime: ${timestamp}\nLocation: ${lat}, ${lon}\nMaps: ${mapsUrl}`;

  const dispatchResults = [];
  let pendingRequests = contacts.length;

  if (!contacts || contacts.length === 0) {
    return res.json({ status: 'no_contacts', message: 'No contacts configured' });
  }

  contacts.forEach(contact => {
    const cleanPhone = contact.phone.replace(/[^0-9+]/g, '');
    const apiKey = contact.apiKey || '123456';

    console.log(`  -> Dispatching automated WhatsApp to ${contact.name} (${cleanPhone})...`);

    const callmebotUrl = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(cleanPhone)}&text=${encodeURIComponent(alertMsg)}&apikey=${encodeURIComponent(apiKey)}`;

    https.get(callmebotUrl, (apiRes) => {
      let body = '';
      apiRes.on('data', chunk => body += chunk);
      apiRes.on('end', () => {
        console.log(`     ✅ Automated WhatsApp delivered to ${contact.name}`);
        dispatchResults.push({ contactName: contact.name, phone: cleanPhone, statusCode: apiRes.statusCode });

        pendingRequests--;
        if (pendingRequests <= 0) {
          res.json({ status: 'success', message: 'WhatsApp sent to all contacts.', results: dispatchResults });
        }
      });
    }).on('error', (err) => {
      console.log(`     ⚠️ WhatsApp Gateway Warning for ${contact.name}: ${err.message}`);
      dispatchResults.push({ contactName: contact.name, error: err.message });
      pendingRequests--;
      if (pendingRequests <= 0) {
        res.json({ status: 'partial_success', results: dispatchResults });
      }
    });
  });
});

// Get Network Interfaces IPs for local Wi-Fi sharing
function getLocalNetworkIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

app.listen(PORT, '0.0.0.0', () => {
  const localIps = getLocalNetworkIPs();
  console.log(`=======================================================`);
  console.log(` SafetyWatch Multi-User Command Hub Running!`);
  console.log(` `);
  console.log(` 🌐 EVERYONE CAN ACCESS THE DASHBOARD AT:`);
  console.log(`    Local Machine: http://localhost:${PORT}`);
  localIps.forEach(ip => {
    console.log(`    Wi-Fi / Mobile: http://${ip}:${PORT}`);
  });
  console.log(`=======================================================`);
});
