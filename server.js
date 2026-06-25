const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const db      = require('./database');

// ── Admin password for CP editing ────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

// ── OpenAI Whisper STT config ────────────────────────────────────────────────
// Weka OPENAI_API_KEY kwenye Railway environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// ── WAV encoder (pure Node.js, no extra packages) ───────────────────────────
function encodeWav(floatSamples, sampleRate = 16000) {
  const int16 = new Int16Array(floatSamples.length);
  for (let i = 0; i < floatSamples.length; i++) {
    const s = Math.max(-1, Math.min(1, Number(floatSamples[i])));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const dataSize = int16.byteLength;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  Buffer.from(int16.buffer).copy(buf, 44);
  return buf;
}

async function transcribeWav(wavBuf) {
  if (!OPENAI_API_KEY) return null;
  try {
    const blob = new Blob([wavBuf], { type: 'audio/wav' });
    const form = new FormData();
    form.append('file', blob, 'ptt.wav');
    form.append('model', 'whisper-1');
    form.append('language', 'sw');
    form.append('response_format', 'text');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: form
    });
    if (!res.ok) { console.error('[STT] Whisper error:', await res.text()); return null; }
    return (await res.text()).trim();
  } catch (e) {
    console.error('[STT] Error:', e.message);
    return null;
  }
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 2e6
});

// PTT audio accumulator for STT: socketId → Float32 samples[]
const pttAudioBuffers = new Map();
const MAX_PTT_SAMPLES = 16000 * 60;

// ── Single active CP session tracker ────────────────────────────────────────
// Only one admin can be logged into the CP at a time.
// { socketId, adminUsername, adminName }
let activeCP = null;

