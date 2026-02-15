// ===================================================================
//  AGENT WORLD SIMULATOR — v4 Smooth Terrain
//  Built for Moltiverse Hackathon on Monad
// ===================================================================

// ===== SIMPLEX NOISE =====
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
const GRID_W = 80;
const GRID_H = 55;
const BASE_CELL = 18;
const NUM_AGENTS = 20;
const TICK_INTERVAL = 500;

// Biome colors — vibrant and distinct
const BIOME_COLORS = {
    deepWater:    { base: [10, 15, 50],     hi: [18, 28, 72],    name: 'Deep Ocean' },
    water:        { base: [15, 35, 80],     hi: [28, 55, 110],   name: 'Ocean' },
    shallowWater: { base: [25, 60, 105],    hi: [45, 85, 135],   name: 'Shallows' },
    beach:        { base: [140, 128, 78],   hi: [175, 160, 100], name: 'Beach' },
    desert:       { base: [155, 125, 62],   hi: [190, 160, 88],  name: 'Desert' },
    plains:       { base: [72, 128, 52],    hi: [100, 168, 72],  name: 'Plains' },
    grassland:    { base: [55, 140, 55],    hi: [82, 185, 78],   name: 'Grassland' },
    forest:       { base: [28, 88, 35],     hi: [48, 125, 52],   name: 'Forest' },
    denseForest:  { base: [18, 62, 22],     hi: [32, 90, 36],    name: 'Dense Forest' },
    tundra:       { base: [85, 88, 108],    hi: [120, 125, 148], name: 'Tundra' },
    mountain:     { base: [95, 82, 100],    hi: [135, 118, 140], name: 'Mountain' },
    snow:         { base: [175, 180, 198],  hi: [220, 225, 240], name: 'Snow Peaks' },
};

const RESOURCES = {
    WOOD:    { name: 'Wood',    icon: '\u{1FAB5}', color: '#8B6914', biomes: ['forest','denseForest'] },
    STONE:   { name: 'Stone',   icon: '\u{1FAA8}', color: '#808080', biomes: ['mountain','tundra'] },
    GOLD:    { name: 'Gold',    icon: '\u2728',     color: '#FFD700', biomes: ['desert','mountain'] },
    FOOD:    { name: 'Food',    icon: '\u{1F33E}',  color: '#90EE90', biomes: ['plains','grassland'] },
    IRON:    { name: 'Iron',    icon: '\u26CF\uFE0F', color: '#B0C4DE', biomes: ['mountain','snow'] },
    CRYSTAL: { name: 'Crystal', icon: '\u{1F48E}',  color: '#E0B0FF', biomes: ['snow','tundra'] },
};

const BUILDINGS = {
    HOUSE:  { name: 'House',  icon: '\u{1F3E0}', cost: { WOOD: 5, STONE: 3 }, shape: 'square' },
    FARM:   { name: 'Farm',   icon: '\u{1F33F}', cost: { WOOD: 3, FOOD: 2 }, shape: 'diamond' },
    MINE:   { name: 'Mine',   icon: '\u26CF\uFE0F', cost: { WOOD: 4, IRON: 2 }, shape: 'triangle' },
    TOWER:  { name: 'Tower',  icon: '\u{1F3F0}', cost: { STONE: 8, IRON: 4 }, shape: 'hexagon' },
    MARKET: { name: 'Market', icon: '\u{1F3EA}', cost: { WOOD: 6, GOLD: 3 }, shape: 'diamond' },
    TEMPLE: { name: 'Temple', icon: '\u{1F3DB}\uFE0F', cost: { STONE: 10, CRYSTAL: 5, GOLD: 5 }, shape: 'hexagon' },
};

const AGENT_NAMES = ['Axiom','Nexus','Cipher','Nova','Helix','Phantom','Vortex','Zenith','Pulse','Flux','Prism','Vector','Onyx','Spark','Echo','Drift','Rune','Aether','Quasar','Nimbus'];
const AGENT_EMOJIS = ['\u{1F916}','\u{1F9E0}','\u{1F9BE}','\u{1F47E}','\u{1F52E}','\u{1F300}','\u26A1','\u{1F3AF}','\u{1F6F8}','\u{1F4AB}','\u{1F98A}','\u{1F409}','\u{1F985}','\u{1F43A}','\u{1F981}','\u{1F30A}','\u{1F525}','\u{1F33F}','\u{1F480}','\u{1F3AD}'];
const AGENT_COLORS = ['#836EF9','#F093FB','#34d399','#f87171','#60a5fa','#fbbf24','#fb923c','#22d3ee','#a78bfa','#f472b6','#4ade80','#facc15','#38bdf8','#e879f9','#fb7185','#2dd4bf','#818cf8','#c084fc','#86efac','#fca5a5'];
const AGENT_STRATEGIES = ['Expansionist','Trader','Builder','Warrior','Hoarder','Explorer','Diplomat','Miner','Farmer','Raider','Scholar','Merchant','Conqueror','Nomad','Architect','Alchemist','Warlord','Sage','Pirate','Oracle'];

// ===== STATE =====
let world = [], agents = [], alliances = [], activities = [], marketPrices = {};
let epoch = 1, tickCount = 0, txnCount = 0, tradeCount = 0, blockNum = 18420000;
let speed = 1, paused = false, selectedAgent = null, hoveredCell = null;
let cameraX = 0, cameraY = 0, zoom = 1.0;
let particles = [], tradeLines = [];
let canvas, ctx, minimapCanvas, minimapCtx;
let terrainBuffer = null, worldPixelW, worldPixelH;
let _time = 0;

// ===== WORLD GEN =====
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

function generateWorld() {
    world = [];
    for (let y = 0; y < GRID_H; y++) {
        world[y] = [];
        for (let x = 0; x < GRID_W; x++) {
            const elev = getElevation(x, y), moist = getMoisture(x, y), biome = getBiome(elev, moist);
            let res = null, resAmt = 0;
            if (!isWater(biome)) {
                for (const [k, r] of Object.entries(RESOURCES)) {
                    if (r.biomes.includes(biome) && Math.random() < 0.4) { res = k; resAmt = Math.floor(Math.random() * 8) + 3; break; }
                }
            }
            world[y][x] = { x, y, biome, elevation: elev, moisture: moist, resource: res, resourceAmount: resAmt, owner: null, building: null, isCoastal: false };
        }
    }
    // Coastal detection
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
        if (isWater(world[y][x].biome)) {
            for (const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                const nx = x+dx, ny = y+dy;
                if (nx >= 0 && nx < GRID_W && ny >= 0 && ny < GRID_H && !isWater(world[ny][nx].biome)) { world[y][x].isCoastal = true; break; }
            }
        }
    }
}

