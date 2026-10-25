// p_wiz server: UDP control plane for WiZ lights + static UI.
// No dependencies — node core modules only (dgram + http + fs).
const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');

const PORT = process.env.PORT || 10000;
const HOST = process.env.HOST || '0.0.0.0';
const WIZ_PORT = 38899;
const PUBLIC = path.join(__dirname, '..', 'public');
const STORE_PATH = path.join(__dirname, 'lights.json');
const SCENES_PATH = path.join(__dirname, 'scenes.json');

// Name/room always derive from WiZ: numeric roomId + module come from hardware
// (getSystemConfig), friendly labels come from the WiZ app export (KNOWN).
// No manual mapping in the UI.
const KNOWN = {
  'cc408521d33c': { name: 'l2', room: 'playroom' },
  'cc408510e2b6': { name: 'k1', room: 'Bedroom' },
  '9877d50067d8': { name: 'l1', room: 'playroom' },
  '9877d5006844': { name: 'l3', room: 'playroom' },
};
function resolveMeta(mac, sys) {
  const k = KNOWN[mac];
  return {
    name: (k && k.name) || ('wiz-' + String(mac).slice(-4)),
    room: (k && k.room) || (sys && sys.roomId ? ('Room ' + String(sys.roomId).slice(-4)) : 'Lainnya'),
  };
}

function loadStore() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); } catch {}
  for (const [mac, v] of Object.entries(KNOWN)) {
    if (!s[mac]) s[mac] = Object.assign({ mac, ip: null, lastSeen: null }, v);
  }
  return s;
}

function saveStore(store) {
  try { fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2)); } catch (e) { console.log('save lights.json: ' + e.message); }
}

function readBody(req) {
  return new Promise((r) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => r(b || '{}')); });
}

// --- Scenes: timed color sequences, room- or device-level. e.g. 1s red -> 2s blue, loop. ---
function loadScenes() {
  try {
    const s = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));
    return Array.isArray(s) ? s : (s.scenes || []);
  } catch { return []; }
}
function saveScenes(scenes) {
  try { fs.writeFileSync(SCENES_PATH, JSON.stringify(scenes, null, 2)); } catch (e) { console.log('save scenes.json: ' + e.message); }
}
// --- Scenes: reusable timed color/off definitions. Target (room/device) chosen at play time. ---
function loadScenes() {
  try {
    const s = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));
    return Array.isArray(s) ? s : (s.scenes || []);
  } catch { return []; }
}
function saveScenes(scenes) {
  try { fs.writeFileSync(SCENES_PATH, JSON.stringify(scenes, null, 2)); } catch (e) { console.log('save scenes.json: ' + e.message); }
}
const players = {}; // targetKey -> { timer, step, sceneId, target }
function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b };
}
function normTarget(t) {
  if (t && t.type === 'device') return { type: 'device', mac: String(t.mac || '').toLowerCase() };
  return { type: 'room', room: String((t && t.room) || 'Lainnya') };
}
function targetKey(t) {
  t = normTarget(t);
  return t.type === 'device' ? 'dev:' + t.mac : 'room:' + t.room;
}
function resolveTargetIps(target) {
  target = normTarget(target);
  const all = Object.values(loadStore());
  if (target.type === 'device') {
    const l = all.find((x) => x.mac === target.mac);
    return l && l.ip ? [l.ip] : [];
  }
  return all.filter((l) => (l.room || 'Lainnya') === target.room && l.ip).map((l) => l.ip);
}
function stopTarget(key) {
  const p = players[key];
  if (p && p.timer) clearTimeout(p.timer);
  delete players[key];
}
function tickPlayer(key) {
  const p = players[key];
  if (!p) return;
  const scene = loadScenes().find((s) => s.id === p.sceneId);
  if (!scene) { stopTarget(key); return; }
  const steps = (scene.steps || []).filter((s) => s && s.secs > 0 && (s.off || hexToRgb(s.hex)));
  if (!steps.length) { stopTarget(key); return; }
  if (p.step >= steps.length) {
    if (scene.loop !== false) p.step = 0;
    else { stopTarget(key); return; }
  }
  const st = steps[p.step];
  const params = st.off ? { state: false } : Object.assign({ state: true }, hexToRgb(st.hex));
  const ips = resolveTargetIps(p.target);
  if (!ips.length) { stopTarget(key); return; }
  ips.forEach((ip) => { wizCall(ip, 'setPilot', params).catch(() => {}); });
  p.step += 1;
  p.timer = setTimeout(() => tickPlayer(key), Math.max(200, st.secs * 1000));
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function wizCall(ip, method, params = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { try { sock.close(); } catch {} resolve({ ok: false, error: 'timeout' }); }, 4000);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      try { sock.close(); } catch {}
      try { resolve({ ok: true, data: JSON.parse(msg.toString()) }); }
      catch { resolve({ ok: false, error: 'bad-json' }); }
    });
    sock.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e) }); });
    sock.send(JSON.stringify({ method, params }), WIZ_PORT, ip, (err) => {
      if (err) { clearTimeout(timer); try { sock.close(); } catch {} resolve({ ok: false, error: String(err.message || err) }); }
    });
  });
}