app.use(express.json({ limit: '6mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Active connections: socketId → soldierInfo
const activeSoldiers = new Map();

// ── REST API ─────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', active: activeSoldiers.size });
});

// ── Database Web Viewer ───────────────────────────────────────────────────────
app.get('/dbadmin', (req, res) => {
  const soldiers = db.getAllSoldiers();
  const admins   = db.getAllAdmins();
  const live     = Array.from(activeSoldiers.values());

  const liveIds = new Set(live.map(s => s.badgeNumber));

  const soldierRows = soldiers.map(s => {
    const isLive = liveIds.has(s.badge_number);
    const liveInfo = live.find(l => l.badgeNumber === s.badge_number);
    return `
    <tr>
      <td><span class="badge-num">${s.badge_number}</span></td>
      <td>${s.photo ? `<img src="${s.photo}" class="thumb"/>` : '<span class="no-photo">📷</span>'}</td>
      <td><b>${s.name}</b></td>
      <td>${s.rank}</td>
      <td>${s.unit}</td>
      <td>${s.phone || '—'}</td>
      <td>${s.blood_group || '—'}</td>
      <td>${s.age || '—'}</td>
      <td><span class="status ${isLive ? 'live' : 'offline'}">${isLive ? '● LIVE' : '○ Offline'}</span></td>
      <td>${liveInfo ? liveInfo.location ? `${liveInfo.location.lat.toFixed(5)},${liveInfo.location.lng.toFixed(5)}` : '—' : '—'}</td>
      <td>${liveInfo?.battery ? `${liveInfo.battery.level}%${liveInfo.battery.charging ? ' 🔌' : ''}` : '—'}</td>
      <td class="date">${s.created_at}</td>
    </tr>`;
  }).join('');

  const adminRows = admins.map(a => `
    <tr>
      <td>${a.photo ? `<img src="${a.photo}" class="thumb"/>` : '<span class="no-photo">👤</span>'}</td>
      <td><b>${a.username}</b></td>
      <td>${a.full_name || '—'}</td>
      <td><span class="role ${a.role}">${a.role.toUpperCase()}</span></td>
      <td>${a.department || '—'}</td>
      <td>${a.phone || '—'}</td>
      <td class="date">${a.created_at}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="sw">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Smart Soldier — Database Viewer</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0f1a;color:#e2e8f0;font-family:system-ui,sans-serif;font-size:13px}
  header{background:#0f172a;border-bottom:1px solid #1e3a5f;padding:16px 24px;display:flex;align-items:center;gap:12px}
  header h1{font-size:18px;color:#38bdf8}
  header .sub{color:#64748b;font-size:11px;margin-top:2px}
  .stats{display:flex;gap:12px;margin-left:auto}
  .stat{background:#1e3a5f;border-radius:8px;padding:8px 16px;text-align:center}
  .stat .n{font-size:22px;font-weight:700;color:#38bdf8}
  .stat .l{font-size:10px;color:#94a3b8;margin-top:2px}
  .container{padding:24px}
  h2{color:#38bdf8;font-size:14px;letter-spacing:1px;margin-bottom:12px;border-bottom:1px solid #1e3a5f;padding-bottom:8px}
  .section{margin-bottom:32px;background:#0f172a;border-radius:12px;padding:20px;border:1px solid #1e3a5f}
  table{width:100%;border-collapse:collapse}
  th{background:#1e3a5f;color:#94a3b8;font-size:10px;letter-spacing:1px;padding:10px 12px;text-align:left;white-space:nowrap}
  td{padding:10px 12px;border-bottom:1px solid #111827;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#111827}
  .badge-num{background:#1e3a5f;color:#38bdf8;padding:3px 8px;border-radius:4px;font-weight:700;font-size:11px}
  .thumb{width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid #1e3a5f}
  .no-photo{font-size:22px}
  .status.live{color:#22c55e;font-weight:700}
  .status.offline{color:#475569}
  .role.superadmin{background:#7c3aed;color:#fff;padding:2px 8px;border-radius:4px;font-size:10px}
  .role.admin{background:#1e3a5f;color:#38bdf8;padding:2px 8px;border-radius:4px;font-size:10px}
  .role.observer{background:#374151;color:#9ca3af;padding:2px 8px;border-radius:4px;font-size:10px}
  .date{color:#475569;font-size:11px}
  .refresh{background:#1e3a5f;color:#38bdf8;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:12px;margin-left:auto;display:block;margin-bottom:12px}
  .refresh:hover{background:#2d4f7c}
  .live-dot{width:8px;height:8px;background:#22c55e;border-radius:50%;display:inline-block;margin-right:6px;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .footer{text-align:center;padding:16px;color:#334155;font-size:11px}
</style>
</head>
<body>
<header>
  <div>🪖</div>
  <div>
    <h1>SMART SOLDIER — DATABASE VIEWER</h1>
    <div class="sub">http://localhost:9000/dbadmin · Auto-refresh kila sekunde 10</div>
  </div>
  <div class="stats">
    <div class="stat"><div class="n">${soldiers.length}</div><div class="l">ASKARI WOTE</div></div>
    <div class="stat"><div class="n" style="color:#22c55e">${live.length}</div><div class="l">LIVE SASA</div></div>
    <div class="stat"><div class="n" style="color:#a78bfa">${admins.length}</div><div class="l">ADMINS</div></div>
  </div>
</header>
<div class="container">

  <div class="section">
    <h2>📋 ASKARI WOTE WALIOHIFADHIWA</h2>
    <table>
      <thead><tr>
        <th>BADGE</th><th>PICHA</th><th>JINA</th><th>CHEO</th>
        <th>KIKOSI</th><th>SIMU</th><th>DAMU</th><th>UMRI</th>
        <th>HALI</th><th>LOCATION</th><th>BETRI</th><th>TAREHE</th>
      </tr></thead>
      <tbody>${soldierRows}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>👤 ADMINS (WASIMAMIZI)</h2>
    <table>
      <thead><tr>
        <th>PICHA</th><th>USERNAME</th><th>JINA KAMILI</th>
        <th>NAFASI</th><th>IDARA</th><th>SIMU</th><th>TAREHE</th>
      </tr></thead>
      <tbody>${adminRows}</tbody>
    </table>
  </div>

</div>
<div class="footer">Smart Soldier Server · Port 9000 · ${new Date().toLocaleString('sw')}</div>
<script>setTimeout(()=>location.reload(),10000)</script>
</body>
</html>`;
  res.send(html);
});

// Login — Android app calls this first
app.post('/auth/login', (req, res) => {
  const { badgeNumber, password } = req.body;
  if (!badgeNumber || !password)
    return res.status(400).json({ ok: false, message: 'Toa badge na nywila' });

  const result = db.login(badgeNumber, password);
  res.json(result);
});

// All registered soldiers (for CP management panel)
app.get('/soldiers', (req, res) => {
  res.json(db.getAllSoldiers());
});

// Add new soldier (CP admin)
app.post('/soldiers', (req, res) => {
  const result = db.addSoldier(req.body);
  if (result.ok) io.to('cp').emit('db-soldiers-update', db.getAllSoldiers());
  res.json(result);
});

// Admin login (new — checks database)
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ ok: false, message: 'Toa jina na nywila' });
  res.json(db.loginAdmin(username, password));
});