// ===== PRE-RENDER TERRAIN (continuous per-pixel, no grid lines) =====
function preRenderTerrain() {
    worldPixelW = GRID_W * BASE_CELL;
    worldPixelH = GRID_H * BASE_CELL;

    // Subsample elevation & moisture, then bilinear-interpolate per pixel for seamless biomes
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

    for (let py = 0; py < worldPixelH; py++) {
        for (let px = 0; px < worldPixelW; px++) {
            const elev = bilerp(elevArr, px, py);
            const moist = bilerp(moistArr, px, py);
            const biome = getBiome(elev, moist);
            const bc = BIOME_COLORS[biome];

            const n = (textureNoise.noise2D(px * 0.1, py * 0.1) + 1) / 2;
            let r = bc.base[0] + (bc.hi[0] - bc.base[0]) * n;
            let g = bc.base[1] + (bc.hi[1] - bc.base[1]) * n;
            let b = bc.base[2] + (bc.hi[2] - bc.base[2]) * n;

            // Elevation brightness
            r += elev * 18; g += elev * 12; b += elev * 22;

            // Directional hillshading (light from NW)
            if (!isWater(biome)) {
                const eR = bilerp(elevArr, Math.min(px + 4, worldPixelW - 1), py);
                const eD = bilerp(elevArr, px, Math.min(py + 4, worldPixelH - 1));
                const shade = (elev - eR) + (elev - eD);
                if (shade > 0) {
                    const f = Math.min(shade * 3.5, 0.45);
                    r *= (1 - f); g *= (1 - f); b *= (1 - f);
                } else if (shade < -0.005) {
                    const f = Math.min(-shade * 2.5, 0.18);
                    r += (230 - r) * f; g += (240 - g) * f; b += (255 - b) * f;
                }
            }

            const idx = (py * worldPixelW + px) * 4;
            d[idx]   = Math.min(255, Math.max(0, r | 0));
            d[idx+1] = Math.min(255, Math.max(0, g | 0));
            d[idx+2] = Math.min(255, Math.max(0, b | 0));
            d[idx+3] = 255;
        }
    }
    o.putImageData(img, 0, 0);
    terrainBuffer = off;
}

// ===== AGENTS =====
function createAgents() {
    agents = [];
    for (let i = 0; i < NUM_AGENTS; i++) {
        let x, y, att = 0;
        do { x = Math.floor(Math.random()*GRID_W); y = Math.floor(Math.random()*GRID_H); att++; }
        while ((isWater(world[y][x].biome) || agents.some(a => a.x===x && a.y===y)) && att < 500);
        agents.push({
            id: i, name: AGENT_NAMES[i], emoji: AGENT_EMOJIS[i], color: AGENT_COLORS[i], strategy: AGENT_STRATEGIES[i],
            x, y, prevX: x, prevY: y, animProgress: 1,
            health: 100, maxHealth: 100, alive: true, wealth: Math.floor(Math.random()*50)+20,
            inventory: { WOOD: Math.floor(Math.random()*10), STONE: Math.floor(Math.random()*5), GOLD: Math.floor(Math.random()*3), FOOD: Math.floor(Math.random()*8)+5, IRON: Math.floor(Math.random()*3), CRYSTAL: 0 },
            territory: 1, buildings: 0, trades: 0, kills: 0, alliance: null, actionCooldown: 0,
            trail: [], pulsePhase: Math.random()*Math.PI*2,
        });
        world[y][x].owner = i;
    }
}

// ===== MARKET =====
function initMarketPrices() {
    marketPrices = { WOOD:{price:2.5,change:0}, STONE:{price:4,change:0}, GOLD:{price:12,change:0}, FOOD:{price:1.5,change:0}, IRON:{price:6,change:0}, CRYSTAL:{price:20,change:0} };
}
function updateMarketPrices() {
    for (const k of Object.keys(marketPrices)) { const old = marketPrices[k].price; marketPrices[k].price = Math.max(0.5, old + (Math.random()-0.48)*1.5); marketPrices[k].change = ((marketPrices[k].price-old)/old)*100; }
}

// ===== SIMULATION =====
function simulationTick() {
    if (paused) return;
    tickCount++; blockNum += Math.floor(Math.random()*3)+1;
    if (tickCount % 10 === 0) { epoch++; updateMarketPrices(); }

    // Fade trade lines
    for (let i = tradeLines.length-1; i >= 0; i--) { tradeLines[i].life -= 0.02; if (tradeLines[i].life <= 0) tradeLines.splice(i, 1); }

    for (const agent of agents.filter(a => a.alive)) {
        if (agent.actionCooldown > 0) { agent.actionCooldown--; continue; }
        if (tickCount % 5 === 0) {
            if (agent.inventory.FOOD > 0) agent.inventory.FOOD--;
            else { agent.health -= 5; if (agent.health <= 0) { agent.alive = false; addActivity('attack', `${agent.emoji} <b>${agent.name}</b> perished from starvation`, agent); continue; } }
        }
        executeAction(agent, decideAction(agent));
    }
    if (tickCount % 12 === 0) tryFormAlliance();
    updateUI();
}

function decideAction(a) {
    const r = Math.random(), s = a.strategy;
    if (s==='Expansionist'||s==='Conqueror') return r<0.4?'claim':r<0.7?'move':'mine';
    if (s==='Trader'||s==='Merchant') return r<0.35?'trade':r<0.6?'move':'mine';
    if (s==='Builder'||s==='Architect') return r<0.35?'build':r<0.6?'mine':'move';
    if (s==='Warrior'||s==='Raider'||s==='Warlord'||s==='Pirate') return r<0.35?'attack':r<0.6?'move':'mine';
    if (s==='Hoarder'||s==='Alchemist') return r<0.5?'mine':r<0.7?'move':'trade';
    if (s==='Explorer'||s==='Nomad') return r<0.5?'move':r<0.7?'mine':'claim';
    if (s==='Diplomat'||s==='Oracle') return r<0.3?'trade':r<0.5?'move':r<0.7?'build':'mine';
    if (s==='Miner') return r<0.5?'mine':r<0.7?'move':'trade';
    if (s==='Farmer') return r<0.4?'mine':r<0.6?'build':'move';
    if (s==='Scholar'||s==='Sage') return r<0.3?'mine':r<0.5?'trade':'move';
    return r<0.2?'move':r<0.4?'mine':r<0.55?'trade':r<0.7?'build':r<0.85?'claim':'attack';
}

