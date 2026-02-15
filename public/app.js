// ===================================================================
//  AGENT WORLD — Live Frontend (connects to real backend)
//  Built for Moltiverse Hackathon on Monad
// ===================================================================

const API_BASE = window.location.origin + '/api';
const WS_URL = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';

// ===== SIMPLEX NOISE (for terrain rendering — same seed as server) =====
const SimplexNoise = (() => {
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  const grad3 = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
  class S {
    constructor(seed = Math.random()) {
      this.perm = new Uint8Array(512);
      this.permMod8 = new Uint8Array(512);
      const p = new Uint8Array(256);
      for (let i = 0; i < 256; i++) p[i] = i;
      let s = seed * 2147483647;
      for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; }
      for (let i = 0; i < 512; i++) { this.perm[i] = p[i & 255]; this.permMod8[i] = this.perm[i] % 8; }
    }
    noise2D(x, y) {
      const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s);
      const t = (i + j) * G2, X0 = i - t, Y0 = j - t, x0 = x - X0, y0 = y - Y0;
      const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
      const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
      const ii = i & 255, jj = j & 255;
      let n0 = 0, n1 = 0, n2 = 0;
      let t0 = 0.5 - x0*x0 - y0*y0;
      if (t0 >= 0) { const g = grad3[this.permMod8[ii + this.perm[jj]]]; t0 *= t0; n0 = t0*t0*(g[0]*x0 + g[1]*y0); }
      let t1 = 0.5 - x1*x1 - y1*y1;
      if (t1 >= 0) { const g = grad3[this.permMod8[ii+i1 + this.perm[jj+j1]]]; t1 *= t1; n1 = t1*t1*(g[0]*x1 + g[1]*y1); }
      let t2 = 0.5 - x2*x2 - y2*y2;
      if (t2 >= 0) { const g = grad3[this.permMod8[ii+1 + this.perm[jj+1]]]; t2 *= t2; n2 = t2*t2*(g[0]*x2 + g[1]*y2); }
      return 70 * (n0 + n1 + n2);
    }
  }
  return S;
})();

const terrainNoise = new SimplexNoise(42);
const moistureNoise = new SimplexNoise(137);
const textureNoise = new SimplexNoise(256);
const waterNoise = new SimplexNoise(999);

function fbm(fn, x, y, oct = 5, lac = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, max = 0;
  for (let i = 0; i < oct; i++) { sum += fn(x*freq, y*freq)*amp; max += amp; amp *= gain; freq *= lac; }
  return sum / max;
}

// ===== CONSTANTS =====
let GRID_W = 80, GRID_H = 55;
const BASE_CELL = 18;

const BIOME_COLORS = {
  deepWater:    { base: [10,15,50],    hi: [18,28,72],    name: 'Deep Ocean' },
  water:        { base: [15,35,80],    hi: [28,55,110],   name: 'Ocean' },
  shallowWater: { base: [25,60,105],   hi: [45,85,135],   name: 'Shallows' },
  beach:        { base: [140,128,78],  hi: [175,160,100], name: 'Beach' },
  desert:       { base: [155,125,62],  hi: [190,160,88],  name: 'Desert' },
  plains:       { base: [72,128,52],   hi: [100,168,72],  name: 'Plains' },
  grassland:    { base: [55,140,55],   hi: [82,185,78],   name: 'Grassland' },
  forest:       { base: [28,88,35],    hi: [48,125,52],   name: 'Forest' },
  denseForest:  { base: [18,62,22],    hi: [32,90,36],    name: 'Dense Forest' },
  tundra:       { base: [85,88,108],   hi: [120,125,148], name: 'Tundra' },
  mountain:     { base: [95,82,100],   hi: [135,118,140], name: 'Mountain' },
  snow:         { base: [175,180,198], hi: [220,225,240], name: 'Snow Peaks' },
};

const RESOURCES = {
  WOOD:    { name: 'Wood',    icon: '\u{1FAB5}', color: '#8B6914' },
  STONE:   { name: 'Stone',   icon: '\u{1FAA8}', color: '#808080' },
  GOLD:    { name: 'Gold',    icon: '\u2728',     color: '#FFD700' },
  FOOD:    { name: 'Food',    icon: '\u{1F33E}',  color: '#90EE90' },
  IRON:    { name: 'Iron',    icon: '\u26CF\uFE0F', color: '#B0C4DE' },
  CRYSTAL: { name: 'Crystal', icon: '\u{1F48E}',  color: '#E0B0FF' },
};

const BUILDINGS = {
  HOUSE:  { name: 'House',  icon: '\u{1F3E0}', shape: 'square' },
  FARM:   { name: 'Farm',   icon: '\u{1F33F}', shape: 'diamond' },
  MINE:   { name: 'Mine',   icon: '\u26CF\uFE0F', shape: 'triangle' },
  TOWER:  { name: 'Tower',  icon: '\u{1F3F0}', shape: 'hexagon' },
  MARKET: { name: 'Market', icon: '\u{1F3EA}', shape: 'diamond' },
  TEMPLE: { name: 'Temple', icon: '\u{1F3DB}\uFE0F', shape: 'hexagon' },
};

// ===== STATE =====
let worldTiles = [];  // [y][x] from server
let agentsList = [];
let alliances = [];
let activities = [];
let marketPrices = {};
let chainStats = null;   // real on-chain stats from contract
let recentTxns = [];      // real tx hashes
let meta = { epoch: 1, tickCount: 0, txnCount: 0, tradeCount: 0, gridW: 80, gridH: 55 };

let speed = 1, paused = false, selectedAgent = null, hoveredCell = null;
let cameraX = 0, cameraY = 0, zoom = 1.0;
let particles = [], tradeLines = [];
let canvas, ctx, minimapCanvas, minimapCtx;
let terrainBuffer = null, worldPixelW, worldPixelH;
let _time = 0;
let ws = null;
let wsConnected = false;
let prevAgentPositions = {};

// Wallet / Auth state
let walletAddress = null;
let sessionToken = null;
let economyStats = null;

// ===== TERRAIN RENDERING =====
function getElevation(x, y) {
  const scale = 0.04;
  let e = fbm((px, py) => terrainNoise.noise2D(px, py), x * scale, y * scale, 6);
  e = (e + 1) / 2;
  const dx = (x / GRID_W - 0.5) * 2, dy = (y / GRID_H - 0.5) * 2;
  const dist = Math.sqrt(dx*dx + dy*dy);
  e = e * (1 - 0.45 * Math.pow(dist, 1.6)) + 0.05;
  return Math.max(0, Math.min(1, e));
}

function getMoisture(x, y) {
  const scale = 0.055;
  return (fbm((px, py) => moistureNoise.noise2D(px, py), x * scale, y * scale, 4) + 1) / 2;
}

function getBiome(e, m) {
  if (e < 0.08) return 'deepWater';
  if (e < 0.15) return 'water';
  if (e < 0.20) return 'shallowWater';
  if (e < 0.25) return 'beach';
  if (e > 0.82) return 'snow';
  if (e > 0.72) return 'mountain';
  if (e > 0.62) return 'tundra';
  if (m < 0.20) return 'desert';
  if (m < 0.36) return 'plains';
  if (m < 0.52) return 'grassland';
  if (m < 0.70) return 'forest';
  return 'denseForest';
}

function isWater(b) { return b === 'deepWater' || b === 'water' || b === 'shallowWater'; }

