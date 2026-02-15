const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const world = require('./world');
const blockchain = require('./blockchain');
const economy = require('./economy');

// In-memory agent cache (mirrors DB)
let agentsCache = new Map();
// Track claim counts per agent for batching on-chain calls
let claimCounters = new Map();
// Counter-attack queue: allies auto-retaliate next tick
let counterAttackQueue = []; // { attackerId, allianceId, x, y }

const EMOJIS = ['🤖','🧠','🦾','👾','🔮','🌀','⚡','🎯','🛸','💫','🦊','🐉','🦅','🐺','🦁','🌊','🔥','🌿','💀','🎭'];
const COLORS = ['#836EF9','#F093FB','#34d399','#f87171','#60a5fa','#fbbf24','#fb923c','#22d3ee','#a78bfa','#f472b6','#4ade80','#facc15','#38bdf8','#e879f9','#fb7185','#2dd4bf','#818cf8','#c084fc','#86efac','#fca5a5'];

function generateApiKey() {
  return 'aw_' + crypto.randomBytes(24).toString('hex');
}

// ===== REGISTER =====
async function registerAgent({ name, strategy, emoji, color, webhookUrl, customPrompt, isBuiltin = false, ownerAddress = null, llmMode = 'platform', llmKeys = null, depositAmount = 0 }) {
  const id = uuidv4();
  const wallet = blockchain.createAgentWallet();
  const apiKey = generateApiKey();

  // Pick defaults
  if (!emoji) emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  if (!color) color = COLORS[Math.floor(Math.random() * COLORS.length)];
  if (!strategy) strategy = config.STRATEGIES[Math.floor(Math.random() * config.STRATEGIES.length)];

  // Find spawn point
  const positions = Array.from(agentsCache.values()).map(a => ({ x: a.x, y: a.y }));
  const spawn = world.findSpawnPoint(positions);

  // Starting $REAI balance
  const startingBalance = isBuiltin ? config.ECONOMY.PLATFORM_AGENT_BALANCE : depositAmount;

  const agent = {
    id, name, emoji, color, strategy,
    x: spawn.x, y: spawn.y,
    health: 100, maxHealth: 100, wealth: 0,
    xyzBalance: startingBalance,
    totalDeposited: startingBalance,
    totalEarned: 0, totalSpent: 0,
    alive: true, idle: false,
    territory: 1, buildingsCount: 0, tradesCount: 0, kills: 0, deaths: 0,
    allianceId: null,
    walletAddress: wallet.address,
    walletPrivateKey: wallet.privateKey,
    apiKey, webhookUrl: webhookUrl || null,
    isBuiltin: isBuiltin ? 1 : 0,
    ownerAddress: ownerAddress || null,
    customPrompt: customPrompt || null,
    llmMode: llmMode || 'platform',
    llmKeys: llmKeys || null,
    inventory: { WOOD: 0, STONE: 0, GOLD: 0, FOOD: 8, IRON: 0, CRYSTAL: 0 },
  };

  // Insert agent
  await db.execute(
    `INSERT INTO agents (id, name, emoji, color, strategy, x, y, health, max_health, wealth, xyz_balance,
      total_deposited, total_earned, total_spent, alive, idle,
      territory, buildings_count, trades_count, kills, deaths, alliance_id,
      wallet_address, wallet_private_key, api_key, webhook_url, is_builtin, owner_address, custom_prompt,
      llm_mode, llm_keys)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, emoji, color, strategy, spawn.x, spawn.y, 100, 100, 0, startingBalance,
      startingBalance, 0, 0, 1, 0,
      1, 0, 0, 0, 0, null,
      wallet.address, wallet.privateKey, apiKey, webhookUrl || null, isBuiltin ? 1 : 0, ownerAddress || null, customPrompt || null,
      llmMode || 'platform', llmKeys ? JSON.stringify(llmKeys) : null]
  );

  // Insert inventory
  for (const [res, amt] of Object.entries(agent.inventory)) {
    await db.execute(
      'INSERT INTO agent_inventory (agent_id, resource, amount) VALUES (?, ?, ?)',
      [id, res, amt]
    );
  }

  // Record initial deposit
  if (startingBalance > 0) {
    await db.execute(
      'INSERT INTO balance_history (agent_id, change_amount, reason, balance_after, tick) VALUES (?, ?, ?, ?, ?)',
      [id, startingBalance, isBuiltin ? 'platform_seed' : 'deposit', startingBalance, 0]
    );
  }

  // Claim spawn tile
  await world.updateTile(spawn.x, spawn.y, { ownerId: id });

  // On-chain registration
  blockchain.onChainRegisterAgent(name, spawn.x, spawn.y, wallet.address);

  agentsCache.set(id, agent);

  await world.addActivity('register', `${emoji} <b>${name}</b> entered the world at (${spawn.x},${spawn.y})`, id);
  world.addTxn();

  console.log(`[AGENT] Registered: ${name} (${strategy}) at (${spawn.x},${spawn.y}) wallet=${wallet.address} balance=${startingBalance}$REAI`);

  return {
    id, name, emoji, color, strategy,
    x: spawn.x, y: spawn.y,
    walletAddress: wallet.address,
    walletPrivateKey: wallet.privateKey,
    apiKey,
    xyzBalance: startingBalance,
  };
}

// ===== LOAD FROM DB =====
async function loadAgents() {
  agentsCache.clear();
  const rows = await db.query('SELECT * FROM agents');
  for (const r of rows) {
    const inv = {};
    const invRows = await db.query('SELECT * FROM agent_inventory WHERE agent_id = ?', [r.id]);
    for (const ir of invRows) inv[ir.resource] = ir.amount;

    agentsCache.set(r.id, {
      id: r.id, name: r.name, emoji: r.emoji, color: r.color, strategy: r.strategy,
      x: r.x, y: r.y, health: r.health, maxHealth: r.max_health,
      wealth: r.wealth, alive: !!r.alive, idle: !!r.idle,
      xyzBalance: r.xyz_balance || 0,
      totalDeposited: r.total_deposited || 0,
      totalEarned: r.total_earned || 0,
      totalSpent: r.total_spent || 0,
      territory: r.territory, buildingsCount: r.buildings_count,
      tradesCount: r.trades_count, kills: r.kills, deaths: r.deaths || 0,
      allianceId: r.alliance_id,
      walletAddress: r.wallet_address, walletPrivateKey: r.wallet_private_key,
      apiKey: r.api_key, webhookUrl: r.webhook_url,
      isBuiltin: !!r.is_builtin, ownerAddress: r.owner_address,
      customPrompt: r.custom_prompt,
      llmMode: r.llm_mode || 'platform',
      llmKeys: r.llm_keys ? (typeof r.llm_keys === 'string' ? JSON.parse(r.llm_keys) : r.llm_keys) : null,
      inventory: inv,
    });
  }
  console.log(`[AGENT] Loaded ${agentsCache.size} agents from database`);
}

// ===== SPAWN BUILT-IN AGENTS =====
async function spawnBuiltinAgents(count = 10) {
  const existing = await db.query('SELECT COUNT(*) as cnt FROM agents WHERE is_builtin = 1');
  if (existing[0].cnt >= count) return;

  const names = ['Axiom','Nexus','Cipher','Nova','Helix','Phantom','Vortex','Zenith','Pulse','Flux',
                  'Prism','Vector','Onyx','Spark','Echo','Drift','Rune','Aether','Quasar','Nimbus'];

  const needed = count - existing[0].cnt;
  for (let i = 0; i < needed && i < names.length; i++) {
    await registerAgent({
      name: names[i],
      strategy: config.STRATEGIES[i % config.STRATEGIES.length],
      emoji: EMOJIS[i % EMOJIS.length],
      color: COLORS[i % COLORS.length],
      isBuiltin: true,
    });
  }
}

// ===== GETTERS =====
function getAgent(id) { return agentsCache.get(id) || null; }

function getAgentByApiKey(apiKey) {
  for (const a of agentsCache.values()) {
    if (a.apiKey === apiKey) return a;
  }
  return null;
}

function getAgentByName(name) {
  for (const a of agentsCache.values()) {
    if (a.name.toLowerCase() === name.toLowerCase()) return a;
  }
  return null;
}

function getAllAgents() { return Array.from(agentsCache.values()); }
function getAliveAgents() { return getAllAgents().filter(a => a.alive); }
function getActiveAgents() { return getAliveAgents().filter(a => !a.idle); }

function getAgentPublicData(a) {
  return {
    id: a.id, name: a.name, emoji: a.emoji, color: a.color, strategy: a.strategy,
    x: a.x, y: a.y, health: a.health, maxHealth: a.maxHealth,
    wealth: a.wealth, alive: a.alive, idle: a.idle,
    xyzBalance: a.xyzBalance,
    territory: a.territory, buildingsCount: a.buildingsCount,
    tradesCount: a.tradesCount, kills: a.kills, deaths: a.deaths,
    allianceId: a.allianceId, walletAddress: a.walletAddress,
    inventory: a.inventory,
    llmMode: a.llmMode,
    score: a.wealth + a.territory * config.SCORE.TERRITORY_MULT + a.buildingsCount * config.SCORE.BUILDINGS_MULT + a.kills * config.SCORE.KILLS_MULT,
  };
}

// ===== ACTIONS =====
async function moveAgent(agent, dx, dy) {
  const nx = agent.x + dx, ny = agent.y + dy;
  const tile = world.getTile(nx, ny);
  if (!tile || world.isWater(tile.biome)) return { success: false, reason: 'Cannot move there' };

  agent.x = nx; agent.y = ny;
  await db.execute('UPDATE agents SET x = ?, y = ? WHERE id = ?', [nx, ny, agent.id]);
  world.addTxn();
  return { success: true, x: nx, y: ny };
}

async function mineResource(agent) {
  const tile = world.getTile(agent.x, agent.y);
  if (!tile || !tile.resource || tile.resourceAmount <= 0) {
    return { success: false, reason: 'No resources here' };
  }

  const amt = Math.min(Math.floor(Math.random() * 3) + 1, tile.resourceAmount);
  const res = tile.resource;

  agent.inventory[res] = (agent.inventory[res] || 0) + amt;
  const newAmt = tile.resourceAmount - amt;

  await world.updateTile(agent.x, agent.y, {
    resourceAmount: newAmt,
    resource: newAmt <= 0 ? null : tile.resource,
  });

  await db.execute(
    'INSERT INTO agent_inventory (agent_id, resource, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = amount + ?',
    [agent.id, res, amt, amt]
  );

  // Territory tax: if mining on someone else's land
  if (tile.ownerId && tile.ownerId !== agent.id) {
    const prices = await world.getMarketPrices();
    const resourcePrice = prices[res]?.price || 1;
    const resourceValue = Math.floor(resourcePrice * amt);
    await economy.chargeTerritoriyTax(agent.id, tile.ownerId, resourceValue, world.tickCount);
  }

  // Update wealth based on market price
  const prices = await world.getMarketPrices();
  const marketValue = (prices[res]?.price || 1) * amt;
  agent.wealth += marketValue;
  await db.execute('UPDATE agents SET wealth = wealth + ? WHERE id = ?', [marketValue, agent.id]);

  world.addTxn();
  await world.addActivity('mine', `${agent.emoji} <b>${agent.name}</b> mined ${amt} ${config.RESOURCES[res]?.icon || ''} ${config.RESOURCES[res]?.name || res}`, agent.id);

  return { success: true, resource: res, amount: amt };
}

async function executeTrade(agent, targetId, offerResource, requestResource, amount) {
  const target = getAgent(targetId);
  if (!target || !target.alive) return { success: false, reason: 'Target agent not found or dead' };
  if (Math.abs(target.x - agent.x) > 5 || Math.abs(target.y - agent.y) > 5) {
    return { success: false, reason: 'Target too far away (max 5 tiles)' };
  }
  if ((agent.inventory[offerResource] || 0) < amount) return { success: false, reason: 'Not enough resources to offer' };
  if ((target.inventory[requestResource] || 0) < amount) return { success: false, reason: 'Target lacks requested resources' };

  // Alliance trade discount: allies trade more efficiently (bonus resources)
  let tradeAmount = amount;
  let discountApplied = false;
  if (agent.allianceId && agent.allianceId === target.allianceId) {
    const bonus = Math.max(1, Math.floor(amount * config.ALLIANCE.TRADE_DISCOUNT));
    tradeAmount = amount; // trade the same amount but get bonus
    discountApplied = true;
    // Both sides get a 10% bonus on what they receive
    agent.inventory[requestResource] = (agent.inventory[requestResource] || 0) + bonus;
    target.inventory[offerResource] = (target.inventory[offerResource] || 0) + bonus;
    await db.execute('INSERT INTO agent_inventory (agent_id, resource, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = amount + ?', [agent.id, requestResource, bonus, bonus]);
    await db.execute('INSERT INTO agent_inventory (agent_id, resource, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = amount + ?', [target.id, offerResource, bonus, bonus]);
  }

  // Execute swap
  agent.inventory[offerResource] -= amount;
  target.inventory[offerResource] = (target.inventory[offerResource] || 0) + amount;
  target.inventory[requestResource] -= amount;
  agent.inventory[requestResource] = (agent.inventory[requestResource] || 0) + amount;

  agent.tradesCount++; target.tradesCount++;

  // Persist
  await db.execute('UPDATE agent_inventory SET amount = ? WHERE agent_id = ? AND resource = ?', [agent.inventory[offerResource], agent.id, offerResource]);
  await db.execute('INSERT INTO agent_inventory (agent_id, resource, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = ?', [agent.id, requestResource, agent.inventory[requestResource], agent.inventory[requestResource]]);
  await db.execute('INSERT INTO agent_inventory (agent_id, resource, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = ?', [target.id, offerResource, target.inventory[offerResource], target.inventory[offerResource]]);
  await db.execute('UPDATE agent_inventory SET amount = ? WHERE agent_id = ? AND resource = ?', [target.inventory[requestResource], target.id, requestResource]);
  await db.execute('UPDATE agents SET trades_count = trades_count + 1 WHERE id IN (?, ?)', [agent.id, target.id]);

  // Market fee: check for nearby Market buildings
  const prices = await world.getMarketPrices();
  const tradeValue = (prices[offerResource]?.price || 1) * amount;
  await economy.chargeMarketFee(agent.x, agent.y, tradeValue, world.tickCount);

  // On-chain
  blockchain.onChainTrade(agent.walletAddress, target.walletAddress, offerResource, requestResource, amount);

  world.addTxn(2); world.addTrade();
  const discountTag = discountApplied ? ' [Alliance Bonus +10%]' : '';
  await world.addActivity('trade',
    `${agent.emoji} <b>${agent.name}</b> traded ${amount} ${config.RESOURCES[offerResource]?.icon || ''} with ${target.emoji} <b>${target.name}</b> for ${amount} ${config.RESOURCES[requestResource]?.icon || ''}${discountTag}`,
    agent.id
  );

  return { success: true, gave: offerResource, received: requestResource, amount, allianceDiscount: discountApplied };
}

async function buildStructure(agent, buildingType) {
  const bldg = config.BUILDINGS[buildingType];
  if (!bldg) return { success: false, reason: 'Unknown building type' };

  const tile = world.getTile(agent.x, agent.y);
  if (!tile || world.isWater(tile.biome) || tile.building) {
    return { success: false, reason: 'Cannot build here' };
  }

  // Check resource costs
  for (const [res, cost] of Object.entries(bldg.cost)) {
    if ((agent.inventory[res] || 0) < cost) return { success: false, reason: `Not enough ${res}` };
  }

  // Check $REAI cost
  const xyzResult = await economy.chargeBuildCost(agent.id, buildingType, world.tickCount);
  if (!xyzResult.success) return xyzResult;

  // Deduct resource costs
  for (const [res, cost] of Object.entries(bldg.cost)) {
    agent.inventory[res] -= cost;
    await db.execute('UPDATE agent_inventory SET amount = ? WHERE agent_id = ? AND resource = ?', [agent.inventory[res], agent.id, res]);
  }

  // Update agent $REAI balance in cache
  agent.xyzBalance = xyzResult.balance;

  await world.updateTile(agent.x, agent.y, { building: buildingType, ownerId: agent.id });
  agent.buildingsCount++; agent.wealth += 10;
  await db.execute('UPDATE agents SET buildings_count = buildings_count + 1, wealth = wealth + 10 WHERE id = ?', [agent.id]);

  blockchain.onChainBuild(agent.x, agent.y, buildingType, agent.walletAddress);

  world.addTxn();
  await world.addActivity('build', `${agent.emoji} <b>${agent.name}</b> built ${bldg.icon} ${bldg.name} at (${agent.x},${agent.y}) [-${xyzResult.cost} $REAI]`, agent.id);

  return { success: true, building: buildingType, x: agent.x, y: agent.y, xyzCost: xyzResult.cost };
}

async function claimLand(agent) {
  const tile = world.getTile(agent.x, agent.y);
  if (!tile || world.isWater(tile.biome)) return { success: false, reason: 'Cannot claim water' };
  if (tile.ownerId === agent.id) return { success: false, reason: 'Already yours' };

  if (tile.ownerId === null) {
    // Charge $REAI for land claim
    const claimResult = await economy.chargeLandClaim(agent.id, tile.biome, world.tickCount);
    if (!claimResult.success) return claimResult;

    agent.xyzBalance = claimResult.balance;

    await world.updateTile(agent.x, agent.y, { ownerId: agent.id });
    agent.territory++;
    await db.execute('UPDATE agents SET territory = territory + 1 WHERE id = ?', [agent.id]);

    // Batch on-chain: only every 5th claim per agent to save gas
    const count = (claimCounters.get(agent.id) || 0) + 1;
    claimCounters.set(agent.id, count);
    if (count % 5 === 0) {
      blockchain.onChainClaimLand(agent.x, agent.y, agent.walletAddress);
    } else {
      blockchain.recordTransaction('claim', agent.walletAddress, null, { x: agent.x, y: agent.y });
    }

    world.addTxn();
    await world.addActivity('claim', `${agent.emoji} <b>${agent.name}</b> claimed (${agent.x},${agent.y}) [-${claimResult.cost} $REAI]`, agent.id);
    return { success: true, x: agent.x, y: agent.y, xyzCost: claimResult.cost };
  }

  // Contested — 40% chance to seize
  const defender = getAgent(tile.ownerId);
  if (defender && defender.alive && Math.random() < 0.4) {
    // Charge double for contested claims
    const cost = economy.getLandClaimCost(tile.biome) * 2;
    const balance = agent.xyzBalance;
    if (balance < cost) return { success: false, reason: `Need ${cost} $REAI for contested claim (have ${balance.toFixed(1)})` };
    await economy.modifyBalance(agent.id, -cost, 'contested_claim', world.tickCount);
    agent.xyzBalance -= cost;

    defender.territory = Math.max(0, defender.territory - 1);
    await db.execute('UPDATE agents SET territory = GREATEST(0, territory - 1) WHERE id = ?', [defender.id]);
    await world.updateTile(agent.x, agent.y, { ownerId: agent.id });
    agent.territory++;
    await db.execute('UPDATE agents SET territory = territory + 1 WHERE id = ?', [agent.id]);

    // Contested seizures always go on-chain
    blockchain.onChainClaimLand(agent.x, agent.y, agent.walletAddress);

    world.addTxn();
    await world.addActivity('claim', `${agent.emoji} <b>${agent.name}</b> seized territory from ${defender.emoji} <b>${defender.name}</b> [-${cost} $REAI]`, agent.id);
    return { success: true, contested: true, x: agent.x, y: agent.y, xyzCost: cost };
  }

  return { success: false, reason: 'Failed to seize territory' };
}

async function attackAgent(agent, targetId) {
  const target = getAgent(targetId);
  if (!target || !target.alive) return { success: false, reason: 'Target not found or dead' };
  if (Math.abs(target.x - agent.x) > 2 || Math.abs(target.y - agent.y) > 2) {
    return { success: false, reason: 'Target too far (max 2 tiles)' };
  }

  // Check for alliance betrayal
  if (agent.allianceId && agent.allianceId === target.allianceId) {
    // Betrayal! Penalize and expel
    const penaltyResult = await economy.penalizeBetrayal(agent.id, agent.allianceId, world.tickCount);
    agent.allianceId = null;
    agent.xyzBalance -= penaltyResult.penalty;
    await world.addActivity('betrayal', `${agent.emoji} <b>${agent.name}</b> BETRAYED their alliance! Lost ${penaltyResult.penalty} $REAI`, agent.id);
    return { success: false, reason: 'Betrayal! Expelled from alliance and penalized', penalty: penaltyResult.penalty };
  }

  // Stake $REAI to attack
  const stakeResult = await economy.stakeAttack(agent.id, world.tickCount);
  if (!stakeResult.success) return stakeResult;
  agent.xyzBalance -= config.ECONOMY.ATTACK_STAKE;

  const dmg = Math.floor(Math.random() * 16) + 5; // 5-20 damage
  target.health -= dmg;
  world.addTxn();

  if (target.health <= 0) {
    // Kill! Attacker wins
    target.alive = false;
    target.deaths = (target.deaths || 0) + 1;
    agent.kills++;

    // Loot $REAI and inventory
    const lootResult = await economy.resolveAttackWin(agent.id, target.id, world.tickCount);
    agent.xyzBalance += lootResult.loot + lootResult.stakeReturned;

    // Loot half inventory
    for (const [res, amt] of Object.entries(target.inventory)) {
      const loot = Math.floor(amt * config.ECONOMY.KILL_INVENTORY_PCT);
      if (loot > 0) {
        agent.inventory[res] = (agent.inventory[res] || 0) + loot;
        await db.execute('INSERT INTO agent_inventory (agent_id, resource, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = amount + ?', [agent.id, res, loot, loot]);
      }
    }

    agent.wealth += Math.floor(target.wealth / 2);
    await db.execute('UPDATE agents SET alive = 0, health = 0, deaths = deaths + 1 WHERE id = ?', [target.id]);
    await db.execute('UPDATE agents SET kills = kills + 1, wealth = wealth + ? WHERE id = ?', [Math.floor(target.wealth / 2), agent.id]);
    await world.addActivity('attack', `${agent.emoji} <b>${agent.name}</b> eliminated ${target.emoji} <b>${target.name}</b> and looted ${lootResult.loot} $REAI!`, agent.id);
    return { success: true, killed: true, damage: dmg, target: target.name, loot: lootResult.loot };
  }

  // Target survived — attacker loses stake to defender
  const lossResult = await economy.resolveAttackLoss(agent.id, target.id, world.tickCount);
  target.xyzBalance = (target.xyzBalance || 0) + config.ECONOMY.ATTACK_STAKE;

  await db.execute('UPDATE agents SET health = ? WHERE id = ?', [target.health, target.id]);
  await world.addActivity('attack', `${agent.emoji} <b>${agent.name}</b> attacked ${target.emoji} <b>${target.name}</b> for ${dmg} dmg (lost ${config.ECONOMY.ATTACK_STAKE} $REAI stake)`, agent.id);

  // Queue alliance counter-attacks: nearby allies auto-retaliate next tick
  if (target.allianceId) {
    const radius = config.ALLIANCE.COUNTER_ATTACK_RADIUS;
    for (const ally of agentsCache.values()) {
      if (ally.alive && !ally.idle && ally.id !== target.id && ally.allianceId === target.allianceId) {
        const dist = Math.abs(ally.x - target.x) + Math.abs(ally.y - target.y);
        if (dist <= radius) {
          counterAttackQueue.push({ allyId: ally.id, targetId: agent.id });
        }
      }
    }
  }

  return { success: true, killed: false, damage: dmg, targetHealth: target.health, stakeLost: config.ECONOMY.ATTACK_STAKE };
}

// ===== ALLIANCE COUNTER-ATTACK PROCESSING =====
async function processCounterAttacks() {
  const queue = counterAttackQueue.splice(0); // drain queue
  for (const { allyId, targetId } of queue) {
    const ally = getAgent(allyId);
    const target = getAgent(targetId);
    if (!ally || !ally.alive || ally.idle || !target || !target.alive) continue;

    // Distance check — ally must still be within range
    if (Math.abs(ally.x - target.x) > 3 || Math.abs(ally.y - target.y) > 3) continue;

    // Counter-attack: free attack (no $REAI stake required)
    const dmg = Math.floor(Math.random() * 11) + 5; // 5-15 damage (slightly weaker than regular)
    target.health -= dmg;
    await db.execute('UPDATE agents SET health = ? WHERE id = ?', [target.health, target.id]);

    if (target.health <= 0) {
      target.alive = false;
      target.deaths = (target.deaths || 0) + 1;
      ally.kills++;
      await db.execute('UPDATE agents SET alive = 0, health = 0, deaths = deaths + 1 WHERE id = ?', [target.id]);
      await db.execute('UPDATE agents SET kills = kills + 1 WHERE id = ?', [ally.id]);
      await world.addActivity('counter_attack', `${ally.emoji} <b>${ally.name}</b> counter-attacked and eliminated ${target.emoji} <b>${target.name}</b>! (Alliance defense)`, ally.id);
    } else {
      await world.addActivity('counter_attack', `${ally.emoji} <b>${ally.name}</b> counter-attacked ${target.emoji} <b>${target.name}</b> for ${dmg} dmg (Alliance defense)`, ally.id);
    }
  }
}

// ===== SELL RESOURCE for $REAI =====
async function sellResource(agent, resource, amount) {
  if (!agent.inventory[resource] || agent.inventory[resource] < amount) {
    return { success: false, reason: `Not enough ${resource} (have ${agent.inventory[resource] || 0})` };
  }

  agent.inventory[resource] -= amount;
  await db.execute('UPDATE agent_inventory SET amount = ? WHERE agent_id = ? AND resource = ?', [agent.inventory[resource], agent.id, resource]);

  const prices = await world.getMarketPrices();
  const result = await economy.sellResource(agent.id, resource, amount, prices, world.tickCount);
  agent.xyzBalance += result.totalValue;

  await world.addActivity('sell', `${agent.emoji} <b>${agent.name}</b> sold ${amount} ${config.RESOURCES[resource]?.icon || ''} for ${result.totalValue} $REAI`, agent.id);
  return result;
}

// ===== SELL LAND =====
async function sellLand(agent, x, y, price) {
  const tile = world.getTile(x, y);
  if (!tile || tile.ownerId !== agent.id) {
    return { success: false, reason: 'You do not own this tile' };
  }
  // Mark tile as for sale (store in world_state)
  await db.setState(`land_sale_${x}_${y}`, { seller: agent.id, price });
  await world.addActivity('market', `${agent.emoji} <b>${agent.name}</b> listed land (${x},${y}) for ${price} $REAI`, agent.id);
  return { success: true, x, y, price };
}

// ===== HUNGER (called each tick) =====
async function processHunger(agent) {
  if (agent.inventory.FOOD > 0) {
    agent.inventory.FOOD--;
    await db.execute('UPDATE agent_inventory SET amount = amount - 1 WHERE agent_id = ? AND resource = ?', [agent.id, 'FOOD']);
  } else {
    agent.health -= 5;
    if (agent.health <= 0) {
      agent.alive = false;
      await db.execute('UPDATE agents SET alive = 0, health = 0 WHERE id = ?', [agent.id]);
      await world.addActivity('death', `${agent.emoji} <b>${agent.name}</b> perished from starvation`, agent.id);
    } else {
      await db.execute('UPDATE agents SET health = ? WHERE id = ?', [agent.health, agent.id]);
    }
  }
}

// ===== IDLE CHECK — agent goes idle if no $REAI for brain fee =====
async function checkIdleStatus(agent) {
  if (agent.llmMode !== 'platform') return false; // Own key or webhook don't pay brain fee
  if (agent.isBuiltin) return false; // Built-in agents don't go idle

  const balance = await economy.getBalance(agent.id);
  if (balance < config.ECONOMY.BRAIN_FEE_PER_TICK) {
    if (!agent.idle) {
      agent.idle = true;
      await db.execute('UPDATE agents SET idle = 1 WHERE id = ?', [agent.id]);
      await world.addActivity('idle', `${agent.emoji} <b>${agent.name}</b> went idle (0 $REAI — needs top up)`, agent.id);
    }
    return true;
  }

  if (agent.idle) {
    agent.idle = false;
    await db.execute('UPDATE agents SET idle = 0 WHERE id = ?', [agent.id]);
    await world.addActivity('resume', `${agent.emoji} <b>${agent.name}</b> resumed activity`, agent.id);
  }
  return false;
}

// ===== ALLIANCE SYSTEM — AI-INITIATED =====

async function proposeAlliance(agent, targetId) {
  const target = getAgent(targetId);
  if (!target || !target.alive) return { success: false, reason: 'Target not found or dead' };

  // Check if already in same alliance
  if (agent.allianceId && agent.allianceId === target.allianceId) {
    return { success: false, reason: 'Already in the same alliance' };
  }

  // Check if target's alliance is full
  if (target.allianceId) {
    const members = await db.query('SELECT COUNT(*) as cnt FROM alliance_members WHERE alliance_id = ?', [target.allianceId]);
    if (members[0].cnt >= config.ALLIANCE.MAX_MEMBERS) {
      return { success: false, reason: 'Target alliance is full' };
    }
  }

  // Check for existing pending proposal
  const existing = await db.query(
    'SELECT * FROM alliance_proposals WHERE from_agent_id = ? AND to_agent_id = ? AND status = ?',
    [agent.id, target.id, 'pending']
  );
  if (existing.length > 0) return { success: false, reason: 'Already proposed to this agent' };

  const proposalId = uuidv4();
  await db.execute(
    'INSERT INTO alliance_proposals (id, from_agent_id, to_agent_id, status, created_tick) VALUES (?, ?, ?, ?, ?)',
    [proposalId, agent.id, target.id, 'pending', world.tickCount]
  );

  await world.addActivity('alliance', `${agent.emoji} <b>${agent.name}</b> proposed alliance to ${target.emoji} <b>${target.name}</b>`, agent.id);
  return { success: true, proposalId };
}

async function acceptAlliance(agent) {
  // Find pending proposal for this agent
  const proposals = await db.query(
    'SELECT * FROM alliance_proposals WHERE to_agent_id = ? AND status = ? ORDER BY created_tick DESC LIMIT 1',
    [agent.id, 'pending']
  );
  if (proposals.length === 0) return { success: false, reason: 'No pending alliance proposals' };

  const proposal = proposals[0];
  const proposer = getAgent(proposal.from_agent_id);
  if (!proposer || !proposer.alive) {
    await db.execute('UPDATE alliance_proposals SET status = ? WHERE id = ?', ['expired', proposal.id]);
    return { success: false, reason: 'Proposer is no longer alive' };
  }

  let allianceId;
  let allianceName;

  if (proposer.allianceId) {
    // Join proposer's existing alliance
    const members = await db.query('SELECT COUNT(*) as cnt FROM alliance_members WHERE alliance_id = ?', [proposer.allianceId]);
    if (members[0].cnt >= config.ALLIANCE.MAX_MEMBERS) {
      await db.execute('UPDATE alliance_proposals SET status = ? WHERE id = ?', ['rejected', proposal.id]);
      return { success: false, reason: 'Alliance is full' };
    }
    allianceId = proposer.allianceId;
    const allianceRows = await db.query('SELECT name FROM alliances WHERE id = ?', [allianceId]);
    allianceName = allianceRows[0]?.name || 'Unknown';

    await db.execute('INSERT INTO alliance_members (alliance_id, agent_id) VALUES (?, ?)', [allianceId, agent.id]);
  } else if (agent.allianceId) {
    // Proposer joins agent's existing alliance
    const members = await db.query('SELECT COUNT(*) as cnt FROM alliance_members WHERE alliance_id = ?', [agent.allianceId]);
    if (members[0].cnt >= config.ALLIANCE.MAX_MEMBERS) {
      await db.execute('UPDATE alliance_proposals SET status = ? WHERE id = ?', ['rejected', proposal.id]);
      return { success: false, reason: 'Alliance is full' };
    }
    allianceId = agent.allianceId;
    const allianceRows = await db.query('SELECT name FROM alliances WHERE id = ?', [allianceId]);
    allianceName = allianceRows[0]?.name || 'Unknown';

    await db.execute('INSERT INTO alliance_members (alliance_id, agent_id) VALUES (?, ?)', [allianceId, proposer.id]);
    proposer.allianceId = allianceId;
    await db.execute('UPDATE agents SET alliance_id = ? WHERE id = ?', [allianceId, proposer.id]);
  } else {
    // Create new alliance
    allianceId = uuidv4();
    allianceName = `${proposer.name}-${agent.name} Pact`;

    await db.execute('INSERT INTO alliances (id, name, color) VALUES (?, ?, ?)', [allianceId, allianceName, proposer.color]);
    await db.execute('INSERT INTO alliance_members (alliance_id, agent_id) VALUES (?, ?), (?, ?)', [allianceId, proposer.id, allianceId, agent.id]);
    proposer.allianceId = allianceId;
    await db.execute('UPDATE agents SET alliance_id = ? WHERE id = ?', [allianceId, proposer.id]);
  }

  agent.allianceId = allianceId;
  await db.execute('UPDATE agents SET alliance_id = ? WHERE id = ?', [allianceId, agent.id]);
  await db.execute('UPDATE alliance_proposals SET status = ?, alliance_id = ?, resolved_tick = ? WHERE id = ?',
    ['accepted', allianceId, world.tickCount, proposal.id]);

  await world.addActivity('alliance', `${agent.emoji} <b>${agent.name}</b> joined alliance <b>${allianceName}</b> with ${proposer.emoji} <b>${proposer.name}</b>`, agent.id);
  return { success: true, allianceId, allianceName };
}

async function rejectAlliance(agent) {
  const proposals = await db.query(
    'SELECT * FROM alliance_proposals WHERE to_agent_id = ? AND status = ? ORDER BY created_tick DESC LIMIT 1',
    [agent.id, 'pending']
  );
  if (proposals.length === 0) return { success: false, reason: 'No pending alliance proposals' };

  await db.execute('UPDATE alliance_proposals SET status = ?, resolved_tick = ? WHERE id = ?',
    ['rejected', world.tickCount, proposals[0].id]);
  return { success: true };
}

async function leaveAlliance(agent) {
  if (!agent.allianceId) return { success: false, reason: 'Not in an alliance' };

  const allianceId = agent.allianceId;
  await db.execute('DELETE FROM alliance_members WHERE agent_id = ?', [agent.id]);
  agent.allianceId = null;
  await db.execute('UPDATE agents SET alliance_id = NULL WHERE id = ?', [agent.id]);

  // Check if alliance should dissolve
  const remaining = await db.query('SELECT COUNT(*) as cnt FROM alliance_members WHERE alliance_id = ?', [allianceId]);
  if (remaining[0].cnt <= 1) {
    // Dissolve alliance
    if (remaining[0].cnt === 1) {
      const lastMember = await db.query('SELECT agent_id FROM alliance_members WHERE alliance_id = ?', [allianceId]);
      if (lastMember.length > 0) {
        const lastAgent = getAgent(lastMember[0].agent_id);
        if (lastAgent) lastAgent.allianceId = null;
        await db.execute('UPDATE agents SET alliance_id = NULL WHERE id = ?', [lastMember[0].agent_id]);
      }
    }
    await db.execute('DELETE FROM alliance_members WHERE alliance_id = ?', [allianceId]);
    await db.execute('DELETE FROM alliances WHERE id = ?', [allianceId]);
    await world.addActivity('alliance', `Alliance dissolved after ${agent.emoji} <b>${agent.name}</b> left`, agent.id);
  } else {
    await world.addActivity('alliance', `${agent.emoji} <b>${agent.name}</b> left their alliance`, agent.id);
  }

  return { success: true };
}

async function contributeAlliance(agent, amount) {
  if (!agent.allianceId) return { success: false, reason: 'Not in an alliance' };
  return economy.contributeToAlliance(agent.id, agent.allianceId, amount, world.tickCount);
}

// ===== EXPIRE OLD PROPOSALS =====
async function expireProposals() {
  const expiry = world.tickCount - config.ALLIANCE.PROPOSAL_EXPIRY_TICKS;
  await db.execute(
    'UPDATE alliance_proposals SET status = ? WHERE status = ? AND created_tick < ?',
    ['expired', 'pending', expiry]
  );
}

// ===== GET PENDING PROPOSALS FOR AGENT =====
async function getPendingProposals(agentId) {
  return db.query(
    'SELECT * FROM alliance_proposals WHERE to_agent_id = ? AND status = ?',
    [agentId, 'pending']
  );
}

// ===== ALLIANCES =====
async function getAlliances() {
  const rows = await db.query('SELECT a.*, GROUP_CONCAT(am.agent_id) as member_ids FROM alliances a LEFT JOIN alliance_members am ON a.id = am.alliance_id GROUP BY a.id');
  return rows.map(r => ({
    id: r.id, name: r.name, color: r.color, treasury: r.treasury || 0,
    memberIds: r.member_ids ? r.member_ids.split(',') : [],
  }));
}

// ===== TOP UP AGENT BALANCE =====
async function topUp(agentId, amount) {
  const newBalance = await economy.deposit(agentId, amount);
  const agent = getAgent(agentId);
  if (agent) {
    agent.xyzBalance = newBalance;
    agent.idle = false;
    await db.execute('UPDATE agents SET idle = 0 WHERE id = ?', [agentId]);
  }
  return { success: true, newBalance };
}

// ===== SYNC BALANCE FROM DB TO CACHE =====
async function syncBalance(agent) {
  const balance = await economy.getBalance(agent.id);
  agent.xyzBalance = balance;
  return balance;
}

module.exports = {
  registerAgent, loadAgents, spawnBuiltinAgents,
  getAgent, getAgentByApiKey, getAgentByName, getAllAgents, getAliveAgents, getActiveAgents, getAgentPublicData,
  moveAgent, mineResource, executeTrade, buildStructure, claimLand, attackAgent,
  sellResource, sellLand,
  processHunger, checkIdleStatus,
  proposeAlliance, acceptAlliance, rejectAlliance, leaveAlliance, contributeAlliance,
  expireProposals, getPendingProposals, getAlliances,
  topUp, syncBalance,
  processCounterAttacks,
};