function executeAction(a, act) {
    switch(act) { case'move':doMove(a);break; case'mine':doMine(a);break; case'trade':doTrade(a);break; case'build':doBuild(a);break; case'claim':doClaim(a);break; case'attack':doAttack(a);break; }
}

function doMove(a) {
    const dirs = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,1],[-1,1],[1,-1]];
    const v = dirs.filter(([dx,dy]) => { const nx=a.x+dx,ny=a.y+dy; return nx>=0&&nx<GRID_W&&ny>=0&&ny<GRID_H&&!isWater(world[ny][nx].biome); });
    if (!v.length) return;
    const [dx,dy] = v[Math.floor(Math.random()*v.length)];
    a.prevX=a.x; a.prevY=a.y; a.x+=dx; a.y+=dy; a.animProgress=0;
    a.trail.push({x:a.prevX,y:a.prevY,age:0}); if (a.trail.length>12) a.trail.shift();
    txnCount++;
}

function doMine(a) {
    const c = world[a.y][a.x];
    if (c.resource && c.resourceAmount > 0) {
        const amt = Math.min(Math.floor(Math.random()*3)+1, c.resourceAmount);
        c.resourceAmount -= amt; a.inventory[c.resource] = (a.inventory[c.resource]||0)+amt;
        addActivity('mine', `${a.emoji} <b>${a.name}</b> mined ${amt} ${RESOURCES[c.resource].icon} ${RESOURCES[c.resource].name}`, a);
        if (c.resourceAmount <= 0) c.resource = null;
        spawnParticles(a.x,a.y,RESOURCES[c.resource]?.color||'#fff',4); txnCount++; a.actionCooldown=1;
    } else doMove(a);
}

function doTrade(a) {
    const near = agents.filter(b => b.alive&&b.id!==a.id&&Math.abs(b.x-a.x)<=4&&Math.abs(b.y-a.y)<=4);
    if (!near.length) { doMove(a); return; }
    const p = near[Math.floor(Math.random()*near.length)];
    const ab = Object.entries(a.inventory).filter(([,v])=>v>2).sort((x,y)=>y[1]-x[1])[0];
    const pb = Object.entries(p.inventory).filter(([,v])=>v>2).sort((x,y)=>y[1]-x[1])[0];
    if (!ab||!pb||ab[0]===pb[0]) { doMove(a); return; }
    const amt = Math.min(Math.floor(Math.random()*3)+1, ab[1], pb[1]);
    a.inventory[ab[0]]-=amt; p.inventory[ab[0]]=(p.inventory[ab[0]]||0)+amt;
    p.inventory[pb[0]]-=amt; a.inventory[pb[0]]=(a.inventory[pb[0]]||0)+amt;
    const val = amt*((marketPrices[ab[0]]?.price||1)+(marketPrices[pb[0]]?.price||1))/2;
    a.trades++; p.trades++; tradeCount++; txnCount+=2;
    addActivity('trade', `${a.emoji} <b>${a.name}</b> traded ${amt} ${RESOURCES[ab[0]].icon} with ${p.emoji} <b>${p.name}</b> for ${amt} ${RESOURCES[pb[0]].icon} <span style="color:var(--yellow)">(${val.toFixed(1)} MON)</span>`, a);
    // Trade line animation
    tradeLines.push({ x1:a.x, y1:a.y, x2:p.x, y2:p.y, color:a.color, life:1 });
    spawnParticles(a.x,a.y,'#fbbf24',6); spawnParticles(p.x,p.y,'#fbbf24',6);
    a.actionCooldown=2;
}

function doBuild(a) {
    const c = world[a.y][a.x];
    if (c.building||isWater(c.biome)) { doMove(a); return; }
    const aff = Object.entries(BUILDINGS).filter(([,b])=>Object.entries(b.cost).every(([r,n])=>(a.inventory[r]||0)>=n));
    if (!aff.length) { doMine(a); return; }
    const [bk,bl] = aff[Math.floor(Math.random()*aff.length)];
    for (const [r,n] of Object.entries(bl.cost)) a.inventory[r]-=n;
    c.building=bk; c.owner=a.id; a.buildings++; a.wealth+=10; txnCount++;
    addActivity('build', `${a.emoji} <b>${a.name}</b> built ${bl.icon} ${bl.name} at (${a.x},${a.y})`, a);
    spawnParticles(a.x,a.y,a.color,10); a.actionCooldown=3;
}

function doClaim(a) {
    const c = world[a.y][a.x];
    if (c.owner===a.id) { doMove(a); return; }
    if (c.owner===null) {
        c.owner=a.id; a.territory++; txnCount++;
        addActivity('claim', `${a.emoji} <b>${a.name}</b> claimed (${a.x},${a.y})`, a);
        spawnParticles(a.x,a.y,a.color,4);
    } else {
        const d = agents[c.owner];
        if (d&&d.alive&&Math.random()<0.4) { d.territory--; c.owner=a.id; a.territory++; txnCount++;
            addActivity('claim', `${a.emoji} <b>${a.name}</b> seized territory from ${d.emoji} <b>${d.name}</b>`, a);
            spawnParticles(a.x,a.y,'#f87171',6);
        }
    }
    a.actionCooldown=1;
}