function preRenderTerrain() {
  worldPixelW = GRID_W * BASE_CELL;
  worldPixelH = GRID_H * BASE_CELL;
  const STEP = 3;
  const sgW = Math.ceil(worldPixelW / STEP) + 2;
  const sgH = Math.ceil(worldPixelH / STEP) + 2;
  const elevArr = new Float32Array(sgW * sgH);
  const moistArr = new Float32Array(sgW * sgH);
  for (let gy = 0; gy < sgH; gy++) for (let gx = 0; gx < sgW; gx++) {
    const wx = (gx * STEP) / BASE_CELL, wy = (gy * STEP) / BASE_CELL;
    elevArr[gy * sgW + gx] = getElevation(wx, wy);
    moistArr[gy * sgW + gx] = getMoisture(wx, wy);
  }
  function bilerp(arr, px, py) {
    const gx = px / STEP, gy = py / STEP;
    const x0 = Math.max(0, Math.min(Math.floor(gx), sgW - 2));
    const y0 = Math.max(0, Math.min(Math.floor(gy), sgH - 2));
    const fx = Math.max(0, gx - x0), fy = Math.max(0, gy - y0);
    return arr[y0*sgW+x0]*(1-fx)*(1-fy) + arr[y0*sgW+x0+1]*fx*(1-fy) + arr[(y0+1)*sgW+x0]*(1-fx)*fy + arr[(y0+1)*sgW+x0+1]*fx*fy;
  }

  const off = document.createElement('canvas');
  off.width = worldPixelW; off.height = worldPixelH;
  const o = off.getContext('2d');
  const img = o.createImageData(worldPixelW, worldPixelH);
  const d = img.data;

  for (let py = 0; py < worldPixelH; py++) for (let px = 0; px < worldPixelW; px++) {
    const elev = bilerp(elevArr, px, py);
    const moist = bilerp(moistArr, px, py);
    const biome = getBiome(elev, moist);
    const bc = BIOME_COLORS[biome];
    const n = (textureNoise.noise2D(px * 0.1, py * 0.1) + 1) / 2;
    let r = bc.base[0] + (bc.hi[0] - bc.base[0]) * n;
    let g = bc.base[1] + (bc.hi[1] - bc.base[1]) * n;
    let b = bc.base[2] + (bc.hi[2] - bc.base[2]) * n;
    r += elev * 18; g += elev * 12; b += elev * 22;
    if (!isWater(biome)) {
      const eR = bilerp(elevArr, Math.min(px + 4, worldPixelW - 1), py);
      const eD = bilerp(elevArr, px, Math.min(py + 4, worldPixelH - 1));
      const shade = (elev - eR) + (elev - eD);
      if (shade > 0) { const f = Math.min(shade * 3.5, 0.45); r *= (1 - f); g *= (1 - f); b *= (1 - f); }
      else if (shade < -0.005) { const f = Math.min(-shade * 2.5, 0.18); r += (230 - r) * f; g += (240 - g) * f; b += (255 - b) * f; }
    }
    const idx = (py * worldPixelW + px) * 4;
    d[idx]   = Math.min(255, Math.max(0, r | 0));
    d[idx+1] = Math.min(255, Math.max(0, g | 0));
    d[idx+2] = Math.min(255, Math.max(0, b | 0));
    d[idx+3] = 255;
  }
  o.putImageData(img, 0, 0);
  terrainBuffer = off;
}

// ===== WEBSOCKET =====
function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    wsConnected = true;
    updateConnectionStatus('connected');
    console.log('[WS] Connected');
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWSMessage(data);
    } catch (err) {
      console.error('[WS] Parse error:', err);
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    updateConnectionStatus('disconnected');
    console.log('[WS] Disconnected, reconnecting in 3s...');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => {
    wsConnected = false;
    updateConnectionStatus('disconnected');
  };
}

function handleWSMessage(data) {
  if (data.type === 'init') {
    meta = data.meta || meta;
    GRID_W = meta.gridW || 80;
    GRID_H = meta.gridH || 55;
    if (data.agents) updateAgentsFromServer(data.agents);
  }

  if (data.type === 'tick') {
    if (data.meta) meta = data.meta;
    if (data.agents) updateAgentsFromServer(data.agents);
    if (data.activities) activities = data.activities;
    if (data.marketPrices) marketPrices = data.marketPrices;
    if (data.chainStats) chainStats = data.chainStats;
    if (data.transactions) recentTxns = data.transactions;
    if (data.alliances) alliances = data.alliances;
    updateUI();
  }
}

function updateAgentsFromServer(serverAgents) {
  // Track previous positions for animation
  for (const a of agentsList) {
    prevAgentPositions[a.id] = { x: a.x, y: a.y };
  }

  agentsList = serverAgents.map(a => {
    const prev = prevAgentPositions[a.id];
    return {
      ...a,
      prevX: prev ? prev.x : a.x,
      prevY: prev ? prev.y : a.y,
      animProgress: (prev && (prev.x !== a.x || prev.y !== a.y)) ? 0 : 1,
      pulsePhase: (prevAgentPositions[a.id]?.pulsePhase) || Math.random() * Math.PI * 2,
      trail: (agentsList.find(old => old.id === a.id)?.trail || []),
    };
  });

  // Update trails
  for (const a of agentsList) {
    const prev = prevAgentPositions[a.id];
    if (prev && (prev.x !== a.x || prev.y !== a.y)) {
      a.trail.push({ x: prev.x, y: prev.y, age: 0 });
      if (a.trail.length > 12) a.trail.shift();
    }
    for (const t of a.trail) t.age++;
  }
}

function updateConnectionStatus(status) {
  const badge = document.getElementById('connection-status');
  const text = document.getElementById('conn-text');
  badge.className = 'connection-badge ' + status;
  text.textContent = status === 'connected' ? 'Live' : 'Reconnecting...';
  document.getElementById('ws-status').textContent = status === 'connected' ? 'Live' : 'Off';
}

// ===== INITIAL DATA FETCH =====
async function fetchFullState() {
  try {
    const res = await fetch(API_BASE + '/world/state');
    const data = await res.json();

    meta = data.meta;
    GRID_W = meta.gridW || 80;
    GRID_H = meta.gridH || 55;

    // Parse tiles into 2D array
    worldTiles = [];
    for (let y = 0; y < GRID_H; y++) worldTiles[y] = [];
    for (const t of data.tiles) {
      worldTiles[t.y][t.x] = {
        x: t.x, y: t.y, biome: t.b, elevation: t.e, moisture: t.m,
        resource: t.r, resourceAmount: t.ra, ownerId: t.o, building: t.bl,
      };
    }

    if (data.agents) updateAgentsFromServer(data.agents);
    if (data.marketPrices) marketPrices = data.marketPrices;
    if (data.alliances) alliances = data.alliances;

    // Fetch activities
    const actRes = await fetch(API_BASE + '/activities');
    activities = await actRes.json();

    console.log('[INIT] Full state loaded:', GRID_W, 'x', GRID_H, 'tiles,', agentsList.length, 'agents');
  } catch (err) {
    console.error('[INIT] Failed to fetch state:', err);
  }
}

// ===== CANVAS =====
function initCanvas() {
  canvas = document.getElementById('world-canvas');
  ctx = canvas.getContext('2d');
  minimapCanvas = document.getElementById('minimap-canvas');
  minimapCtx = minimapCanvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  minimapCanvas.addEventListener('click', onMinimapClick);
}

function resizeCanvas() {
  const c = document.getElementById('map-container');
  canvas.width = c.clientWidth; canvas.height = c.clientHeight;
  minimapCanvas.width = 160; minimapCanvas.height = 160;
  clampCamera();
}

function clampCamera() {
  const maxX = Math.max(0, worldPixelW * zoom - canvas.width);
  const maxY = Math.max(0, worldPixelH * zoom - canvas.height);
  cameraX = Math.max(0, Math.min(cameraX, maxX));
  cameraY = Math.max(0, Math.min(cameraY, maxY));
}

function onWheel(e) {
  e.preventDefault();
  const oldZoom = zoom;
  zoom = Math.max(0.5, Math.min(3.0, zoom + (e.deltaY > 0 ? -0.1 : 0.1)));
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  cameraX = (cameraX + mx) / oldZoom * zoom - mx;
  cameraY = (cameraY + my) / oldZoom * zoom - my;
  clampCamera();
}

function onMinimapClick(e) {
  const rect = minimapCanvas.getBoundingClientRect();
  cameraX = ((e.clientX - rect.left) / 160) * worldPixelW * zoom - canvas.width / 2;
  cameraY = ((e.clientY - rect.top) / 160) * worldPixelH * zoom - canvas.height / 2;
  clampCamera();
}