function discoverOne(localIp, bcast, timeoutMs) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      try {
        const p = JSON.parse(msg.toString());
        const mac = (p.result && p.result.mac) || rinfo.address;
        if (!found.has(mac)) found.set(mac, { ip: rinfo.address, mac, pilot: p.result || {} });
      } catch {}
    });
    sock.on('error', () => {});
    try { sock.bind(0, localIp, () => {
      try { sock.setBroadcast(true); } catch {}
      const pkt = JSON.stringify({ method: 'getPilot', params: {} });
      try { sock.send(pkt, WIZ_PORT, bcast); } catch {}
      setTimeout(() => { try { sock.close(); } catch {} resolve([...found.values()]); }, timeoutMs);
    }); } catch { resolve([]); }
    setTimeout(() => { try { sock.close(); } catch {} resolve([...found.values()]); }, timeoutMs + 2000);
  });
}

function localBroadcasts() {
  const out = [];
  try {
    const os = require('os');
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
        const bcast = ip.map((o, i) => (o | (~mask[i] & 255))).join('.');
        if (!out.some(x => x.bcast === bcast)) out.push({ ip: a.address, bcast });
      }
    }
  } catch {}
  return out;
}

function discover(timeoutMs = 3000, rounds = 3) {
  const seen = new Map();
  const ifs = localBroadcasts();
  if (!ifs.length) ifs.push({ ip: undefined, bcast: '255.255.255.255' });
  let chain = Promise.resolve();
  for (let r = 0; r < rounds; r++) {
    chain = chain.then(() => Promise.all(ifs.map(x => discoverOne(x.ip, x.bcast, timeoutMs))).then(all => {
      all.flat().forEach(l => { if (!seen.has(l.mac)) seen.set(l.mac, l); });
    }));
  }
  return chain.then(() => [...seen.values()]);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // normalize: also serve API under /app prefix (reverse-proxy / subpath opens)
    let ppath = url.pathname;
    if (ppath === '/app' || ppath.startsWith('/app/')) ppath = ppath.slice(4) || '/';
    if (req.method === 'GET' && ppath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && !ppath.startsWith('/api/')) {
      const rel = ppath === '/' ? 'index.html' : ppath.slice(1);
      const p = path.join(PUBLIC, path.normalize('/' + rel));
      let isFile = false;
      try { isFile = fs.statSync(p).isFile(); } catch {}
      if (!p.startsWith(PUBLIC) || !isFile) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
      return;
    }
    // 1+2: cached list — no scan needed on app open.
    if (req.method === 'GET' && ppath === '/api/lights') {
      const store = loadStore();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lights: Object.values(store) }));
      return;
    }
    // 3: scan refreshes IPs; name/room re-derived from WiZ (hardware ids + export labels).
    if (req.method === 'GET' && ppath === '/api/discover') {
      const found = await discover();
      const store = loadStore();
      const now = new Date().toISOString();
      // best-effort hardware identity + capability per light (parallel, keeps prior on timeout)
      const withSys = await Promise.all(found.map(async (l) => {
        const prev = store[l.mac] || {};
        const [s, m] = await Promise.all([wizCall(l.ip, 'getSystemConfig', {}), wizCall(l.ip, 'getModelConfig', {})]);
        const sr = s.ok && s.data && s.data.result;
        const mr = m.ok && m.data && m.data.result;
        const sys = sr ? { roomId: sr.roomId, homeId: sr.homeId, module: sr.moduleName, fw: sr.fwVersion }
                       : (prev.sys || null);
        // lightType 1 = RGB, 2 = tunable-white only (e.g. k1 ESP24_SHTWC_01). Unknown → assume color.
        const color = mr ? (mr.lightType === 1)
                         : (prev.caps ? prev.caps.color !== false : /shrgb/i.test(String(sys && sys.module || '')) || !sys);
        return Object.assign({}, l, { sys, caps: { color: !!color } });
      }));
      for (const l of withSys) {
        const prev = store[l.mac] || { mac: l.mac };
        store[l.mac] = Object.assign({}, prev, { mac: l.mac, ip: l.ip, pilot: l.pilot, sys: l.sys, caps: l.caps, lastSeen: now, online: true }, resolveMeta(l.mac, l.sys));
      }
      // mark offline ones (in store but not seen this scan)
      const seen = new Set(found.map((l) => l.mac));
      for (const mac of Object.keys(store)) store[mac].online = seen.has(mac) ? true : false;
      saveStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lights: Object.values(store) }));
      return;
    }
    if (req.method === 'POST' && ppath === '/api/pilot') {
      const body = JSON.parse(await readBody(req));
      const out = await wizCall(String(body.ip), body.method || 'setPilot', body.params || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }
    // --- Scenes: definitions only. Play binds a scene to a room/device target. ---
    if (req.method === 'GET' && ppath === '/api/scenes') {
      const playing = {};
      for (const [k, p] of Object.entries(players)) playing[k] = { sceneId: p.sceneId, step: p.step, target: p.target };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ scenes: loadScenes(), playing }));
      return;
    }
    if (req.method === 'POST' && ppath === '/api/scenes') {
      const body = JSON.parse(await readBody(req));
      const scenes = loadScenes();
      const steps = (body.steps || []).map((s) => ({ hex: String(s.hex || '#ffffff'), secs: Math.max(0.2, Math.min(3600, +s.secs || 1)), off: !!s.off })).slice(0, 20);
      if (!steps.length) { res.writeHead(400); res.end('{"error":"min 1 step"}'); return; }
      let sc;
      if (body.id) {
        sc = scenes.find((s) => s.id === String(body.id));
        if (!sc) { res.writeHead(404); res.end('{"error":"not found"}'); return; }
        Object.assign(sc, { name: String(body.name || sc.name || 'scene'), steps, loop: body.loop !== false });
      } else {
        sc = { id: Date.now().toString(36), name: String(body.name || 'scene'), steps, loop: body.loop !== false };
        scenes.push(sc);
      }
      delete sc.target; // legacy: scenes no longer bound to a target
      saveScenes(scenes);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, scene: sc }));
      return;
    }
    if (req.method === 'POST' && ppath === '/api/scenes/delete') {
      const body = JSON.parse(await readBody(req));
      const id = String(body.id);
      Object.keys(players).forEach((k) => { if (players[k].sceneId === id) stopTarget(k); });
      saveScenes(loadScenes().filter((s) => s.id !== id));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && ppath === '/api/scenes/play') {
      const body = JSON.parse(await readBody(req));
      const scene = loadScenes().find((s) => s.id === String(body.id));
      if (!scene) { res.writeHead(404); res.end('{"error":"scene not found"}'); return; }
      const target = normTarget(body.target);
      const key = targetKey(target);
      if (!resolveTargetIps(target).length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no online lights' }));
        return;
      }
      stopTarget(key);
      players[key] = { timer: null, step: 0, sceneId: scene.id, target };
      tickPlayer(key);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !!players[key], key }));
      return;
    }
    if (req.method === 'POST' && ppath === '/api/scenes/stop') {
      const body = JSON.parse(await readBody(req));
      if (body.all) Object.keys(players).forEach(stopTarget);
      else if (body.target) stopTarget(targetKey(body.target));
      else if (body.id) Object.keys(players).forEach((k) => { if (players[k].sceneId === String(body.id)) stopTarget(k); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, playing: Object.keys(players) }));
      return;
    }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(500); res.end(String(e).slice(0, 300)); }
});

server.listen(PORT, HOST, () => console.log('p_wiz on ' + HOST + ':' + PORT));