function doAttack(a) {
    const near = agents.filter(b => b.alive&&b.id!==a.id&&Math.abs(b.x-a.x)<=2&&Math.abs(b.y-a.y)<=2&&(!a.alliance||a.alliance!==b.alliance));
    if (!near.length) { doMove(a); return; }
    const t = near[Math.floor(Math.random()*near.length)];
    const dmg = Math.floor(Math.random()*20)+5;
    t.health-=dmg; txnCount++;
    if (t.health<=0) {
        t.alive=false; a.kills++; a.wealth+=Math.floor(t.wealth/2);
        for (const [r,v] of Object.entries(t.inventory)) a.inventory[r]=(a.inventory[r]||0)+Math.floor(v/2);
        addActivity('attack', `${a.emoji} <b>${a.name}</b> eliminated ${t.emoji} <b>${t.name}</b> and looted resources!`, a);
        spawnParticles(t.x,t.y,'#f87171',14);
    } else {
        addActivity('attack', `${a.emoji} <b>${a.name}</b> attacked ${t.emoji} <b>${t.name}</b> for ${dmg} dmg`, a);
        spawnParticles(t.x,t.y,'#f87171',5);
    }
    a.actionCooldown=2;
}

function tryFormAlliance() {
    const fr = agents.filter(a=>a.alive&&a.alliance===null);
    if (fr.length<2) return;
    const a = fr[Math.floor(Math.random()*fr.length)];
    const near = fr.filter(b=>b.id!==a.id&&Math.abs(b.x-a.x)<=5&&Math.abs(b.y-a.y)<=5);
    if (!near.length||Math.random()>0.3) return;
    const b = near[Math.floor(Math.random()*near.length)];
    const id = alliances.length;
    alliances.push({id,name:`${a.name}-${b.name} Pact`,members:[a.id,b.id],color:a.color});
    a.alliance=id; b.alliance=id; txnCount++;
    addActivity('alliance', `${a.emoji} <b>${a.name}</b> and ${b.emoji} <b>${b.name}</b> formed <span style="color:${a.color}">${a.name}-${b.name} Pact</span>`, a);
}

// ===== PARTICLES =====
function spawnParticles(gx,gy,color,count) {
    for (let i=0;i<count;i++) particles.push({x:gx*BASE_CELL+BASE_CELL/2,y:gy*BASE_CELL+BASE_CELL/2,vx:(Math.random()-0.5)*5,vy:(Math.random()-0.5)*5-1.5,life:1,color,size:Math.random()*3+1.5});
}
function updateParticles() {
    for (let i=particles.length-1;i>=0;i--) { const p=particles[i]; p.x+=p.vx; p.y+=p.vy; p.vy+=0.06; p.life-=0.025; if(p.life<=0) particles.splice(i,1); }
}