// List all admins
app.get('/admin/accounts', (req, res) => {
  res.json(db.getAllAdmins());
});

// Add new admin
app.post('/admin/accounts', (req, res) => {
  res.json(db.addAdmin(req.body));
});

// Update admin
app.patch('/admin/accounts/:id', (req, res) => {
  res.json(db.updateAdmin(req.params.id, req.body));
});

// Update admin photo
app.patch('/admin/accounts/:id/photo', (req, res) => {
  const { photo } = req.body;
  if (!photo) return res.status(400).json({ ok: false, message: 'Hakuna picha' });
  db.updateAdminPhoto(req.params.id, photo);
  res.json({ ok: true });
});

// Delete admin
app.delete('/admin/accounts/:id', (req, res) => {
  res.json(db.deleteAdmin(req.params.id));
});

// Verify admin password (legacy — now checks database)
app.post('/admin/verify', (req, res) => {
  const { username, password } = req.body;
  // Support old calls that only send password (use stored username from session)
  if (!username) return res.json({ ok: password === ADMIN_PASSWORD });
  const result = db.loginAdmin(username, password);
  res.json({ ok: result.ok });
});

// Update soldier details
app.patch('/soldiers/:badge/details', (req, res) => {
  const { adminPassword: _, ...fields } = req.body;
  try {
    db.updateSoldierDetails(req.params.badge, fields);
    io.to('cp').emit('db-soldiers-update', db.getAllSoldiers());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Update soldier photo
app.patch('/soldiers/:badge/photo', (req, res) => {
  const { photo } = req.body;
  if (!photo) return res.status(400).json({ ok: false, message: 'Hakuna picha' });
  db.updateSoldierPhoto(req.params.badge, photo);
  io.to('cp').emit('db-soldiers-update', db.getAllSoldiers());
  res.json({ ok: true });
});

// Delete soldier
app.delete('/soldiers/:badge', (req, res) => {
  db.deleteSoldier(req.params.badge);
  io.to('cp').emit('db-soldiers-update', db.getAllSoldiers());
  res.json({ ok: true });
});

// Active live soldiers
app.get('/active', (req, res) => {
  res.json(Array.from(activeSoldiers.values()));
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Soldier joins after successful login ──────────────────────────────────
  socket.on('register-soldier', (data) => {
    // data: { badgeNumber, name, rank, unit, ip, streamUrl, ... }
    const info = { ...data, socketId: socket.id, connectedAt: new Date().toISOString(), watchConnected: false, location: null };
    activeSoldiers.set(socket.id, info);
    socket.join('soldiers');
    console.log(`[Soldier] ${data.rank} ${data.name} (${data.badgeNumber}) — ${data.streamUrl}`);
    io.to('cp').emit('active-soldiers-update', Array.from(activeSoldiers.values()));
    socket.emit('registered', { ok: true });
  });

  // ── CP joins — single-session enforcement ────────────────────────────────
  socket.on('register-cp', ({ adminUsername = '?', adminName = '?' } = {}) => {
    // If another CP is already active, kick it out first
    if (activeCP && activeCP.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(activeCP.socketId);
      if (oldSocket) {
        oldSocket.emit('force-logout', { by: adminName || adminUsername });
        oldSocket.leave('cp');
      }
      console.log(`[CP] Kicked "${activeCP.adminUsername}" — new login by "${adminUsername}"`);
    }

    activeCP = { socketId: socket.id, adminUsername, adminName };
    socket.join('cp');
    console.log(`[CP] "${adminUsername}" imeunganika`);

    socket.emit('active-soldiers-update', Array.from(activeSoldiers.values()));
    socket.emit('db-soldiers-update', db.getAllSoldiers());
    // Send cached locations and battery for all currently active soldiers
    for (const [, s] of activeSoldiers.entries()) {
      if (s.location) {
        socket.emit('location-update', {
          socketId: s.socketId, name: s.name,
          rank: s.rank, unit: s.unit, badge: s.badgeNumber,
          location: s.location
        });
      }
      if (s.battery) {
        socket.emit('battery-update', {
          socketId: s.socketId, badge: s.badgeNumber,
          name: s.name, rank: s.rank,
          level: s.battery.level, charging: s.battery.charging,
          timestamp: s.battery.timestamp
        });
      }
    }
  });

  // ── Location: Soldier → CP ───────────────────────────────────────────────
  socket.on('location-update', (data) => {
    const s = activeSoldiers.get(socket.id);
    if (!s) return;
    // Store latest location on the soldier record
    s.location = {
      lat:       data.lat,
      lng:       data.lng,
      accuracy:  data.accuracy,
      altitude:  data.altitude,
      speed:     data.speed,
      provider:  data.provider,
      timestamp: data.timestamp
    };
    io.to('cp').emit('location-update', {
      socketId: socket.id,
      name:     s.name,
      rank:     s.rank,
      unit:     s.unit,
      badge:    s.badgeNumber,
      location: s.location
    });
  });

  // ── Video frame: Soldier → CP ─────────────────────────────────────────────
  socket.on('video-frame', (frameData) => {
    io.to('cp').emit('video-frame', {
      socketId: socket.id,
      frame:    frameData
    });
  });

  // ── Audio: Soldier → CP (live stream) ────────────────────────────────────
  socket.on('audio-soldier', (payload) => {
    const s = activeSoldiers.get(socket.id);

    // Geuza payload kuwa Float32 array halisi
    // Android inatuma Array<Float> — inaweza kuja kama Buffer au Array
    let floats;
    if (Buffer.isBuffer(payload)) {
      // Binary buffer: tafsiri kama IEEE 754 float32 little-endian
      floats = Array.from(new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4));
    } else if (Array.isArray(payload)) {
      floats = payload.map(Number);
    } else {
      floats = Array.from(payload).map(Number);
    }

    io.to('cp').emit('audio-from-soldier', {
      socketId: socket.id,
      name:     s?.name || 'Unknown',
      rank:     s?.rank || '',
      audio:    floats
    });

    // Accumulate for STT
    const buf = pttAudioBuffers.get(socket.id);
    if (buf && buf.length < MAX_PTT_SAMPLES) {
      for (const v of floats) buf.push(v);
    }
  });

  // ── PTT: Soldier → CP ────────────────────────────────────────────────────
  socket.on('ptt-start', () => {
    const s = activeSoldiers.get(socket.id);
    if (!s) return;
    pttAudioBuffers.set(socket.id, []);
    io.to('cp').emit('ptt-start', { socketId: socket.id, name: s.name, rank: s.rank, unit: s.unit });
    console.log(`[PTT] ${s.rank} ${s.name} anaanza kuzungumza`);
  });

  socket.on('ptt-stop', async () => {
    const s = activeSoldiers.get(socket.id);
    if (!s) return;
    io.to('cp').emit('ptt-stop', { socketId: socket.id, name: s.name, rank: s.rank });
    console.log(`[PTT] ${s.rank} ${s.name} amesimama`);

    const samples = pttAudioBuffers.get(socket.id) || [];
    pttAudioBuffers.delete(socket.id);
    if (samples.length < 1600) return;

    console.log(`[STT] Inafanya transcript — ${(samples.length/16000).toFixed(1)}s...`);
    io.to('cp').emit('ptt-transcript', {
      socketId: socket.id, badge: s.badgeNumber,
      name: s.name, rank: s.rank, text: null, processing: true
    });
    const text = await transcribeWav(encodeWav(samples));
    if (text) console.log(`[STT] ${s.name}: "${text}"`);
    io.to('cp').emit('ptt-transcript', {
      socketId: socket.id, badge: s.badgeNumber,
      name: s.name, rank: s.rank,
      text: text || null, processing: false, time: Date.now()
    });
  });

  // ── Audio: CP → Soldier (live stream) ────────────────────────────────────
  socket.on('audio-cp', (payload) => {
    const isBroadcast = payload.targetId === 'all';
    const data = { audio: payload.audio, broadcast: isBroadcast };
    if (isBroadcast) {
      io.to('soldiers').emit('audio-from-cp', data);
    } else {
      io.to(payload.targetId).emit('audio-from-cp', data);
    }
  });

  // ── Location request: CP → Soldier ───────────────────────────────────────
  socket.on('request-location', ({ targetId }) => {
    io.to(targetId).emit('request-location');
  });

  // ── Command: CP → Soldiers ────────────────────────────────────────────────
  socket.on('command', (payload) => {
    if (payload.targetId === 'all') {
      io.to('soldiers').emit('receive-command', { message: payload.message });
    } else {
      io.to(payload.targetId).emit('receive-command', { message: payload.message });
    }
    // Echo to CP log
    io.to('cp').emit('command-log', {
      to:      payload.targetId === 'all' ? 'Wote' : activeSoldiers.get(payload.targetId)?.name,
      message: payload.message,
      time:    new Date().toISOString()
    });
  });

  // ── Smartwatch connection status: Soldier → CP ───────────────────────────
  socket.on('watch-status', (data) => {
    const s = activeSoldiers.get(socket.id);
    if (!s) return;
    s.watchConnected = data.connected;
    io.to('cp').emit('watch-status', {
      socketId:  socket.id,
      badge:     s.badgeNumber,
      connected: data.connected
    });
    console.log(`[Watch] ${s.name} saa ${data.connected ? 'imeunganika ✓' : 'imekatika'}`);
  });

  // ── Health data: Soldier → CP ────────────────────────────────────────────
  socket.on('health-data', (data) => {
    const s = activeSoldiers.get(socket.id);
    if (!s) return;
    // Cache latest health on soldier record
    s.health = {
      heartRate:   data.heartRate,
      temperature: data.temperature,
      spo2:        data.spo2,
      timestamp:   data.timestamp
    };
    io.to('cp').emit('health-data', {
      socketId:    socket.id,
      badge:       s.badgeNumber,
      name:        s.name,
      rank:        s.rank,
      heartRate:   data.heartRate,
      temperature: data.temperature,
      spo2:        data.spo2,
      timestamp:   data.timestamp
    });
    console.log(`[Health] ${s.name} — HR:${data.heartRate} Temp:${data.temperature} SpO2:${data.spo2}`);
  });

  // ── Battery: Soldier → CP ────────────────────────────────────────────────
  socket.on('battery-update', (data) => {
    const s = activeSoldiers.get(socket.id);
    if (!s) return;
    s.battery = { level: data.level, charging: data.charging, timestamp: data.timestamp };
    io.to('cp').emit('battery-update', {
      socketId:  socket.id,
      badge:     s.badgeNumber,
      name:      s.name,
      rank:      s.rank,
      level:     data.level,
      charging:  data.charging,
      timestamp: data.timestamp
    });
    console.log(`[Battery] ${s.name} — ${data.level}% ${data.charging ? '🔌 Inachaji' : ''}`);
  });

  // ── Request health: CP → specific Soldier ────────────────────────────────
  socket.on('request-health', (data) => {
    // Find the soldier's socket by badge number
    for (const [sid, s] of activeSoldiers.entries()) {
      if (s.badgeNumber === data.badge) {
        io.to(sid).emit('request-health');
        console.log(`[Health] CP imeomba data ya ${s.name}`);
        break;
      }
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    pttAudioBuffers.delete(socket.id);
    // Clear activeCP if this was the logged-in CP
    if (activeCP && activeCP.socketId === socket.id) {
      console.log(`[CP] "${activeCP.adminUsername}" amekatika`);
      activeCP = null;
    }
    if (activeSoldiers.has(socket.id)) {
      const s = activeSoldiers.get(socket.id);
      activeSoldiers.delete(socket.id);
      io.to('cp').emit('active-soldiers-update', Array.from(activeSoldiers.values()));
      io.to('cp').emit('soldier-left', { name: s.name, rank: s.rank });
      console.log(`[-] ${s.rank} ${s.name} amekatika`);
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 9000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🪖  Smart Soldier Server — Port ${PORT}\n`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`[Server] Port ${PORT} inatumika — server tayari inafanya kazi.`);
  }
});
