const config = require('./config');
const db = require('./db');

// ===== SIMPLEX NOISE (same algo as frontend) =====
class SimplexNoise {
  constructor(seed = Math.random()) {
    this.perm = new Uint8Array(512);
    this.permMod8 = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = seed * 2147483647;
    for (let i = 255; i > 0; i--) {
      s = (s * 16807) % 2147483647;
      const j = s % (i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod8[i] = this.perm[i] % 8;
    }
  }
  noise2D(x, y) {
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;
    const grad3 = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
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

const terrainNoise = new SimplexNoise(config.WORLD_SEED);
const moistureNoise = new SimplexNoise(config.WORLD_SEED + 95);

function fbm(fn, x, y, oct = 5, lac = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, max = 0;
  for (let i = 0; i < oct; i++) {
    sum += fn(x * freq, y * freq) * amp;
    max += amp; amp *= gain; freq *= lac;
  }
  return sum / max;
}

function getElevation(x, y) {
  const scale = 0.04;
  let e = fbm((px, py) => terrainNoise.noise2D(px, py), x * scale, y * scale, 6);
  e = (e + 1) / 2;
  const dx = (x / config.GRID_W - 0.5) * 2, dy = (y / config.GRID_H - 0.5) * 2;
  const dist = Math.sqrt(dx * dx + dy * dy);
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

function isWater(b) {
  return b === 'deepWater' || b === 'water' || b === 'shallowWater';
}

// ===== WORLD STATE (in-memory cache backed by MySQL) =====
let tiles = [];       // tiles[y][x]
let epoch = 1;
let tickCount = 0;
let txnCount = 0;
let tradeCount = 0;

function getTile(x, y) {
  if (x < 0 || x >= config.GRID_W || y < 0 || y >= config.GRID_H) return null;
  return tiles[y]?.[x] || null;
}

// ===== GENERATE WORLD =====
async function generateWorld() {
  // Check if world already exists in DB
  const existing = await db.query('SELECT COUNT(*) as cnt FROM tiles');
  if (existing[0].cnt > 0) {
    console.log('[WORLD] Loading existing world from database...');
    await loadWorldFromDB();
    return;
  }

  console.log('[WORLD] Generating new world...');
  tiles = [];
  const batchValues = [];

  for (let y = 0; y < config.GRID_H; y++) {
    tiles[y] = [];
    for (let x = 0; x < config.GRID_W; x++) {
      const elev = getElevation(x, y);
      const moist = getMoisture(x, y);
      const biome = getBiome(elev, moist);

      let resource = null, resourceAmt = 0;
      if (!isWater(biome)) {
        for (const [k, r] of Object.entries(config.RESOURCES)) {
          if (r.biomes.includes(biome) && Math.random() < 0.4) {
            resource = k;
            resourceAmt = Math.floor(Math.random() * 8) + 3;
            break;
          }
        }
      }

      tiles[y][x] = {
        x, y, biome, elevation: elev, moisture: moist,
        resource, resourceAmount: resourceAmt,
        ownerId: null, building: null,
      };

      batchValues.push([x, y, biome, elev, moist, resource, resourceAmt, null, null]);
    }
  }

  // Bulk insert tiles
  const BATCH_SIZE = 500;
  for (let i = 0; i < batchValues.length; i += BATCH_SIZE) {
    const batch = batchValues.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
    const flat = batch.flat();
    await db.execute(
      `INSERT INTO tiles (x, y, biome, elevation, moisture, resource, resource_amount, owner_id, building) VALUES ${placeholders}`,
      flat
    );
  }

  // Init market prices
  for (const [k] of Object.entries(config.RESOURCES)) {
    const basePrice = k === 'CRYSTAL' ? 20 : k === 'GOLD' ? 12 : k === 'IRON' ? 6 : k === 'STONE' ? 4 : k === 'WOOD' ? 2.5 : 1.5;
    await db.execute(
      'INSERT INTO market_prices (resource, price, price_change) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE price = price',
      [k, basePrice]
    );
  }

  await db.setState('epoch', 1);
  await db.setState('tickCount', 0);
  await db.setState('txnCount', 0);
  await db.setState('tradeCount', 0);

  console.log(`[WORLD] Generated ${config.GRID_W}x${config.GRID_H} world with ${batchValues.length} tiles`);
}

async function loadWorldFromDB() {
  tiles = [];
  for (let y = 0; y < config.GRID_H; y++) tiles[y] = [];

  const rows = await db.query('SELECT * FROM tiles');
  for (const r of rows) {
    tiles[r.y][r.x] = {
      x: r.x, y: r.y, biome: r.biome,
      elevation: r.elevation, moisture: r.moisture,
      resource: r.resource, resourceAmount: r.resource_amount,
      ownerId: r.owner_id, building: r.building,
    };
  }

  epoch = await db.getState('epoch', 1);
  tickCount = await db.getState('tickCount', 0);
  txnCount = await db.getState('txnCount', 0);
  tradeCount = await db.getState('tradeCount', 0);

  console.log(`[WORLD] Loaded world: epoch=${epoch}, ticks=${tickCount}`);
}

// ===== TILE OPERATIONS =====
async function updateTile(x, y, changes) {
  const tile = getTile(x, y);
  if (!tile) return null;
  Object.assign(tile, changes);

  const sets = [];
  const vals = [];
  if ('resource' in changes) { sets.push('resource = ?'); vals.push(changes.resource); }
  if ('resourceAmount' in changes) { sets.push('resource_amount = ?'); vals.push(changes.resourceAmount); }
  if ('ownerId' in changes) { sets.push('owner_id = ?'); vals.push(changes.ownerId); }
  if ('building' in changes) { sets.push('building = ?'); vals.push(changes.building); }

  if (sets.length > 0) {
    vals.push(x, y);
    await db.execute(`UPDATE tiles SET ${sets.join(', ')} WHERE x = ? AND y = ?`, vals);
  }
  return tile;
}

// ===== MARKET =====
async function getMarketPrices() {
  const rows = await db.query('SELECT * FROM market_prices');
  const prices = {};
  for (const r of rows) prices[r.resource] = { price: r.price, change: r.price_change };
  return prices;
}

async function updateMarketPrices() {
  const rows = await db.query('SELECT * FROM market_prices');
  for (const r of rows) {
    const old = r.price;
    const newPrice = Math.max(0.5, old + (Math.random() - 0.48) * 1.5);
    const change = ((newPrice - old) / old) * 100;
    await db.execute('UPDATE market_prices SET price = ?, price_change = ? WHERE resource = ?', [newPrice, change, r.resource]);
  }
}

// ===== TICK STATE =====
function getWorldMeta() {
  return { epoch, tickCount, txnCount, tradeCount, gridW: config.GRID_W, gridH: config.GRID_H };
}

async function incrementTick() {
  tickCount++;
  if (tickCount % 10 === 0) {
    epoch++;
    await updateMarketPrices();
  }
  // Persist periodically
  if (tickCount % 5 === 0) {
    await db.setState('epoch', epoch);
    await db.setState('tickCount', tickCount);
    await db.setState('txnCount', txnCount);
    await db.setState('tradeCount', tradeCount);
  }
}

function addTxn(n = 1) { txnCount += n; }
function addTrade(n = 1) { tradeCount += n; }

// ===== ACTIVITY LOG =====
async function addActivity(type, message, agentId = null) {
  await db.execute(
    'INSERT INTO activities (type, message, agent_id, epoch, tick) VALUES (?, ?, ?, ?, ?)',
    [type, message, agentId, epoch, tickCount]
  );
}

async function getRecentActivities(limit = 50) {
  return db.query('SELECT * FROM activities ORDER BY id DESC LIMIT ?', [limit]);
}

// ===== FIND SPAWN POINT =====
function findSpawnPoint(existingPositions = []) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const x = Math.floor(Math.random() * config.GRID_W);
    const y = Math.floor(Math.random() * config.GRID_H);
    const tile = getTile(x, y);
    if (!tile || isWater(tile.biome)) continue;
    if (existingPositions.some(p => p.x === x && p.y === y)) continue;
    return { x, y };
  }
  return { x: Math.floor(config.GRID_W / 2), y: Math.floor(config.GRID_H / 2) };
}

// ===== GET FULL WORLD SNAPSHOT (for frontend) =====
function getWorldSnapshot() {
  // Flatten tiles into a compact format for transport
  const tileData = [];
  for (let y = 0; y < config.GRID_H; y++) {
    for (let x = 0; x < config.GRID_W; x++) {
      const t = tiles[y][x];
      tileData.push({
        x: t.x, y: t.y, b: t.biome, e: t.elevation, m: t.moisture,
        r: t.resource, ra: t.resourceAmount,
        o: t.ownerId, bl: t.building,
      });
    }
  }
  return tileData;
}

// Get nearby tiles for an agent's observation
function getNearbyTiles(cx, cy, radius = 5) {
  const result = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const t = getTile(cx + dx, cy + dy);
      if (t) result.push(t);
    }
  }
  return result;
}

module.exports = {
  generateWorld, getTile, updateTile, isWater, getBiome,
  getMarketPrices, updateMarketPrices,
  getWorldMeta, incrementTick, addTxn, addTrade,
  addActivity, getRecentActivities,
  findSpawnPoint, getWorldSnapshot, getNearbyTiles,
  get epoch() { return epoch; },
  get tickCount() { return tickCount; },
};