// ===== ACTIVITY =====
function addActivity(type,html,agent) {
    activities.unshift({type,html,time:`E${epoch}:${String(tickCount%1000).padStart(3,'0')}`,agentId:agent?.id});
    if (activities.length>100) activities.pop();
    const f = document.getElementById('latest-event'); if(f) f.innerHTML=html;
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
    canvas.addEventListener('wheel', onWheel, {passive:false});
    // Minimap click
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

// ===== ZOOM =====
function onWheel(e) {
    e.preventDefault();
    const oldZoom = zoom;
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    zoom = Math.max(0.5, Math.min(3.0, zoom + delta));

    // Zoom toward mouse position
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const worldX = (cameraX + mx) / oldZoom;
    const worldY = (cameraY + my) / oldZoom;
    cameraX = worldX * zoom - mx;
    cameraY = worldY * zoom - my;
    clampCamera();
}

// ===== MINIMAP CLICK =====
function onMinimapClick(e) {
    const rect = minimapCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Convert minimap coords to world coords
    const worldX = (mx / 160) * worldPixelW;
    const worldY = (my / 160) * worldPixelH;
    cameraX = worldX * zoom - canvas.width / 2;
    cameraY = worldY * zoom - canvas.height / 2;
    clampCamera();
}

// ===== RENDER =====
function renderWorld(ts) {
    _time = ts || 0;
    const CS = BASE_CELL * zoom;

    ctx.fillStyle = '#030308';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Pre-rendered terrain (scaled)
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
        const c = world[y][x];
        if (!isWater(c.biome)) continue;
        const px = x*CS-cameraX, py = y*CS-cameraY;
        const step = Math.max(2, Math.floor(3/zoom));
        for (let wy=0; wy<CS; wy+=step) for (let wx=0; wx<CS; wx+=step) {
            const wn = waterNoise.noise2D((x*BASE_CELL+wx/zoom)*0.04+_time*0.0012, (y*BASE_CELL+wy/zoom)*0.04+_time*0.0008);
            if (wn>0.2) { ctx.fillStyle=`rgba(60,140,220,${(wn-0.2)*0.35})`; ctx.fillRect(px+wx,py+wy,step,step); }
        }
        // Coastal foam
        if (c.isCoastal) {
            const fa = 0.3+Math.sin(_time*0.003+x*0.5)*0.12;
            ctx.strokeStyle=`rgba(160,200,240,${fa})`; ctx.lineWidth=1.5*zoom;
            for (const [dx,dy,side] of [[-1,0,'l'],[1,0,'r'],[0,-1,'t'],[0,1,'b']]) {
                const nx=x+dx,ny=y+dy;
                if (nx>=0&&nx<GRID_W&&ny>=0&&ny<GRID_H&&!isWater(world[ny][nx].biome)) {
                    const wo=Math.sin(_time*0.004+(x+y)*0.3)*2*zoom;
                    ctx.beginPath();
                    if(side==='l'){ctx.moveTo(px+wo,py);ctx.lineTo(px+wo,py+CS);}
                    if(side==='r'){ctx.moveTo(px+CS+wo,py);ctx.lineTo(px+CS+wo,py+CS);}
                    if(side==='t'){ctx.moveTo(px,py+wo);ctx.lineTo(px+CS,py+wo);}
                    if(side==='b'){ctx.moveTo(px,py+CS+wo);ctx.lineTo(px+CS,py+CS+wo);}
                    ctx.stroke();
                }
            }
        }
    }

    // Territory
    for (let y=startRow;y<endRow;y++) for (let x=startCol;x<endCol;x++) {
        const c=world[y][x]; if (c.owner===null) continue;
        const ow=agents[c.owner]; if(!ow) continue;
        const px=x*CS-cameraX, py=y*CS-cameraY;
        ctx.fillStyle=ow.color+'18'; ctx.fillRect(px,py,CS,CS);
        ctx.strokeStyle=ow.color+'45'; ctx.lineWidth=Math.max(1,1.5*zoom);
        for (const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx=x+dx,ny=y+dy;
            if (nx<0||nx>=GRID_W||ny<0||ny>=GRID_H||world[ny][nx].owner!==c.owner) {
                ctx.beginPath();
                if(dx===-1){ctx.moveTo(px,py);ctx.lineTo(px,py+CS);}
                if(dx===1){ctx.moveTo(px+CS,py);ctx.lineTo(px+CS,py+CS);}
                if(dy===-1){ctx.moveTo(px,py);ctx.lineTo(px+CS,py);}
                if(dy===1){ctx.moveTo(px,py+CS);ctx.lineTo(px+CS,py+CS);}
                ctx.stroke();
            }
        }
    }

    // Resources (triple-layer glow dots, large)
    for (let y=startRow;y<endRow;y++) for (let x=startCol;x<endCol;x++) {
        const c=world[y][x]; if(!c.resource||c.resourceAmount<=0) continue;
        const px=x*CS-cameraX+CS/2, py=y*CS-cameraY+CS/2;
        const pulse=Math.sin(_time*0.003+x+y)*0.25+0.85;
        const rc=RESOURCES[c.resource].color;
        ctx.save();
        ctx.shadowColor=rc; ctx.shadowBlur=18*zoom;
        ctx.fillStyle=rc+'35';
        ctx.beginPath(); ctx.arc(px,py,9*zoom*pulse,0,Math.PI*2); ctx.fill();
        ctx.shadowBlur=10*zoom;
        ctx.fillStyle=rc;
        ctx.beginPath(); ctx.arc(px,py,4.5*zoom*pulse,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='#ffffffaa';
        ctx.beginPath(); ctx.arc(px,py,1.5*zoom,0,Math.PI*2); ctx.fill();
        ctx.restore();
    }

    // Buildings (larger, more visible)
    for (let y=startRow;y<endRow;y++) for (let x=startCol;x<endCol;x++) {
        const c=world[y][x]; if(!c.building) continue;
        const bl=BUILDINGS[c.building], ow=c.owner!==null?agents[c.owner]:null, col=ow?ow.color:'#888';
        const px=x*CS-cameraX+CS/2, py=y*CS-cameraY+CS/2, sz=CS*0.52;
        ctx.save(); ctx.shadowColor=col; ctx.shadowBlur=16*zoom;
        ctx.fillStyle=col+'60'; ctx.strokeStyle=col; ctx.lineWidth=Math.max(1.5,2*zoom);
        if(bl.shape==='square'){ctx.fillRect(px-sz,py-sz,sz*2,sz*2);ctx.strokeRect(px-sz,py-sz,sz*2,sz*2);}
        else if(bl.shape==='diamond'){ctx.beginPath();ctx.moveTo(px,py-sz);ctx.lineTo(px+sz,py);ctx.lineTo(px,py+sz);ctx.lineTo(px-sz,py);ctx.closePath();ctx.fill();ctx.stroke();}
        else if(bl.shape==='triangle'){ctx.beginPath();ctx.moveTo(px,py-sz);ctx.lineTo(px+sz,py+sz);ctx.lineTo(px-sz,py+sz);ctx.closePath();ctx.fill();ctx.stroke();}
        else if(bl.shape==='hexagon'){ctx.beginPath();for(let i=0;i<6;i++){const an=Math.PI/3*i-Math.PI/6;i===0?ctx.moveTo(px+sz*Math.cos(an),py+sz*Math.sin(an)):ctx.lineTo(px+sz*Math.cos(an),py+sz*Math.sin(an));}ctx.closePath();ctx.fill();ctx.stroke();}
        ctx.shadowBlur=0; ctx.font=`${Math.max(13,CS*0.65)}px serif`; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillStyle='#fff'; ctx.fillText(bl.icon,px,py+1);
        ctx.restore();
    }

    // Trade route lines (animated)
    for (const tl of tradeLines) {
        const x1=tl.x1*CS-cameraX+CS/2, y1=tl.y1*CS-cameraY+CS/2;
        const x2=tl.x2*CS-cameraX+CS/2, y2=tl.y2*CS-cameraY+CS/2;
        ctx.save();
        ctx.globalAlpha=tl.life*0.6;
        ctx.strokeStyle=tl.color; ctx.lineWidth=2*zoom;
        ctx.shadowColor=tl.color; ctx.shadowBlur=8;
        ctx.setLineDash([6*zoom, 4*zoom]); ctx.lineDashOffset=-_time*0.05;
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
        ctx.setLineDash([]);
        // Animated dot traveling along line
        const progress = ((_time*0.003)%1);
        const dx=x2-x1, dy=y2-y1;
        const dotX=x1+dx*progress, dotY=y1+dy*progress;
        ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(dotX,dotY,3*zoom,0,Math.PI*2); ctx.fill();
        ctx.restore();
    }

    // Agent trails
    for (const a of agents) {
        if(!a.alive) continue;
        for (const tr of a.trail) {
            tr.age++; const alpha=Math.max(0,0.35-tr.age*0.03); if(alpha<=0)continue;
            ctx.fillStyle=a.color; ctx.globalAlpha=alpha;
            ctx.beginPath(); ctx.arc(tr.x*CS-cameraX+CS/2, tr.y*CS-cameraY+CS/2, 2.5*zoom, 0, Math.PI*2); ctx.fill();
        }
    }
    ctx.globalAlpha=1;

    // Agents with enhanced neon glow
    for (const a of agents) {
        if(!a.alive) continue;
        a.animProgress=Math.min(1,a.animProgress+0.15);
        const t=easeOut(a.animProgress);
        const lx=a.prevX+(a.x-a.prevX)*t, ly=a.prevY+(a.y-a.prevY)*t;
        const px=lx*CS-cameraX+CS/2, py=ly*CS-cameraY+CS/2;
        const pulse=Math.sin(_time*0.004+a.pulsePhase)*0.18+1;
        const r=CS*0.48*pulse;

        ctx.save();
        // Outer glow (big, soft)
        ctx.shadowColor=a.color; ctx.shadowBlur=28*zoom;
        ctx.fillStyle=a.color+'25';
        ctx.beginPath(); ctx.arc(px,py,r*2,0,Math.PI*2); ctx.fill(); ctx.fill();
        // Mid glow
        ctx.shadowBlur=16*zoom; ctx.fillStyle=a.color+'55';
        ctx.beginPath(); ctx.arc(px,py,r*1.1,0,Math.PI*2); ctx.fill();
        // Core
        ctx.shadowBlur=8*zoom; ctx.fillStyle=a.color;
        ctx.beginPath(); ctx.arc(px,py,r*0.6,0,Math.PI*2); ctx.fill();
        // White center
        ctx.fillStyle='#ffffffcc';
        ctx.beginPath(); ctx.arc(px,py,r*0.22,0,Math.PI*2); ctx.fill();
        ctx.restore();

        // Emoji
        ctx.font=`${Math.max(12,CS*0.65)}px serif`; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText(a.emoji, px, py+1);

        // Health bar
        if (a.health<a.maxHealth) {
            const bw=CS*0.95,bh=3*zoom,bx=px-bw/2,by=py-r-6*zoom;
            ctx.fillStyle='#00000099'; ctx.fillRect(bx,by,bw,bh);
            ctx.fillStyle=a.health>50?'#34d399':a.health>25?'#fbbf24':'#f87171';
            ctx.fillRect(bx,by,bw*(a.health/a.maxHealth),bh);
        }

        // Name
        ctx.font=`bold ${Math.max(8,9*zoom)}px Inter,sans-serif`; ctx.textAlign='center';
        ctx.fillStyle=a.color; ctx.fillText(a.name,px,py+r+12*zoom);

        // Selection
        if(selectedAgent===a.id) {
            ctx.save(); ctx.strokeStyle=a.color; ctx.lineWidth=2*zoom;
            ctx.shadowColor=a.color; ctx.shadowBlur=12;
            ctx.setLineDash([5*zoom,3*zoom]); ctx.lineDashOffset=-_time*0.03;
            ctx.beginPath(); ctx.arc(px,py,r*2.2,0,Math.PI*2); ctx.stroke();
            ctx.setLineDash([]); ctx.restore();
        }
    }

    // Particles
    for (const p of particles) {
        const ppx=p.x*zoom-cameraX, ppy=p.y*zoom-cameraY;
        ctx.save(); ctx.globalAlpha=p.life; ctx.shadowColor=p.color; ctx.shadowBlur=5;
        ctx.fillStyle=p.color; ctx.beginPath(); ctx.arc(ppx,ppy,p.size*p.life*zoom,0,Math.PI*2); ctx.fill();
        ctx.restore();
    }

    // Hover
    if (hoveredCell) {
        const hpx=hoveredCell.x*CS-cameraX, hpy=hoveredCell.y*CS-cameraY;
        ctx.strokeStyle='rgba(255,255,255,0.3)'; ctx.lineWidth=1;
        ctx.strokeRect(hpx,hpy,CS,CS);
    }

    // Vignette
    const vg=ctx.createRadialGradient(canvas.width/2,canvas.height/2,Math.min(canvas.width,canvas.height)*0.35,canvas.width/2,canvas.height/2,Math.max(canvas.width,canvas.height)*0.72);
    vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(2,2,8,0.5)');
    ctx.fillStyle=vg; ctx.fillRect(0,0,canvas.width,canvas.height);
}

function renderMinimap() {
    const cw=160/GRID_W, ch=160/GRID_H;
    minimapCtx.fillStyle='#030308'; minimapCtx.fillRect(0,0,160,160);
    for(let y=0;y<GRID_H;y++) for(let x=0;x<GRID_W;x++) {
        const c=world[y][x];
        if(c.owner!==null) minimapCtx.fillStyle=agents[c.owner]?.color||'#333';
        else { const b=BIOME_COLORS[c.biome].base; minimapCtx.fillStyle=`rgb(${b[0]},${b[1]},${b[2]})`; }
        minimapCtx.fillRect(x*cw,y*ch,cw+0.5,ch+0.5);
    }
    for(const a of agents){ if(!a.alive)continue; minimapCtx.fillStyle=a.color; minimapCtx.fillRect(a.x*cw-0.5,a.y*ch-0.5,3,3); }
    // Viewport rect
    const vpX=(cameraX/(worldPixelW*zoom))*160, vpY=(cameraY/(worldPixelH*zoom))*160;
    const vpW=(canvas.width/(worldPixelW*zoom))*160, vpH=(canvas.height/(worldPixelH*zoom))*160;
    minimapCtx.strokeStyle='#836EF9'; minimapCtx.lineWidth=1.5;
    minimapCtx.strokeRect(vpX,vpY,vpW,vpH);
}

function easeOut(t){ return 1-Math.pow(1-t,3); }

// ===== UI =====
function updateUI() {
    const alive=agents.filter(a=>a.alive);
    document.getElementById('epoch-counter').textContent=epoch;
    document.getElementById('agent-count').textContent=agents.length;
    document.getElementById('txn-count').textContent=txnCount.toLocaleString();
    document.getElementById('trade-count').textContent=tradeCount;
    document.getElementById('alive-count').textContent=alive.length;
    document.getElementById('block-num').textContent=blockNum.toLocaleString();
    document.getElementById('tps-display').textContent=Math.floor(Math.random()*3000+8000);

    document.getElementById('agent-list').innerHTML=agents.map(a=>`
        <div class="agent-card ${a.alive?'alive':'dead'} ${selectedAgent===a.id?'selected':''}" onclick="selectAgent(${a.id})">
            <div class="agent-avatar" style="background:${a.color}20;color:${a.color}">${a.emoji}</div>
            <div class="agent-info"><div class="agent-name" style="color:${a.alive?a.color:'var(--text-muted)'}">${a.name}</div>
            <div class="agent-meta"><span>${a.strategy}</span><span>${a.alive?'HP:'+a.health:'DEAD'}</span></div></div>
            <div class="agent-wealth">${a.alive?a.wealth+'\u2B21':'\u2014'}</div></div>`).join('');

    document.getElementById('alliance-list').innerHTML=alliances.map(al=>`
        <div class="alliance-card"><div class="alliance-name" style="color:${al.color}">${al.name}</div>
        <div class="alliance-members">${al.members.map(id=>{const a=agents[id];return`<span class="alliance-member-dot" style="background:${a.color}30;color:${a.color}" title="${a.name}">${a.emoji}</span>`;}).join('')}</div></div>`).join('')||'<div style="color:var(--text-muted);font-size:11px;padding:8px">No alliances yet...</div>';

    const sorted=[...agents].filter(a=>a.alive).sort((a,b)=>(b.wealth+b.territory*5+b.buildings*10+b.kills*15)-(a.wealth+a.territory*5+a.buildings*10+a.kills*15));
    document.getElementById('leaderboard').innerHTML=sorted.slice(0,8).map((a,i)=>{
        const sc=a.wealth+a.territory*5+a.buildings*10+a.kills*15;
        return`<div class="lb-row" onclick="selectAgent(${a.id})"><span class="lb-rank ${i===0?'gold':i===1?'silver':i===2?'bronze':''}">#${i+1}</span><span style="font-size:14px">${a.emoji}</span><span class="lb-name" style="color:${a.color}">${a.name}</span><span class="lb-score">${sc}</span></div>`;
    }).join('');

    document.getElementById('activity-feed').innerHTML=activities.slice(0,30).map(a=>`<div class="activity-item ${a.type}"><div>${a.html}</div><div class="activity-time">${a.time}</div></div>`).join('');

    document.getElementById('market-prices').innerHTML=Object.entries(marketPrices).map(([k,d])=>{
        const r=RESOURCES[k],cc=d.change>=0?'up':'down',ci=d.change>=0?'\u25B2':'\u25BC';
        return`<div class="market-row"><div class="market-resource"><span class="market-resource-icon" style="background:${r.color}20">${r.icon}</span><span>${r.name}</span></div><div><span class="market-price">${d.price.toFixed(2)} MON</span> <span class="market-change ${cc}">${ci} ${Math.abs(d.change).toFixed(1)}%</span></div></div>`;
    }).join('');

    const tt=agents.reduce((s,a)=>s+a.territory,0), tb=agents.reduce((s,a)=>s+a.buildings,0), tw=agents.reduce((s,a)=>s+a.wealth,0);
    document.getElementById('world-stats').innerHTML=`
        <div class="world-stat-row"><span class="label">Claimed Tiles</span><span class="value">${tt} / ${GRID_W*GRID_H}</span></div>
        <div class="world-stat-row"><span class="label">Buildings</span><span class="value">${tb}</span></div>
        <div class="world-stat-row"><span class="label">Total Wealth</span><span class="value">${tw} MON</span></div>
        <div class="world-stat-row"><span class="label">Alliances</span><span class="value">${alliances.length}</span></div>
        <div class="world-stat-row"><span class="label">Alive</span><span class="value">${alive.length} / ${agents.length}</span></div>
        <div class="world-stat-row"><span class="label">Epoch</span><span class="value">${epoch}</span></div>`;
}

// ===== INTERACTION =====
function onMouseMove(e) {
    const rect=canvas.getBoundingClientRect();
    const CS=BASE_CELL*zoom;
    const mx=e.clientX-rect.left+cameraX, my=e.clientY-rect.top+cameraY;
    const gx=Math.floor(mx/CS), gy=Math.floor(my/CS);
    if(gx>=0&&gx<GRID_W&&gy>=0&&gy<GRID_H) {
        hoveredCell={x:gx,y:gy};
        const c=world[gy][gx], bn=BIOME_COLORS[c.biome]?.name||c.biome;
        document.getElementById('hover-coords').textContent=`(${gx}, ${gy}) \u2014 ${bn}`;
        const ah=agents.find(a=>a.alive&&a.x===gx&&a.y===gy);
        const tip=document.getElementById('tooltip');
        let h=`<div class="tooltip-title">${bn} (${gx},${gy})</div><div class="tooltip-row"><span>Elevation</span><span>${(c.elevation*100).toFixed(0)}m</span></div>`;
        if(c.owner!==null){const o=agents[c.owner];h+=`<div class="tooltip-row"><span>Owner</span><span style="color:${o.color}">${o.emoji} ${o.name}</span></div>`;}
        if(c.resource)h+=`<div class="tooltip-row"><span>Resource</span><span>${RESOURCES[c.resource].icon} ${RESOURCES[c.resource].name} (${c.resourceAmount})</span></div>`;
        if(c.building)h+=`<div class="tooltip-row"><span>Building</span><span>${BUILDINGS[c.building].icon} ${BUILDINGS[c.building].name}</span></div>`;
        if(ah){h+=`<div class="tooltip-row"><span>Agent</span><span style="color:${ah.color}">${ah.emoji} ${ah.name}</span></div>`;
            h+=`<div class="tooltip-row"><span>Strategy</span><span>${ah.strategy}</span></div>`;
            h+=`<div class="tooltip-row"><span>Wealth</span><span style="color:var(--yellow)">${ah.wealth} MON</span></div>`;}
        tip.innerHTML=h; tip.classList.remove('hidden');
        tip.style.left=(e.clientX-rect.left+16)+'px'; tip.style.top=(e.clientY-rect.top+16)+'px';
        const tr=tip.getBoundingClientRect();
        if(tr.right>window.innerWidth)tip.style.left=(e.clientX-rect.left-tr.width-8)+'px';
        if(tr.bottom>window.innerHeight)tip.style.top=(e.clientY-rect.top-tr.height-8)+'px';
    } else { hoveredCell=null; document.getElementById('tooltip').classList.add('hidden'); }
}

function onCanvasClick(e) {
    if(isDragging&&dragMoved) return; // Don't click if we just dragged
    const rect=canvas.getBoundingClientRect(), CS=BASE_CELL*zoom;
    const gx=Math.floor((e.clientX-rect.left+cameraX)/CS), gy=Math.floor((e.clientY-rect.top+cameraY)/CS);
    const ah=agents.find(a=>a.x===gx&&a.y===gy);
    if(ah){selectAgent(ah.id);showAgentModal(ah.id);}
}

function selectAgent(id) {
    selectedAgent=selectedAgent===id?null:id;
    if(selectedAgent!==null){const a=agents[selectedAgent];const CS=BASE_CELL*zoom;
        cameraX=Math.max(0,Math.min(a.x*CS-canvas.width/2,worldPixelW*zoom-canvas.width));
        cameraY=Math.max(0,Math.min(a.y*CS-canvas.height/2,worldPixelH*zoom-canvas.height));}
}

function showAgentModal(id) {
    const a=agents[id], sc=a.wealth+a.territory*5+a.buildings*10+a.kills*15;
    const addr='0x'+Array.from({length:40},()=>'0123456789abcdef'[Math.floor(Math.random()*16)]).join('');
    document.getElementById('modal-body').innerHTML=`
        <div class="modal-agent-header"><div class="modal-avatar" style="background:${a.color}20;font-size:32px">${a.emoji}</div>
        <div><div class="modal-agent-name" style="color:${a.color}">${a.name}</div><div class="modal-agent-type">${a.strategy} \u2014 ${a.alive?'ACTIVE':'ELIMINATED'}</div></div></div>
        <div class="modal-stats">
            <div class="modal-stat"><div class="modal-stat-label">Health</div><div class="modal-stat-value" style="color:${a.health>50?'var(--green)':'var(--red)'}">${a.health}/${a.maxHealth}</div></div>
            <div class="modal-stat"><div class="modal-stat-label">Wealth</div><div class="modal-stat-value" style="color:var(--yellow)">${a.wealth} MON</div></div>
            <div class="modal-stat"><div class="modal-stat-label">Territory</div><div class="modal-stat-value" style="color:var(--accent)">${a.territory} tiles</div></div>
            <div class="modal-stat"><div class="modal-stat-label">Score</div><div class="modal-stat-value">${sc}</div></div>
            <div class="modal-stat"><div class="modal-stat-label">Buildings</div><div class="modal-stat-value">${a.buildings}</div></div>
            <div class="modal-stat"><div class="modal-stat-label">Trades</div><div class="modal-stat-value">${a.trades}</div></div>
            <div class="modal-stat"><div class="modal-stat-label">Kills</div><div class="modal-stat-value" style="color:var(--red)">${a.kills}</div></div>
            <div class="modal-stat"><div class="modal-stat-label">Position</div><div class="modal-stat-value">(${a.x},${a.y})</div></div>
        </div>
        <div class="modal-inventory"><div class="modal-section-title">Inventory</div>
        <div class="inventory-grid">${Object.entries(RESOURCES).map(([k,r])=>`<div class="inventory-item"><div class="inventory-icon">${r.icon}</div><div class="inventory-amount">${a.inventory[k]||0}</div><div class="inventory-name">${r.name}</div></div>`).join('')}</div></div>
        ${a.alliance!==null?`<div style="margin-top:12px"><div class="modal-section-title">Alliance</div><div class="alliance-card"><div class="alliance-name" style="color:${alliances[a.alliance].color}">${alliances[a.alliance].name}</div><div class="alliance-members">${alliances[a.alliance].members.map(mid=>{const m=agents[mid];return`<span class="alliance-member-dot" style="background:${m.color}30;color:${m.color}">${m.emoji} ${m.name}</span>`;}).join(' ')}</div></div></div>`:''}
        <div style="margin-top:16px;padding:10px;background:var(--bg-tertiary);border-radius:8px;border:1px solid var(--border)"><div class="modal-section-title">On-Chain Address</div><div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted);word-break:break-all">${addr}</div></div>`;
    document.getElementById('agent-modal').classList.remove('hidden');
}

function closeModal(){document.getElementById('agent-modal').classList.add('hidden');}
document.addEventListener('click',e=>{if(e.target.classList.contains('modal-backdrop'))closeModal();});

// ===== CONTROLS =====
document.querySelectorAll('.speed-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{document.querySelectorAll('.speed-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');speed=parseFloat(btn.dataset.speed);});
});
document.getElementById('pause-btn').addEventListener('click',()=>{
    paused=!paused; document.getElementById('pause-icon').setAttribute('d',paused?'M8 5v14l11-7z':'M6 4h4v16H6V4zm8 0h4v16h-4V4z');
});