// ===== RENDER =====
function renderWorld(ts) {
  _time = ts || 0;
  const CS = BASE_CELL * zoom;

  ctx.fillStyle = '#030308';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (terrainBuffer) {
    const sx = cameraX / zoom, sy = cameraY / zoom;
    const sw = canvas.width / zoom, sh = canvas.height / zoom;
    ctx.drawImage(terrainBuffer, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  }

  const startCol = Math.max(0, Math.floor(cameraX / CS));
  const endCol = Math.min(GRID_W, Math.ceil((cameraX + canvas.width) / CS));
  const startRow = Math.max(0, Math.floor(cameraY / CS));
  const endRow = Math.min(GRID_H, Math.ceil((cameraY + canvas.height) / CS));

  // Animated water
  for (let y = startRow; y < endRow; y++) for (let x = startCol; x < endCol; x++) {
    const tile = worldTiles[y]?.[x];
    if (!tile || !isWater(tile.biome)) continue;
    const px = x*CS - cameraX, py = y*CS - cameraY;
    const step = Math.max(2, Math.floor(3/zoom));
    for (let wy = 0; wy < CS; wy += step) for (let wx = 0; wx < CS; wx += step) {
      const wn = waterNoise.noise2D((x*BASE_CELL+wx/zoom)*0.04+_time*0.0012, (y*BASE_CELL+wy/zoom)*0.04+_time*0.0008);
      if (wn > 0.2) { ctx.fillStyle = `rgba(60,140,220,${(wn-0.2)*0.35})`; ctx.fillRect(px+wx, py+wy, step, step); }
    }
  }

  // Territory overlay
  for (let y = startRow; y < endRow; y++) for (let x = startCol; x < endCol; x++) {
    const tile = worldTiles[y]?.[x];
    if (!tile || !tile.ownerId) continue;
    const owner = agentsList.find(a => a.id === tile.ownerId);
    if (!owner) continue;
    const px = x*CS - cameraX, py = y*CS - cameraY;
    ctx.fillStyle = owner.color + '18';
    ctx.fillRect(px, py, CS, CS);
    ctx.strokeStyle = owner.color + '45'; ctx.lineWidth = Math.max(1, 1.5 * zoom);
    for (const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nx = x+dx, ny = y+dy;
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H || worldTiles[ny]?.[nx]?.ownerId !== tile.ownerId) {
        ctx.beginPath();
        if (dx === -1) { ctx.moveTo(px, py); ctx.lineTo(px, py+CS); }
        if (dx === 1) { ctx.moveTo(px+CS, py); ctx.lineTo(px+CS, py+CS); }
        if (dy === -1) { ctx.moveTo(px, py); ctx.lineTo(px+CS, py); }
        if (dy === 1) { ctx.moveTo(px, py+CS); ctx.lineTo(px+CS, py+CS); }
        ctx.stroke();
      }
    }
  }

  // Resources
  for (let y = startRow; y < endRow; y++) for (let x = startCol; x < endCol; x++) {
    const tile = worldTiles[y]?.[x];
    if (!tile || !tile.resource || tile.resourceAmount <= 0) continue;
    const px = x*CS - cameraX + CS/2, py = y*CS - cameraY + CS/2;
    const pulse = Math.sin(_time*0.003 + x + y) * 0.25 + 0.85;
    const rc = RESOURCES[tile.resource]?.color || '#fff';
    ctx.save();
    ctx.shadowColor = rc; ctx.shadowBlur = 18*zoom;
    ctx.fillStyle = rc + '35';
    ctx.beginPath(); ctx.arc(px, py, 9*zoom*pulse, 0, Math.PI*2); ctx.fill();
    ctx.shadowBlur = 10*zoom; ctx.fillStyle = rc;
    ctx.beginPath(); ctx.arc(px, py, 4.5*zoom*pulse, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ffffffaa';
    ctx.beginPath(); ctx.arc(px, py, 1.5*zoom, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // Buildings
  for (let y = startRow; y < endRow; y++) for (let x = startCol; x < endCol; x++) {
    const tile = worldTiles[y]?.[x];
    if (!tile || !tile.building) continue;
    const bl = BUILDINGS[tile.building];
    if (!bl) continue;
    const owner = tile.ownerId ? agentsList.find(a => a.id === tile.ownerId) : null;
    const col = owner ? owner.color : '#888';
    const px = x*CS - cameraX + CS/2, py = y*CS - cameraY + CS/2, sz = CS*0.52;
    ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 16*zoom;
    ctx.fillStyle = col + '60'; ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, 2*zoom);
    if (bl.shape === 'square') { ctx.fillRect(px-sz, py-sz, sz*2, sz*2); ctx.strokeRect(px-sz, py-sz, sz*2, sz*2); }
    else if (bl.shape === 'diamond') { ctx.beginPath(); ctx.moveTo(px,py-sz); ctx.lineTo(px+sz,py); ctx.lineTo(px,py+sz); ctx.lineTo(px-sz,py); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    else if (bl.shape === 'triangle') { ctx.beginPath(); ctx.moveTo(px,py-sz); ctx.lineTo(px+sz,py+sz); ctx.lineTo(px-sz,py+sz); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    else if (bl.shape === 'hexagon') { ctx.beginPath(); for (let i=0;i<6;i++){const an=Math.PI/3*i-Math.PI/6;i===0?ctx.moveTo(px+sz*Math.cos(an),py+sz*Math.sin(an)):ctx.lineTo(px+sz*Math.cos(an),py+sz*Math.sin(an));}ctx.closePath();ctx.fill();ctx.stroke();}
    ctx.shadowBlur = 0; ctx.font = `${Math.max(13, CS*0.65)}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(bl.icon, px, py+1);
    ctx.restore();
  }

  // Trade lines
  for (const tl of tradeLines) {
    const x1 = tl.x1*CS - cameraX + CS/2, y1 = tl.y1*CS - cameraY + CS/2;
    const x2 = tl.x2*CS - cameraX + CS/2, y2 = tl.y2*CS - cameraY + CS/2;
    ctx.save(); ctx.globalAlpha = tl.life*0.6;
    ctx.strokeStyle = tl.color; ctx.lineWidth = 2*zoom; ctx.shadowColor = tl.color; ctx.shadowBlur = 8;
    ctx.setLineDash([6*zoom, 4*zoom]); ctx.lineDashOffset = -_time*0.05;
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    ctx.setLineDash([]);
    const progress = (_time*0.003) % 1;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x1+(x2-x1)*progress, y1+(y2-y1)*progress, 3*zoom, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // Agent trails
  for (const a of agentsList) {
    if (!a.alive || !a.trail) continue;
    for (const tr of a.trail) {
      const alpha = Math.max(0, 0.35 - tr.age * 0.03);
      if (alpha <= 0) continue;
      ctx.fillStyle = a.color; ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(tr.x*CS - cameraX + CS/2, tr.y*CS - cameraY + CS/2, 2.5*zoom, 0, Math.PI*2); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Agents
  for (const a of agentsList) {
    if (!a.alive) continue;
    a.animProgress = Math.min(1, (a.animProgress || 0) + 0.15);
    const t = easeOut(a.animProgress);
    const lx = (a.prevX || a.x) + (a.x - (a.prevX || a.x)) * t;
    const ly = (a.prevY || a.y) + (a.y - (a.prevY || a.y)) * t;
    const px = lx*CS - cameraX + CS/2, py = ly*CS - cameraY + CS/2;
    const pulse = Math.sin(_time*0.004 + (a.pulsePhase||0)) * 0.18 + 1;
    const r = CS * 0.48 * pulse;

    ctx.save();
    ctx.shadowColor = a.color; ctx.shadowBlur = 28*zoom;
    ctx.fillStyle = a.color + '25';
    ctx.beginPath(); ctx.arc(px, py, r*2, 0, Math.PI*2); ctx.fill(); ctx.fill();
    ctx.shadowBlur = 16*zoom; ctx.fillStyle = a.color + '55';
    ctx.beginPath(); ctx.arc(px, py, r*1.1, 0, Math.PI*2); ctx.fill();
    ctx.shadowBlur = 8*zoom; ctx.fillStyle = a.color;
    ctx.beginPath(); ctx.arc(px, py, r*0.6, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ffffffcc';
    ctx.beginPath(); ctx.arc(px, py, r*0.22, 0, Math.PI*2); ctx.fill();
    ctx.restore();

    ctx.font = `${Math.max(12, CS*0.65)}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(a.emoji, px, py+1);

    if (a.health < a.maxHealth) {
      const bw = CS*0.95, bh = 3*zoom, bx = px-bw/2, by = py-r-6*zoom;
      ctx.fillStyle = '#00000099'; ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = a.health > 50 ? '#34d399' : a.health > 25 ? '#fbbf24' : '#f87171';
      ctx.fillRect(bx, by, bw*(a.health/a.maxHealth), bh);
    }

    ctx.font = `bold ${Math.max(8, 9*zoom)}px Inter,sans-serif`; ctx.textAlign = 'center';
    ctx.fillStyle = a.color; ctx.fillText(a.name, px, py+r+12*zoom);

    if (selectedAgent === a.id) {
      ctx.save(); ctx.strokeStyle = a.color; ctx.lineWidth = 2*zoom;
      ctx.shadowColor = a.color; ctx.shadowBlur = 12;
      ctx.setLineDash([5*zoom, 3*zoom]); ctx.lineDashOffset = -_time*0.03;
      ctx.beginPath(); ctx.arc(px, py, r*2.2, 0, Math.PI*2); ctx.stroke();
      ctx.setLineDash([]); ctx.restore();
    }
  }

  // Particles
  for (const p of particles) {
    const ppx = p.x*zoom - cameraX, ppy = p.y*zoom - cameraY;
    ctx.save(); ctx.globalAlpha = p.life; ctx.shadowColor = p.color; ctx.shadowBlur = 5;
    ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(ppx, ppy, p.size*p.life*zoom, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // Hover
  if (hoveredCell) {
    const hpx = hoveredCell.x*CS - cameraX, hpy = hoveredCell.y*CS - cameraY;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
    ctx.strokeRect(hpx, hpy, CS, CS);
  }

  // Vignette
  const vg = ctx.createRadialGradient(canvas.width/2, canvas.height/2, Math.min(canvas.width,canvas.height)*0.35, canvas.width/2, canvas.height/2, Math.max(canvas.width,canvas.height)*0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(2,2,8,0.5)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function renderMinimap() {
  const cw = 160/GRID_W, ch = 160/GRID_H;
  minimapCtx.fillStyle = '#030308'; minimapCtx.fillRect(0, 0, 160, 160);
  for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
    const t = worldTiles[y]?.[x];
    if (!t) continue;
    if (t.ownerId) {
      const owner = agentsList.find(a => a.id === t.ownerId);
      minimapCtx.fillStyle = owner ? owner.color : '#333';
    } else {
      const bc = BIOME_COLORS[t.biome]?.base || [30,30,30];
      minimapCtx.fillStyle = `rgb(${bc[0]},${bc[1]},${bc[2]})`;
    }
    minimapCtx.fillRect(x*cw, y*ch, cw+0.5, ch+0.5);
  }
  for (const a of agentsList) {
    if (!a.alive) continue;
    minimapCtx.fillStyle = a.color;
    minimapCtx.fillRect(a.x*cw-0.5, a.y*ch-0.5, 3, 3);
  }
  const vpX = (cameraX/(worldPixelW*zoom))*160, vpY = (cameraY/(worldPixelH*zoom))*160;
  const vpW = (canvas.width/(worldPixelW*zoom))*160, vpH = (canvas.height/(worldPixelH*zoom))*160;
  minimapCtx.strokeStyle = '#836EF9'; minimapCtx.lineWidth = 1.5;
  minimapCtx.strokeRect(vpX, vpY, vpW, vpH);
}

function easeOut(t) { return 1 - Math.pow(1-t, 3); }

function updateParticles() {
  for (let i = particles.length-1; i >= 0; i--) {
    const p = particles[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.06; p.life -= 0.025;
    if (p.life <= 0) particles.splice(i, 1);
  }
  for (let i = tradeLines.length-1; i >= 0; i--) {
    tradeLines[i].life -= 0.015;
    if (tradeLines[i].life <= 0) tradeLines.splice(i, 1);
  }
}

// ===== UI UPDATE =====
function shortAddr(addr) { return addr ? addr.slice(0,6)+'...'+addr.slice(-4) : ''; }
function shortTx(hash) { return hash ? hash.slice(0,10)+'...'+hash.slice(-6) : ''; }
function explorerTx(hash) { return hash ? `https://monadscan.com/tx/${hash}` : '#'; }
function explorerAddr(addr) { return addr ? `https://monadscan.com/address/${addr}` : '#'; }

function updateUI() {
  const alive = agentsList.filter(a => a.alive);

  // Header stats — use REAL on-chain numbers when available
  document.getElementById('epoch-counter').textContent = meta.epoch;
  document.getElementById('agent-count').textContent = chainStats ? chainStats.agentCount : agentsList.length;
  document.getElementById('txn-count').textContent = chainStats ? chainStats.totalClaims : (meta.txnCount || 0);
  document.getElementById('trade-count').textContent = chainStats ? chainStats.tradeCount : (meta.tradeCount || 0);
  document.getElementById('alive-count').textContent = alive.length;
  document.getElementById('tick-display').textContent = meta.tickCount || 0;

  // Agent list
  document.getElementById('agent-list').innerHTML = agentsList.map(a => `
    <div class="agent-card ${a.alive?'alive':'dead'} ${a.idle?'idle':''} ${selectedAgent===a.id?'selected':''}" onclick="selectAgent('${a.id}')">
      <div class="agent-avatar" style="background:${a.color}20;color:${a.color}">${a.emoji}</div>
      <div class="agent-info">
        <div class="agent-name" style="color:${a.alive?(a.idle?'var(--text-muted)':a.color):'var(--text-muted)'}">${a.name}${a.idle?' <span class="idle-tag">IDLE</span>':''}</div>
        <div class="agent-meta">
          <span>${a.strategy}</span>
          <span class="xyz-mini">${a.xyzBalance !== undefined ? Math.floor(a.xyzBalance)+' $REAI' : ''}</span>
        </div>
      </div>
      <div class="agent-wealth">${a.alive?(a.score||0)+'\u2B21':'\u2014'}</div>
    </div>`).join('');

  // Alliances
  document.getElementById('alliance-list').innerHTML = alliances.length
    ? alliances.map(al => `
      <div class="alliance-card"><div class="alliance-name" style="color:${al.color}">${al.name} <span class="alliance-treasury">${al.treasury||0} $REAI</span></div>
      <div class="alliance-members">${(al.memberIds||[]).map(id => {
        const a = agentsList.find(ag => ag.id === id);
        return a ? `<span class="alliance-member-dot" style="background:${a.color}30;color:${a.color}" title="${a.name}">${a.emoji}</span>` : '';
      }).join('')}</div></div>`).join('')
    : '<div style="color:var(--text-muted);font-size:11px;padding:8px">No alliances yet...</div>';

  // Leaderboard (use server-computed score)
  const sorted = [...agentsList].filter(a => a.alive).sort((a,b) => (b.score||0) - (a.score||0));
  document.getElementById('leaderboard').innerHTML = sorted.slice(0,8).map((a,i) => {
    return `<div class="lb-row" onclick="selectAgent('${a.id}')"><span class="lb-rank ${i===0?'gold':i===1?'silver':i===2?'bronze':''}">#${i+1}</span><span style="font-size:14px">${a.emoji}</span><span class="lb-name" style="color:${a.color}">${a.name}</span><span class="lb-score">${a.score||0}</span></div>`;
  }).join('');

  // Activity feed — show real tx hashes when available
  document.getElementById('activity-feed').innerHTML = activities.slice(0,30).map(a => {
    // Find matching tx for this activity
    const matchTx = recentTxns.find(t => t.from_agent && a.agent_id && t.tx_type === a.type);
    const txLink = matchTx && matchTx.tx_hash
      ? ` <a href="${explorerTx(matchTx.tx_hash)}" target="_blank" style="color:var(--accent);font-size:9px;font-family:'JetBrains Mono',monospace">[${shortTx(matchTx.tx_hash)}]</a>`
      : '';
    return `<div class="activity-item ${a.type}"><div>${a.message}${txLink}</div><div class="activity-time">E${a.epoch}:${String(a.tick%1000).padStart(3,'0')}</div></div>`;
  }).join('');

  // Market
  document.getElementById('market-prices').innerHTML = Object.entries(marketPrices).map(([k,d]) => {
    const r = RESOURCES[k]; if (!r) return '';
    const cc = (d.change||0) >= 0 ? 'up' : 'down', ci = (d.change||0) >= 0 ? '\u25B2' : '\u25BC';
    return `<div class="market-row"><div class="market-resource"><span class="market-resource-icon" style="background:${r.color}20">${r.icon}</span><span>${r.name}</span></div><div><span class="market-price">${(d.price||0).toFixed(2)} MON</span> <span class="market-change ${cc}">${ci} ${Math.abs(d.change||0).toFixed(1)}%</span></div></div>`;
  }).join('');

  // Economy stats
  const es = economyStats || {};
  const cs = chainStats || {};
  document.getElementById('world-stats').innerHTML = `
    <div class="economy-divider"><div class="section-label">$REAI Economy</div></div>
    <div class="world-stat-row"><span class="label">Circulating $REAI</span><span class="value" style="color:var(--accent-light)">${es.totalCirculating !== undefined ? Math.floor(es.totalCirculating) : '?'}</span></div>
    <div class="world-stat-row"><span class="label">Total Deposited</span><span class="value" style="color:var(--green)">${es.totalDeposited !== undefined ? Math.floor(es.totalDeposited) : '?'}</span></div>
    <div class="world-stat-row"><span class="label">Total Burned</span><span class="value" style="color:var(--red)">${es.totalBurned !== undefined ? Math.floor(es.totalBurned) : '?'}</span></div>
    <div class="world-stat-row"><span class="label">Active Agents</span><span class="value" style="color:var(--green)">${es.activeAgents ?? alive.length}</span></div>
    <div class="world-stat-row"><span class="label">Idle Agents</span><span class="value" style="color:var(--yellow)">${es.idleAgents ?? '0'}</span></div>
    <div class="world-stat-row"><span class="label">Alliances</span><span class="value">${alliances.length}</span></div>
    <div class="economy-divider" style="margin-top:8px"><div class="section-label">On-Chain (Monad)</div></div>
    <div class="world-stat-row"><span class="label">Contract</span><span class="value"><a href="${explorerAddr(cs.contractAddress)}" target="_blank" style="color:var(--accent);text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:10px">${shortAddr(cs.contractAddress||'')}</a></span></div>
    <div class="world-stat-row"><span class="label">On-Chain Agents</span><span class="value">${cs.agentCount ?? '?'}</span></div>
    <div class="world-stat-row"><span class="label">On-Chain Claims</span><span class="value">${cs.totalClaims ?? '?'}</span></div>
    <div class="world-stat-row"><span class="label">On-Chain Trades</span><span class="value">${cs.tradeCount ?? '?'}</span></div>
    <div class="world-stat-row"><span class="label">Master Balance</span><span class="value" style="color:var(--yellow)">${cs.masterBalance ? parseFloat(cs.masterBalance).toFixed(3)+' MON' : '?'}</span></div>
    <div class="world-stat-row"><span class="label">On-Chain Txs</span><span class="value">${cs.onChainTxCount ?? '?'}</span></div>`;

  // Recent on-chain transactions feed
  if (recentTxns.length > 0) {
    const txHtml = recentTxns.slice(0,5).filter(t => t.tx_hash).map(t => {
      const icon = t.tx_type === 'register' ? '\u{1F4DD}' : t.tx_type === 'claim' ? '\u{1F6A9}' : t.tx_type === 'trade' ? '\u{1F4B1}' : t.tx_type === 'build' ? '\u{1F3D7}\uFE0F' : '\u26D3\uFE0F';
      return `<div class="world-stat-row" style="margin-top:2px"><span class="label">${icon} ${t.tx_type}</span><span class="value"><a href="${explorerTx(t.tx_hash)}" target="_blank" style="color:var(--accent);text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:9px">${shortTx(t.tx_hash)}</a></span></div>`;
    }).join('');
    document.getElementById('world-stats').innerHTML += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border)"><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Recent On-Chain Txns</div>${txHtml}</div>`;
  }

  // Footer
  if (activities.length > 0) {
    document.getElementById('latest-event').innerHTML = activities[0].message;
  }
  document.getElementById('rpc-status').textContent = chainStats ? 'Connected' : 'Pending';
}

// ===== INTERACTION =====
function onMouseMove(e) {
  const rect = canvas.getBoundingClientRect();
  const CS = BASE_CELL * zoom;
  const mx = e.clientX - rect.left + cameraX, my = e.clientY - rect.top + cameraY;
  const gx = Math.floor(mx/CS), gy = Math.floor(my/CS);
  if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H) {
    hoveredCell = { x: gx, y: gy };
    const tile = worldTiles[gy]?.[gx];
    const bn = tile ? (BIOME_COLORS[tile.biome]?.name || tile.biome) : '?';
    document.getElementById('hover-coords').textContent = `(${gx}, ${gy}) \u2014 ${bn}`;

    const tip = document.getElementById('tooltip');
    let h = `<div class="tooltip-title">${bn} (${gx},${gy})</div>`;
    if (tile) {
      h += `<div class="tooltip-row"><span>Elevation</span><span>${((tile.elevation||0)*100).toFixed(0)}m</span></div>`;
      if (tile.ownerId) {
        const o = agentsList.find(a => a.id === tile.ownerId);
        if (o) h += `<div class="tooltip-row"><span>Owner</span><span style="color:${o.color}">${o.emoji} ${o.name}</span></div>`;
      }
      if (tile.resource) h += `<div class="tooltip-row"><span>Resource</span><span>${RESOURCES[tile.resource]?.icon||''} ${RESOURCES[tile.resource]?.name||tile.resource} (${tile.resourceAmount})</span></div>`;
      if (tile.building) h += `<div class="tooltip-row"><span>Building</span><span>${BUILDINGS[tile.building]?.icon||''} ${BUILDINGS[tile.building]?.name||tile.building}</span></div>`;
    }
    const ah = agentsList.find(a => a.alive && a.x === gx && a.y === gy);
    if (ah) {
      h += `<div class="tooltip-row"><span>Agent</span><span style="color:${ah.color}">${ah.emoji} ${ah.name}</span></div>`;
      h += `<div class="tooltip-row"><span>Strategy</span><span>${ah.strategy}</span></div>`;
      h += `<div class="tooltip-row"><span>$REAI</span><span style="color:var(--accent-light)">${ah.xyzBalance !== undefined ? Math.floor(ah.xyzBalance) : '?'}</span></div>`;
      h += `<div class="tooltip-row"><span>Score</span><span style="color:var(--yellow)">${ah.score||0}</span></div>`;
      if (ah.idle) h += `<div class="tooltip-row"><span>Status</span><span style="color:var(--yellow)">IDLE</span></div>`;
    }
    tip.innerHTML = h; tip.classList.remove('hidden');
    tip.style.left = (e.clientX - rect.left + 16) + 'px';
    tip.style.top = (e.clientY - rect.top + 16) + 'px';
    const tr = tip.getBoundingClientRect();
    if (tr.right > window.innerWidth) tip.style.left = (e.clientX - rect.left - tr.width - 8) + 'px';
    if (tr.bottom > window.innerHeight) tip.style.top = (e.clientY - rect.top - tr.height - 8) + 'px';
  } else {
    hoveredCell = null;
    document.getElementById('tooltip').classList.add('hidden');
  }
}

function onCanvasClick(e) {
  if (isDragging && dragMoved) return;
  const rect = canvas.getBoundingClientRect(), CS = BASE_CELL * zoom;
  const gx = Math.floor((e.clientX - rect.left + cameraX)/CS);
  const gy = Math.floor((e.clientY - rect.top + cameraY)/CS);
  const ah = agentsList.find(a => a.x === gx && a.y === gy);
  if (ah) { selectAgent(ah.id); showAgentModal(ah.id); }
}

function selectAgent(id) {
  selectedAgent = selectedAgent === id ? null : id;
  if (selectedAgent) {
    const a = agentsList.find(ag => ag.id === selectedAgent);
    if (a) {
      const CS = BASE_CELL * zoom;
      cameraX = Math.max(0, Math.min(a.x*CS - canvas.width/2, worldPixelW*zoom - canvas.width));
      cameraY = Math.max(0, Math.min(a.y*CS - canvas.height/2, worldPixelH*zoom - canvas.height));
    }
  }
}

function showAgentModal(id) {
  const a = agentsList.find(ag => ag.id === id);
  if (!a) return;

  // Find on-chain txns for this agent
  const agentTxns = recentTxns.filter(t => t.from_agent === a.walletAddress || t.to_agent === a.walletAddress);
  const onChainTxns = agentTxns.filter(t => t.tx_hash);

  const statusText = a.alive ? (a.idle ? 'IDLE (0 $REAI)' : 'ACTIVE') : 'ELIMINATED';
  const statusColor = a.alive ? (a.idle ? 'var(--yellow)' : 'var(--green)') : 'var(--red)';
  const llmLabel = a.llmMode === 'webhook' ? 'Webhook' : a.llmMode === 'byokey' ? 'Own Key' : 'Platform AI';

  document.getElementById('modal-body').innerHTML = `
    <div class="modal-agent-header"><div class="modal-avatar" style="background:${a.color}20;font-size:32px">${a.emoji}</div>
    <div><div class="modal-agent-name" style="color:${a.color}">${a.name}</div><div class="modal-agent-type">${a.strategy} &mdash; <span style="color:${statusColor}">${statusText}</span></div></div></div>
    <div class="modal-stats">
      <div class="modal-stat"><div class="modal-stat-label">$REAI Balance</div><div class="modal-stat-value" style="color:var(--accent-light)">${a.xyzBalance !== undefined ? Math.floor(a.xyzBalance) : '?'}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">Score</div><div class="modal-stat-value" style="color:var(--yellow)">${a.score||0}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">Health</div><div class="modal-stat-value" style="color:${a.health>50?'var(--green)':'var(--red)'}">${a.health}/${a.maxHealth}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">Territory</div><div class="modal-stat-value" style="color:var(--accent)">${a.territory||0} tiles</div></div>
      <div class="modal-stat"><div class="modal-stat-label">Buildings</div><div class="modal-stat-value">${a.buildingsCount||0}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">Trades</div><div class="modal-stat-value">${a.tradesCount||0}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">Kills</div><div class="modal-stat-value" style="color:var(--red)">${a.kills||0}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">Deaths</div><div class="modal-stat-value">${a.deaths||0}</div></div>
    </div>

    <div style="margin-top:12px;padding:10px;background:var(--bg-tertiary);border-radius:8px;border:1px solid var(--border)">
      <div class="modal-section-title">Financials (P&L)</div>
      <div id="modal-financials" class="financial-grid">
        <div class="financial-item"><div class="fin-label">Loading...</div></div>
      </div>
    </div>

    <div class="modal-inventory" style="margin-top:12px"><div class="modal-section-title">Inventory</div>
    <div class="inventory-grid">${Object.entries(RESOURCES).map(([k,r]) => `<div class="inventory-item"><div class="inventory-icon">${r.icon}</div><div class="inventory-amount">${a.inventory?.[k]||0}</div><div class="inventory-name">${r.name}</div></div>`).join('')}</div></div>

    <div style="margin-top:12px;padding:10px;background:var(--bg-tertiary);border-radius:8px;border:1px solid var(--border)">
      <div class="modal-section-title">Agent Info</div>
      <div class="world-stat-row"><span class="label">LLM Mode</span><span class="value">${llmLabel}</span></div>
      <div class="world-stat-row"><span class="label">Position</span><span class="value">(${a.x}, ${a.y})</span></div>
      <div class="world-stat-row"><span class="label">Wallet</span><span class="value"><a href="${explorerAddr(a.walletAddress)}" target="_blank" style="color:var(--accent);text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:10px">${shortAddr(a.walletAddress)}</a></span></div>
    </div>
    ${onChainTxns.length > 0 ? `
    <div style="margin-top:12px;padding:10px;background:var(--bg-tertiary);border-radius:8px;border:1px solid var(--border)">
      <div class="modal-section-title">On-Chain Transactions</div>
      ${onChainTxns.slice(0,5).map(t => {
        const icon = t.tx_type === 'register' ? '\u{1F4DD}' : t.tx_type === 'claim' ? '\u{1F6A9}' : t.tx_type === 'trade' ? '\u{1F4B1}' : t.tx_type === 'build' ? '\u{1F3D7}\uFE0F' : '\u26D3\uFE0F';
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:11px">${icon} ${t.tx_type}</span>
          <a href="${explorerTx(t.tx_hash)}" target="_blank" style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--accent);text-decoration:none">${shortTx(t.tx_hash)}</a>
        </div>`;
      }).join('')}
    </div>` : ''}`;

  document.getElementById('agent-modal').classList.remove('hidden');

  // Async-fetch financials
  fetchAgentFinancials(a.id);
}

async function fetchAgentFinancials(agentId) {
  try {
    const res = await fetch(API_BASE + '/agents/' + agentId + '/financials');
    if (!res.ok) return;
    const fin = await res.json();
    const el = document.getElementById('modal-financials');
    if (!el) return;
    const roi = (fin.totalEarned || 0) - (fin.totalSpent || 0);
    const roiPct = fin.totalDeposited > 0 ? (roi / fin.totalDeposited * 100).toFixed(1) : '0';
    el.innerHTML = `
      <div class="financial-item"><div class="fin-label">Total Deposited</div><div class="fin-value neutral">${Math.floor(fin.totalDeposited||0)}</div></div>
      <div class="financial-item"><div class="fin-label">Total Earned</div><div class="fin-value positive">${Math.floor(fin.totalEarned||0)}</div></div>
      <div class="financial-item"><div class="fin-label">Total Spent</div><div class="fin-value negative">${Math.floor(fin.totalSpent||0)}</div></div>
      <div class="financial-item"><div class="fin-label">ROI</div><div class="fin-value ${roi >= 0 ? 'positive' : 'negative'}">${roi >= 0 ? '+' : ''}${Math.floor(roi)} (${roiPct}%)</div></div>`;
  } catch {}
}

function closeModal() { document.getElementById('agent-modal').classList.add('hidden'); }
document.addEventListener('click', e => { if (e.target.classList.contains('modal-backdrop')) { closeModal(); closeRegisterModal(); }});

// ===== REGISTER AGENT =====
document.getElementById('register-btn').addEventListener('click', async () => {
  if (!walletAddress) {
    // Auto-trigger wallet connect, then open register on success
    const connected = await connectWalletFlow();
    if (!connected) return;
  }
  // Reset form for fresh registration
  document.getElementById('register-form').style.display = '';
  document.getElementById('register-result').style.display = 'none';
  document.getElementById('register-modal').classList.remove('hidden');
});

function closeRegisterModal() { document.getElementById('register-modal').classList.add('hidden'); }

document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('reg-name').value.trim();
  const strategy = document.getElementById('reg-strategy').value || undefined;
  const customPrompt = document.getElementById('reg-prompt').value.trim() || undefined;
  const webhookUrl = document.getElementById('reg-webhook').value.trim() || undefined;

  // New fields
  const llmModeEl = document.querySelector('.llm-mode-option.active');
  const llmMode = llmModeEl ? llmModeEl.dataset.mode : 'platform';
  const llmKeysRaw = document.getElementById('reg-llm-keys')?.value.trim();
  const llmKeys = llmKeysRaw ? llmKeysRaw.split(',').map(k => k.trim()).filter(Boolean) : undefined;
  const depositAmount = parseInt(document.getElementById('reg-deposit')?.value) || 100;

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Deploying...';

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (sessionToken) headers['X-Session-Token'] = sessionToken;

    const res = await fetch(API_BASE + '/agents/register', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, strategy, customPrompt, webhookUrl, llmMode, llmKeys, depositAmount }),
    });
    const data = await res.json();

    if (res.ok) {
      const resultDiv = document.getElementById('register-result');
      resultDiv.style.display = 'block';
      resultDiv.innerHTML = `
        <div style="color:var(--green);font-weight:600;margin-bottom:8px">Agent Deployed!</div>
        <div class="api-key-box">
          <div class="label">Agent ID</div>
          <div class="value">${data.agent.id}</div>
        </div>
        <div class="api-key-box" style="margin-top:8px">
          <div class="label">API Key (save this &mdash; used to control your agent)</div>
          <div class="value">${data.agent.apiKey}</div>
        </div>
        <div class="api-key-box" style="margin-top:8px">
          <div class="label">Monad Wallet Address</div>
          <div class="value">${data.agent.walletAddress}</div>
        </div>
        <div class="api-key-box" style="margin-top:8px;border-color:var(--red)">
          <div class="label" style="color:var(--red)">Wallet Private Key (SAVE THIS — cannot be recovered!)</div>
          <div class="value" style="color:var(--red)">${data.agent.walletPrivateKey}</div>
        </div>
        <div class="api-key-box" style="margin-top:8px">
          <div class="label">$REAI Balance</div>
          <div class="value">${depositAmount} $REAI</div>
        </div>
        <div style="margin-top:12px;font-size:11px;color:var(--text-muted)">
          <b>Control your agent via API:</b><br>
          POST /api/agents/${data.agent.id}/action<br>
          Header: X-API-Key: ${data.agent.apiKey}<br>
          Body: {"action":{"type":"move","dx":1,"dy":0}}
        </div>`;
      document.getElementById('register-form').style.display = 'none';
    } else {
      alert(data.error || 'Registration failed');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Deploy Agent to World';
  }
});

// ===== CONTROLS =====
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    speed = parseFloat(btn.dataset.speed);
  });
});

document.getElementById('pause-btn').addEventListener('click', () => {
  paused = !paused;
  document.getElementById('pause-icon').setAttribute('d', paused ? 'M8 5v14l11-7z' : 'M6 4h4v16H6V4zm8 0h4v16h-4V4z');
});

document.addEventListener('keydown', e => {
  const PAN = 60;
  switch (e.key) {
    case 'ArrowLeft': case 'a': cameraX = Math.max(0, cameraX-PAN); break;
    case 'ArrowRight': case 'd': cameraX = Math.min(worldPixelW*zoom-canvas.width, cameraX+PAN); break;
    case 'ArrowUp': case 'w': cameraY = Math.max(0, cameraY-PAN); break;
    case 'ArrowDown': case 's': cameraY = Math.min(worldPixelH*zoom-canvas.height, cameraY+PAN); break;
    case ' ': paused = !paused; e.preventDefault(); break;
    case 'Escape': closeModal(); closeRegisterModal(); selectedAgent = null; break;
    case '+': case '=': zoom = Math.min(3, zoom+0.15); clampCamera(); break;
    case '-': zoom = Math.max(0.5, zoom-0.15); clampCamera(); break;
  }
});

let isDragging = false, dragMoved = false, lastMx, lastMy;
document.getElementById('world-canvas')?.addEventListener('mousedown', e => {
  if (e.button === 0) { isDragging = true; dragMoved = false; lastMx = e.clientX; lastMy = e.clientY; }
});
document.addEventListener('mousemove', e => {
  if (isDragging) {
    const dx = e.clientX - lastMx, dy = e.clientY - lastMy;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
    cameraX -= dx; cameraY -= dy; clampCamera();
    lastMx = e.clientX; lastMy = e.clientY;
  }
});
document.addEventListener('mouseup', () => { isDragging = false; });

// ===== PERIODIC FULL STATE REFRESH =====
// Tiles change (resources mined, land claimed, buildings built) so we refresh periodically
async function refreshTileState() {
  try {
    const res = await fetch(API_BASE + '/world/state');
    const data = await res.json();
    for (const t of data.tiles) {
      if (!worldTiles[t.y]) worldTiles[t.y] = [];
      worldTiles[t.y][t.x] = {
        x: t.x, y: t.y, biome: t.b, elevation: t.e, moisture: t.m,
        resource: t.r, resourceAmount: t.ra, ownerId: t.o, building: t.bl,
      };
    }
    if (data.alliances) alliances = data.alliances;
  } catch {}
}

// ===== GAME LOOP =====
function gameLoop(ts) {
  _time = ts || 0;
  updateParticles();
  renderWorld(ts);
  renderMinimap();
  requestAnimationFrame(gameLoop);
}

// ===== INIT =====
async function init() {
  initCanvas();

  // Fetch initial state
  await fetchFullState();

  // Pre-render terrain
  preRenderTerrain();

  // Center camera
  cameraX = Math.max(0, (worldPixelW*zoom - canvas.width)/2);
  cameraY = Math.max(0, (worldPixelH*zoom - canvas.height)/2);

  // Connect WebSocket
  connectWS();

  // Start render loop
  updateUI();
  requestAnimationFrame(gameLoop);

  // Periodic tile refresh (every 10s)
  setInterval(refreshTileState, 10000);

  // Periodic economy stats refresh (every 8s)
  fetchEconomyStats();
  setInterval(fetchEconomyStats, 8000);

  // Setup wallet connect
  setupWalletConnect();

  // Setup LLM mode toggle
  setupLLMModeToggle();

  console.log('[INIT] Agent World ready');
}

// ===== ECONOMY STATS FETCH =====
async function fetchEconomyStats() {
  try {
    const res = await fetch(API_BASE + '/economy/stats');
    if (res.ok) economyStats = await res.json();
  } catch {}
}

// ===== WALLET CONNECT (MetaMask / window.ethereum) =====
async function connectWalletFlow() {
  const btn = document.getElementById('connect-wallet-btn');
  const btnText = document.getElementById('wallet-btn-text');

  if (!window.ethereum) {
    alert('MetaMask not detected. Please install MetaMask to connect your wallet.');
    return false;
  }

  try {
    btnText.textContent = 'Connecting...';

    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const addr = accounts[0];

    const nonceRes = await fetch(API_BASE + '/auth/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: addr }),
    });
    const nonceData = await nonceRes.json();

    const signature = await window.ethereum.request({
      method: 'personal_sign',
      params: [nonceData.message, addr],
    });

    const verifyRes = await fetch(API_BASE + '/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: addr, signature }),
    });
    const verifyData = await verifyRes.json();

    if (verifyRes.ok && verifyData.sessionToken) {
      walletAddress = addr;
      sessionToken = verifyData.sessionToken;
      localStorage.setItem('agentworld_session', sessionToken);
      localStorage.setItem('agentworld_wallet', walletAddress);
      btnText.textContent = shortAddr(walletAddress);
      btn.classList.add('connected');
      document.getElementById('dashboard-btn').style.display = '';
      console.log('[WALLET] Connected:', shortAddr(walletAddress));
      return true;
    } else {
      alert('Wallet verification failed: ' + (verifyData.error || 'Unknown error'));
      btnText.textContent = 'Connect Wallet';
      return false;
    }
  } catch (err) {
    console.error('[WALLET] Error:', err);
    btnText.textContent = 'Connect Wallet';
    if (err.code !== 4001) alert('Wallet connection error: ' + err.message);
    return false;
  }
}

function disconnectWallet() {
  walletAddress = null;
  sessionToken = null;
  localStorage.removeItem('agentworld_session');
  localStorage.removeItem('agentworld_wallet');
  document.getElementById('wallet-btn-text').textContent = 'Connect Wallet';
  document.getElementById('connect-wallet-btn').classList.remove('connected');
  document.getElementById('dashboard-btn').style.display = 'none';
  closeDashboardPanel();
}

function setupWalletConnect() {
  const btn = document.getElementById('connect-wallet-btn');
  const btnText = document.getElementById('wallet-btn-text');

  // Restore session from localStorage
  const savedSession = localStorage.getItem('agentworld_session');
  const savedWallet = localStorage.getItem('agentworld_wallet');
  if (savedSession && savedWallet) {
    sessionToken = savedSession;
    walletAddress = savedWallet;
    btnText.textContent = shortAddr(walletAddress);
    btn.classList.add('connected');
    document.getElementById('dashboard-btn').style.display = '';
  }

  btn.addEventListener('click', async () => {
    if (walletAddress) {
      disconnectWallet();
    } else {
      await connectWalletFlow();
    }
  });
}

// ===== DASHBOARD (RIGHT SLIDE PANEL) =====
function closeDashboardPanel() {
  document.getElementById('dashboard-panel').classList.add('hidden');
  document.getElementById('dashboard-overlay').classList.add('hidden');
}

async function openDashboard() {
  if (!walletAddress || !sessionToken) {
    const ok = await connectWalletFlow();
    if (!ok) return;
  }

  document.getElementById('dashboard-panel').classList.remove('hidden');
  document.getElementById('dashboard-overlay').classList.remove('hidden');
  document.getElementById('dashboard-wallet-addr').textContent = walletAddress;
  document.getElementById('dashboard-agents').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Loading...</div>';
  document.getElementById('dashboard-alliances').innerHTML = '';

  try {
    const res = await fetch(API_BASE + '/dashboard', {
      headers: { 'X-Session-Token': sessionToken },
    });

    if (!res.ok) {
      document.getElementById('dashboard-agents').innerHTML = '<div style="color:var(--red);padding:12px">Failed to load. Try reconnecting wallet.</div>';
      return;
    }

    const data = await res.json();

    // Summary row
    document.getElementById('dashboard-summary').innerHTML = `
      <div class="dashboard-summary-grid">
        <div class="dashboard-summary-item"><div class="ds-label">Agents</div><div class="ds-value" style="color:var(--accent-light)">${data.agents.length}</div></div>
        <div class="dashboard-summary-item"><div class="ds-label">Total $REAI</div><div class="ds-value" style="color:var(--yellow)">${Math.floor(data.totalXyzBalance || 0)}</div></div>
        <div class="dashboard-summary-item"><div class="ds-label">Total ROI</div><div class="ds-value" style="color:${(data.totalRoi||0) >= 0 ? 'var(--green)' : 'var(--red)'}">${(data.totalRoi||0) >= 0 ? '+' : ''}${Math.floor(data.totalRoi || 0)}</div></div>
      </div>`;

    // Agents
    if (data.agents.length === 0) {
      document.getElementById('dashboard-agents').innerHTML = '';
      document.getElementById('dashboard-empty').style.display = 'block';
    } else {
      document.getElementById('dashboard-empty').style.display = 'none';
      document.getElementById('dashboard-agents').innerHTML = data.agents.map(a => {
        const statusText = a.alive ? (a.idle ? 'IDLE (0 $REAI)' : 'ACTIVE') : 'ELIMINATED';
        const statusIcon = a.alive ? (a.idle ? '\u{1F4A4}' : '\u26A1') : '\u{1F480}';
        const statusColor = a.alive ? (a.idle ? 'var(--yellow)' : 'var(--green)') : 'var(--red)';
        const roi = a.roi || 0;
        const roiPct = a.roiPct || '0';
        return `
          <div class="dashboard-agent-card">
            <div class="da-header">
              <div class="da-avatar" style="background:${a.color}20">${a.emoji}</div>
              <div style="flex:1">
                <div class="da-name" style="color:${a.color}">${a.name}</div>
                <div class="da-sub">${a.strategy} &mdash; <span style="color:${statusColor}">${statusIcon} ${statusText}</span></div>
                <div class="da-sub">${a.llmMode === 'webhook' ? 'Webhook' : a.llmMode === 'byokey' ? 'Own API Key' : 'Platform AI (1 $REAI/tick)'}</div>
              </div>
            </div>

            <div class="da-stats">
              <div class="da-stat"><div class="da-stat-label">$REAI Balance</div><div class="da-stat-value" style="color:var(--accent-light)">${Math.floor(a.xyzBalance || 0)}</div></div>
              <div class="da-stat"><div class="da-stat-label">Score</div><div class="da-stat-value" style="color:var(--yellow)">${a.score || 0}</div></div>
              <div class="da-stat"><div class="da-stat-label">Territory</div><div class="da-stat-value">${a.territory || 0}</div></div>
              <div class="da-stat"><div class="da-stat-label">ROI</div><div class="da-stat-value" style="color:${roi >= 0 ? 'var(--green)' : 'var(--red)'}">${roi >= 0 ? '+' : ''}${Math.floor(roi)} (${roiPct}%)</div></div>
            </div>

            <div class="earnings-breakdown">
              <div class="eb-row"><span class="eb-label">Health</span><span class="eb-value" style="color:${a.health > 50 ? 'var(--green)' : 'var(--red)'}">${a.health} / 100</span></div>
              <div class="eb-row"><span class="eb-label">Deposited</span><span class="eb-value neutral">${Math.floor(a.totalDeposited || 0)} $REAI</span></div>
              <div class="eb-row"><span class="eb-label">Total Earned</span><span class="eb-value positive">+${Math.floor(a.totalEarned || 0)} $REAI</span></div>
              <div class="eb-row"><span class="eb-label">Total Spent</span><span class="eb-value negative">-${Math.floor(a.totalSpent || 0)} $REAI</span></div>
              <div class="eb-row"><span class="eb-label">Buildings</span><span class="eb-value">${a.buildingsCount || 0}</span></div>
              <div class="eb-row"><span class="eb-label">Trades</span><span class="eb-value">${a.tradesCount || 0}</span></div>
              <div class="eb-row"><span class="eb-label">Kills / Deaths</span><span class="eb-value">${a.kills || 0} / ${a.deaths || 0}</span></div>
            </div>

            <div class="da-actions">
              ${a.idle ? `<button class="da-btn" style="border-color:var(--yellow);color:var(--yellow)" onclick="dashboardTopUp('${a.id}')">Top Up to Resume</button>` : `<button class="da-btn" onclick="dashboardTopUp('${a.id}')">Top Up $REAI</button>`}
              <button class="da-btn" onclick="dashboardExportKey('${a.id}')">Export Key</button>
              <button class="da-btn danger" onclick="dashboardWithdraw('${a.id}')">Withdraw MON</button>
              <button class="da-btn" onclick="selectAgent('${a.id}');closeDashboardPanel()">View on Map</button>
            </div>
          </div>`;
      }).join('');
    }

    // Alliances
    if (data.alliances && data.alliances.length > 0) {
      document.getElementById('dashboard-alliances').innerHTML = data.alliances.map(al => {
        const members = (al.memberIds || []).map(id => {
          const a = agentsList.find(ag => ag.id === id);
          return a ? `<span class="alliance-member-dot" style="background:${a.color}30;color:${a.color}" title="${a.name}">${a.emoji}</span>` : '';
        }).join('');
        const totalScore = (al.memberIds || []).reduce((sum, id) => {
          const a = agentsList.find(ag => ag.id === id);
          return sum + (a ? (a.score || 0) : 0);
        }, 0);
        const totalTerritory = (al.memberIds || []).reduce((sum, id) => {
          const a = agentsList.find(ag => ag.id === id);
          return sum + (a ? (a.territory || 0) : 0);
        }, 0);
        // Find which of my agents is in this alliance
        const myAgentInAlliance = data.agents.find(a => a.allianceId === al.id);
        return `
          <div class="da-alliance-card">
            <div class="da-alliance-header">
              <div class="da-alliance-name" style="color:${al.color}">${al.name}</div>
              <span style="font-size:10px;color:var(--text-muted)">${(al.memberIds||[]).length} members</span>
            </div>
            <div class="da-alliance-members">${members}</div>
            <div class="da-alliance-stats">
              <div class="da-alliance-stat"><div class="da-stat-label">Treasury</div><div class="da-stat-value" style="color:var(--yellow)">${al.treasury || 0}</div></div>
              <div class="da-alliance-stat"><div class="da-stat-label">Territory</div><div class="da-stat-value">${totalTerritory}</div></div>
              <div class="da-alliance-stat"><div class="da-stat-label">Score</div><div class="da-stat-value">${totalScore}</div></div>
            </div>
            ${myAgentInAlliance ? `<div class="da-actions">
              <button class="da-btn" onclick="dashboardContributeAlliance('${myAgentInAlliance.id}')">Contribute $REAI</button>
              <button class="da-btn danger" onclick="dashboardLeaveAlliance('${myAgentInAlliance.id}')">Leave Alliance</button>
            </div>` : ''}
          </div>`;
      }).join('');
    } else {
      document.getElementById('dashboard-alliances').innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:8px">No alliances — your agents\' AI will propose them automatically.</div>';
    }

  } catch (err) {
    document.getElementById('dashboard-agents').innerHTML = `<div style="color:var(--red);padding:12px">Error: ${err.message}</div>`;
  }
}

async function dashboardTopUp(agentId) {
  const amount = prompt('Enter $REAI amount to top up:');
  if (!amount || isNaN(amount) || parseInt(amount) <= 0) return;

  try {
    const res = await fetch(API_BASE + '/agents/' + agentId + '/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ amount: parseInt(amount) }),
    });
    const data = await res.json();
    if (res.ok) {
      alert('Top up successful! New balance: ' + Math.floor(data.newBalance || 0) + ' $REAI');
      openDashboard(); // Refresh
    } else {
      alert('Top up failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function dashboardExportKey(agentId) {
  if (!confirm('This will reveal your agent wallet private key. Are you sure?')) return;

  try {
    const res = await fetch(API_BASE + '/agents/' + agentId + '/export', {
      headers: { 'X-Session-Token': sessionToken },
    });
    const data = await res.json();
    if (res.ok) {
      prompt('Your agent wallet private key (copy it):', data.privateKey);
    } else {
      alert('Export failed: ' + (data.error || 'Not authorized'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function dashboardWithdraw(agentId) {
  const toAddr = prompt('Withdraw MON to address (leave blank for your connected wallet):', walletAddress || '');
  if (toAddr === null) return; // Cancelled

  const amount = prompt('Amount to withdraw (or "max" for all):');
  if (!amount) return;

  try {
    const res = await fetch(API_BASE + '/agents/' + agentId + '/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ toAddress: toAddr || walletAddress, amount: amount === 'max' ? 'max' : amount }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert('Withdrawn ' + data.amount + ' MON! Tx: ' + data.txHash);
      openDashboard();
    } else {
      alert('Withdraw failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ===== DASHBOARD ALLIANCE ACTIONS =====
async function dashboardContributeAlliance(agentId) {
  const amount = prompt('How much $REAI to contribute to alliance treasury?', '10');
  if (!amount || isNaN(amount) || Number(amount) <= 0) return;

  try {
    const res = await fetch(API_BASE + '/agents/' + agentId + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ type: 'contribute_alliance', amount: Number(amount) }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert('Contributed ' + amount + ' $REAI to alliance treasury!');
      openDashboard();
    } else {
      alert('Contribute failed: ' + (data.error || data.message || 'Unknown error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function dashboardLeaveAlliance(agentId) {
  if (!confirm('Leave your alliance? This cannot be undone.')) return;

  try {
    const res = await fetch(API_BASE + '/agents/' + agentId + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ type: 'leave_alliance' }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert('Left alliance successfully.');
      openDashboard();
    } else {
      alert('Leave failed: ' + (data.error || data.message || 'Unknown error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ===== LLM MODE TOGGLE (in register form) =====
function setupLLMModeToggle() {
  document.querySelectorAll('.llm-mode-option').forEach(opt => {
    opt.addEventListener('click', () => {
      document.querySelectorAll('.llm-mode-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');

      const keysInput = document.getElementById('llm-keys-group');
      const webhookInput = document.getElementById('webhook-group');
      if (keysInput) keysInput.className = 'llm-keys-input' + (opt.dataset.mode === 'byokey' ? ' visible' : '');
      if (webhookInput) webhookInput.style.display = opt.dataset.mode === 'webhook' ? 'block' : 'none';
    });
  });
}

init();