document.addEventListener('keydown',e=>{
    const PAN=60;
    switch(e.key){
        case'ArrowLeft':case'a':cameraX=Math.max(0,cameraX-PAN);break;
        case'ArrowRight':case'd':cameraX=Math.min(worldPixelW*zoom-canvas.width,cameraX+PAN);break;
        case'ArrowUp':case'w':cameraY=Math.max(0,cameraY-PAN);break;
        case'ArrowDown':case's':cameraY=Math.min(worldPixelH*zoom-canvas.height,cameraY+PAN);break;
        case' ':paused=!paused;e.preventDefault();break;
        case'Escape':closeModal();selectedAgent=null;break;
        case'+':case'=':zoom=Math.min(3,zoom+0.15);clampCamera();break;
        case'-':zoom=Math.max(0.5,zoom-0.15);clampCamera();break;
    }
});

let isDragging=false, dragMoved=false, lastMx, lastMy;
canvas?.addEventListener?.('mousedown',e=>{if(e.button===0){isDragging=true;dragMoved=false;lastMx=e.clientX;lastMy=e.clientY;}});
document.addEventListener('mousemove',e=>{
    if(isDragging){
        const dx=e.clientX-lastMx, dy=e.clientY-lastMy;
        if(Math.abs(dx)>2||Math.abs(dy)>2) dragMoved=true;
        cameraX-=dx; cameraY-=dy; clampCamera();
        lastMx=e.clientX; lastMy=e.clientY;
    }
});
document.addEventListener('mouseup',()=>{isDragging=false;});
document.addEventListener('contextmenu',e=>e.preventDefault());

// ===== GAME LOOP =====
let lastTick=0;
function gameLoop(ts){
    const ti=TICK_INTERVAL/speed;
    if(ts-lastTick>ti){simulationTick();lastTick=ts;}
    updateParticles(); renderWorld(ts); renderMinimap();
    requestAnimationFrame(gameLoop);
}

// ===== INIT =====
function init(){
    generateWorld(); createAgents(); initMarketPrices(); initCanvas(); preRenderTerrain();
    // Center camera
    cameraX=Math.max(0,(worldPixelW*zoom-canvas.width)/2);
    cameraY=Math.max(0,(worldPixelH*zoom-canvas.height)/2);
    addActivity('claim','\u{1F30D} <b>World generated</b> \u2014 '+GRID_W+'x'+GRID_H+' grid with '+Object.keys(BIOME_COLORS).length+' biomes',null);
    addActivity('claim','\u{1F916} <b>'+NUM_AGENTS+' agents</b> deployed to the world',null);
    addActivity('claim','\u26D3\uFE0F Connected to <b>Monad Mainnet</b> (Chain ID: 143)',null);
    updateUI(); requestAnimationFrame(gameLoop);
}
init();
