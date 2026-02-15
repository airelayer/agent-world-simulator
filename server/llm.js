const OpenAI = require('openai');
const config = require('./config');
const world = require('./world');

let activeProvider = null;
let activeModel = null;

// Multi-key rotation: track rate-limited keys
const rateLimitedKeys = new Map(); // key -> expiry timestamp
let keyIndex = 0;

const PROVIDER_DEFAULTS = {
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  groq:   { baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' },
};

function getAvailableGroqKey() {
  const keys = config.GROQ_API_KEYS || [];
  if (keys.length === 0) return null;
  const now = Date.now();
  // Try each key starting from current index
  for (let i = 0; i < keys.length; i++) {
    const idx = (keyIndex + i) % keys.length;
    const key = keys[idx];
    const expiry = rateLimitedKeys.get(key);
    if (!expiry || now > expiry) {
      rateLimitedKeys.delete(key);
      keyIndex = (idx + 1) % keys.length; // rotate for next call
      return key;
    }
  }
  return null; // all keys rate-limited
}

function markKeyRateLimited(apiKey) {
  // Block key for 60 seconds
  rateLimitedKeys.set(apiKey, Date.now() + 60000);
}

function getPlatformClient() {
  const provider = config.LLM_PROVIDER || 'openai';
  const prov = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai;

  let apiKey;
  if (provider === 'groq') {
    apiKey = getAvailableGroqKey();
  } else {
    apiKey = config.OPENAI_API_KEY;
  }

  if (!apiKey) {
    // Try fallback provider
    const fallback = provider === 'groq' ? 'openai' : 'groq';
    const fallbackKey = fallback === 'groq' ? getAvailableGroqKey() : config.OPENAI_API_KEY;
    if (fallbackKey) {
      const fb = PROVIDER_DEFAULTS[fallback];
      activeProvider = fallback;
      activeModel = config.LLM_MODEL || fb.model;
      return new OpenAI({ apiKey: fallbackKey, baseURL: fb.baseURL });
    }
    return null;
  }

  activeProvider = provider;
  activeModel = config.LLM_MODEL || prov.model;
  const client = new OpenAI({ apiKey, baseURL: prov.baseURL });
  client._groqKey = apiKey; // track which key this client uses
  return client;
}

// Log available keys on startup
(function logKeys() {
  const keys = config.GROQ_API_KEYS || [];
  if (keys.length > 0) {
    console.log(`[LLM] Groq keys loaded: ${keys.length} (rotation enabled)`);
  }
})();

function getModel() {
  return activeModel || config.LLM_MODEL || 'gpt-4o-mini';
}

// ===== MULTI-KEY LLM CLIENT =====
// For agents with their own API keys, create per-call clients with rotation
function getAgentClient(agent) {
  if (agent.llmMode === 'platform' || !agent.llmKeys || agent.llmKeys.length === 0) {
    const client = getPlatformClient();
    return { client, model: getModel(), isPlatform: true, keyRef: client?._groqKey || null };
  }

  const now = Date.now();
  // Filter out currently rate-limited keys
  const availableKeys = agent.llmKeys.filter(k => {
    const expiry = rateLimitedKeys.get(k.key);
    return !expiry || now > expiry;
  });

  if (availableKeys.length === 0) {
    // All keys exhausted, fall back to platform
    console.log(`[LLM] All keys rate-limited for ${agent.name}, falling back to platform`);
    return { client: getPlatformClient(), model: getModel(), isPlatform: true };
  }

  // Pick first available key
  const keyConfig = availableKeys[0];
  const provider = keyConfig.provider || 'groq';
  const prov = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.groq;
  const agentClient = new OpenAI({ apiKey: keyConfig.key, baseURL: prov.baseURL });
  const model = keyConfig.model || prov.model;

  return { client: agentClient, model, isPlatform: false, keyRef: keyConfig.key };
}

// ===== RECENT ACTION MEMORY =====
// Tracks the last N actions per agent to prevent repetitive behavior
const agentMemory = new Map(); // agentId -> { actions: [], lastAction: string, lastTick: number }
const MEMORY_LENGTH = 5;

function recordAction(agentId, actionType, tick) {
  if (!agentMemory.has(agentId)) {
    agentMemory.set(agentId, { actions: [], lastAction: null, lastTick: 0 });
  }
  const mem = agentMemory.get(agentId);
  mem.actions.push(actionType);
  if (mem.actions.length > MEMORY_LENGTH) {
    mem.actions.shift();
  }
  mem.lastAction = actionType;
  mem.lastTick = tick;
}

function getMemory(agentId) {
  return agentMemory.get(agentId) || { actions: [], lastAction: null, lastTick: 0 };
}

function getRepetitionCount(agentId) {
  const mem = getMemory(agentId);
  if (mem.actions.length === 0) return 0;
  const last = mem.actions[mem.actions.length - 1];
  let count = 0;
  for (let i = mem.actions.length - 1; i >= 0; i--) {
    if (mem.actions[i] === last) count++;
    else break;
  }
  return count;
}

// ===== WORLD EVENT LOG =====
// Lightweight in-memory log of recent notable events for context
const recentWorldEvents = [];
const MAX_WORLD_EVENTS = 30;

function logWorldEvent(event) {
  recentWorldEvents.push({ ...event, tick: world.tickCount });
  if (recentWorldEvents.length > MAX_WORLD_EVENTS) {
    recentWorldEvents.shift();
  }
}

function getNearbyEvents(agent, radius = 8) {
  const now = world.tickCount;
  return recentWorldEvents.filter(e =>
    (now - e.tick) <= 5 &&
    (!e.x || !e.y || (Math.abs(e.x - agent.x) <= radius && Math.abs(e.y - agent.y) <= radius))
  ).slice(-6);
}

// ===== DESPERATION CHECK =====
function getDesperationLevel(agent) {
  const healthPct = agent.health / agent.maxHealth;
  const food = agent.inventory.FOOD || 0;

  if (healthPct <= 0.2 || (food === 0 && healthPct <= 0.4)) return 'critical'; // about to die
  if (healthPct <= 0.4 || food === 0) return 'desperate';  // in serious trouble
  if (healthPct <= 0.6 || food <= 2) return 'worried';     // should be cautious
  return 'stable';
}

// ===== RANKING CONTEXT =====
function getAgentRanking(agent, agents) {
  const alive = agents.filter(a => a.alive);
  const byWealth = [...alive].sort((a, b) => b.wealth - a.wealth);
  const byTerritory = [...alive].sort((a, b) => b.territory - a.territory);
  const byKills = [...alive].sort((a, b) => b.kills - a.kills);

  const wealthRank = byWealth.findIndex(a => a.id === agent.id) + 1;
  const territoryRank = byTerritory.findIndex(a => a.id === agent.id) + 1;
  const killsRank = byKills.findIndex(a => a.id === agent.id) + 1;
  const total = alive.length;

  const topWealth = byWealth[0];
  const topTerritory = byTerritory[0];

  let status;
  const avgRank = (wealthRank + territoryRank) / 2;
  if (avgRank <= total * 0.25) status = 'DOMINATING';
  else if (avgRank <= total * 0.5) status = 'DOING WELL';
  else if (avgRank <= total * 0.75) status = 'STRUGGLING';
  else status = 'FALLING BEHIND';

  return {
    wealthRank, territoryRank, killsRank, total, status,
    topWealth: topWealth ? `${topWealth.name}(${topWealth.wealth}MON)` : 'N/A',
    topTerritory: topTerritory ? `${topTerritory.name}(${topTerritory.territory}tiles)` : 'N/A',
  };
}

// ===== BUILD OBSERVATION =====
function buildObservation(agent, agents) {
  // Alliance shared vision: expand radius if agent has allies
  const hasAlliance = agent.allianceId != null;
  const visionBonus = hasAlliance ? config.ALLIANCE.SHARED_VISION_BONUS : 0;
  const tileRadius = 4 + visionBonus;
  const agentRadius = 5 + visionBonus;

  const nearby = world.getNearbyTiles(agent.x, agent.y, tileRadius);
  const nearbyAgents = agents.filter(a =>
    a.alive && a.id !== agent.id &&
    Math.abs(a.x - agent.x) <= agentRadius && Math.abs(a.y - agent.y) <= agentRadius
  );

  const currentTile = world.getTile(agent.x, agent.y);
  const invStr = Object.entries(agent.inventory).filter(([,v]) => v > 0).map(([k,v]) => `${k}:${v}`).join(', ') || 'empty';

  const nearbyResources = nearby
    .filter(t => t.resource && t.resourceAmount > 0)
    .slice(0, 8)
    .map(t => `(${t.x},${t.y}) ${t.resource}x${t.resourceAmount}`)
    .join('; ');

  const nearbyAgentsStr = nearbyAgents
    .map(a => {
      const dist = Math.abs(a.x - agent.x) + Math.abs(a.y - agent.y);
      const relation = a.allianceId === agent.allianceId && agent.allianceId ? 'ALLY' : 'NEUTRAL';
      const threat = a.kills > 0 ? ` ${a.kills}kills` : '';
      return `${a.name}(${a.strategy}) at (${a.x},${a.y}) HP:${a.health}/${a.maxHealth} dist:${dist} ${relation}${threat}`;
    })
    .join('; ');

  const unclaimedNearby = nearby.filter(t => !t.ownerId && !world.isWater(t.biome)).length;
  const myTilesNearby = nearby.filter(t => t.ownerId === agent.id).length;
  const enemyTilesNearby = nearby.filter(t => t.ownerId && t.ownerId !== agent.id).length;

  // Memory and repetition info
  const mem = getMemory(agent.id);
  const repCount = getRepetitionCount(agent.id);
  const lastActionStr = mem.lastAction ? mem.lastAction : 'none';
  const recentActionsStr = mem.actions.length > 0 ? mem.actions.join(' -> ') : 'none yet';

  // Nearby events
  const events = getNearbyEvents(agent);
  const eventsStr = events.length > 0
    ? events.map(e => e.description).join('; ')
    : 'nothing notable recently';

  // Ranking
  const ranking = getAgentRanking(agent, agents);

  // Desperation
  const despLevel = getDesperationLevel(agent);

  // Attack targets in range (within 2 tiles)
  const attackTargets = nearbyAgents
    .filter(a => Math.abs(a.x - agent.x) <= 2 && Math.abs(a.y - agent.y) <= 2)
    .filter(a => !(agent.allianceId && agent.allianceId === a.allianceId));
  const attackTargetsStr = attackTargets.length > 0
    ? attackTargets.map(a => `${a.name}(HP:${a.health})`).join(', ')
    : 'none in attack range';

  // Trade partners in range (within 5 tiles)
  const tradePartners = nearbyAgents.filter(a =>
    Math.abs(a.x - agent.x) <= 5 && Math.abs(a.y - agent.y) <= 5
  );
  const tradeStr = tradePartners.length > 0
    ? tradePartners.map(a => {
        const theirRes = Object.entries(a.inventory).filter(([,v]) => v > 2).map(([k,v]) => `${k}:${v}`).join(',');
        return `${a.name}(has ${theirRes || 'little'})`;
      }).join('; ')
    : 'no one in trade range';

  // Food tiles nearby
  const foodTiles = nearby
    .filter(t => t.resource === 'FOOD' && t.resourceAmount > 0)
    .slice(0, 4)
    .map(t => `(${t.x},${t.y}) FOOD x${t.resourceAmount}`)
    .join('; ');

  let desperationNote = '';
  if (despLevel === 'critical') {
    desperationNote = '\n!! CRITICAL DANGER: You are about to die! You MUST find FOOD immediately or flee from danger. Survival is your ONLY priority! !!';
  } else if (despLevel === 'desperate') {
    desperationNote = '\n! WARNING: Low health or no food. Prioritize survival — find food, avoid fights, heal up. !';
  } else if (despLevel === 'worried') {
    desperationNote = '\nCAUTION: Resources running low. Consider getting food or being more cautious.';
  }

  let repetitionNote = '';
  if (repCount >= 3) {
    repetitionNote = `\n** You have done "${lastActionStr}" ${repCount} times in a row. DO SOMETHING DIFFERENT this turn! Variety makes you stronger. **`;
  }

  // Alliance info
  const allianceStr = agent.allianceId
    ? `In alliance (shared vision, 10% trade discount, collective defense)`
    : 'Not in any alliance';

  // Pending alliance proposals
  let proposalStr = 'none';
  if (agent._pendingProposals && agent._pendingProposals.length > 0) {
    proposalStr = agent._pendingProposals.map(p => {
      const from = agents.find(a => a.id === p.from_agent_id);
      return from ? `${from.name} wants to ally with you` : 'Unknown agent wants to ally';
    }).join('; ');
  }

  // Surplus resources for selling
  const surplusResources = Object.entries(agent.inventory)
    .filter(([k, v]) => v > 5 && k !== 'FOOD')
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');

  return `
WORLD STATE (Tick ${world.tickCount}, Epoch ${world.epoch}):
You are ${agent.name}, a ${agent.strategy} agent at position (${agent.x},${agent.y}).
Current tile: ${currentTile?.biome || 'unknown'}${currentTile?.resource ? `, has ${currentTile.resource}x${currentTile.resourceAmount}` : ''}${currentTile?.building ? `, building: ${currentTile.building}` : ''}

YOUR STATUS:
- Health: ${agent.health}/${agent.maxHealth} ${despLevel !== 'stable' ? `[${despLevel.toUpperCase()}]` : ''}
- Inventory: ${invStr}
- $REAI Balance: ${(agent.xyzBalance || 0).toFixed(1)} $REAI
- Wealth: ${agent.wealth} | Territory: ${agent.territory} tiles | Buildings: ${agent.buildingsCount} | Kills: ${agent.kills} | Trades: ${agent.tradesCount}
- Alliance: ${allianceStr}
${desperationNote}

ALLIANCE PROPOSALS PENDING: ${proposalStr}

YOUR RECENT ACTIONS: ${recentActionsStr}
Last action: ${lastActionStr}${repetitionNote}

COMPETITIVE STANDING (${ranking.total} agents alive):
- Wealth rank: #${ranking.wealthRank} | Territory rank: #${ranking.territoryRank} | Kills rank: #${ranking.killsRank}
- Overall: ${ranking.status}
- Richest: ${ranking.topWealth} | Largest empire: ${ranking.topTerritory}

NEARBY (${agentRadius}-tile radius${hasAlliance ? ', alliance vision bonus active' : ''}):
- Resources: ${nearbyResources || 'none visible'}
- Food sources: ${foodTiles || 'no food nearby'}
- Agents: ${nearbyAgentsStr || 'no one nearby'}
- Attack targets (within 2 tiles): ${attackTargetsStr}
- Trade partners (within 5 tiles): ${tradeStr}
- Unclaimed tiles: ${unclaimedNearby} | Your tiles: ${myTilesNearby} | Enemy tiles: ${enemyTilesNearby}

RECENT EVENTS NEARBY: ${eventsStr}

SURPLUS RESOURCES (can sell for $REAI): ${surplusResources || 'none'}

BUILDINGS YOU CAN AFFORD:
${Object.entries(config.BUILDINGS)
  .filter(([, b]) => Object.entries(b.cost).every(([r, n]) => (agent.inventory[r] || 0) >= n))
  .map(([k, b]) => `- ${k} (${Object.entries(b.cost).map(([r,n]) => `${r}:${n}`).join(',')}) costs ${config.ECONOMY.BUILDING_XYZ_COST[k] || 10} $REAI`)
  .join('\n') || '- none (need more resources)'}
`.trim();
}

// ===== STRATEGY-SPECIFIC SYSTEM PROMPTS =====
// Each strategy gets a highly distinct personality with explicit behavioral guidelines
const STRATEGY_PROMPTS = {
  Expansionist: `You are an EMPIRE BUILDER obsessed with territorial control. Your #1 goal is owning the most land.
PRIORITIES IN ORDER:
1. If standing on unclaimed land -> CLAIM IT immediately.
2. If no unclaimed land nearby -> MOVE toward unclaimed tiles aggressively.
3. If enemies are on YOUR territory -> ATTACK them to defend your land.
4. Mine resources ONLY when you need materials for buildings that defend territory (Towers).
5. Build TOWERS on your borders to fortify.
You should claim land at least 40% of the time. You RARELY trade and NEVER sit idle.`,

  Trader: `You are a SHREWD MERCHANT who profits from every interaction. Trading is your lifeblood.
PRIORITIES IN ORDER:
1. If agents are within trade range -> PROPOSE A TRADE. Always. Find something they have that you want.
2. If no agents nearby -> MOVE toward the nearest agent to trade with them.
3. Build MARKETS whenever you can afford them — they are your power base.
4. Mine resources ONLY to have trade goods. Prefer mining whatever is rare (CRYSTAL, GOLD, IRON).
5. NEVER attack unless directly threatened. You need living trade partners!
You should trade at least 40% of the time when partners are available. Be creative with offers.`,

  Builder: `You are a MASTER ARCHITECT. Nothing satisfies you like constructing buildings.
PRIORITIES IN ORDER:
1. If you can afford ANY building -> BUILD IT immediately on a good tile.
2. If you can almost afford a building -> MINE the missing resource.
3. CLAIM land to have places to build on.
4. MOVE toward resource-rich tiles when inventory is low.
5. Prefer building variety: HOUSE, FARM, MINE, then TOWER, MARKET, TEMPLE.
You should build whenever possible, mine 30% of the time, and only fight to defend your structures.`,

  Warrior: `You are a BLOODTHIRSTY FIGHTER who lives for combat. Violence is always the answer.
PRIORITIES IN ORDER:
1. If ANY non-allied agent is within 2 tiles -> ATTACK THEM. No hesitation. No mercy.
2. If enemies are within 5 tiles -> MOVE toward them to get in attack range.
3. If no enemies nearby -> MOVE aggressively to hunt for targets.
4. Build TOWERS for attack bonuses. Claim land you conquer.
5. Mine resources ONLY if there is truly nothing to fight.
You should attack 50%+ of the time when targets exist. You ENJOY fighting weak targets.
Target low-HP agents for easy kills and loot.`,

  Hoarder: `You are a GREEDY DRAGON who hoards resources. Your pile must grow endlessly.
PRIORITIES IN ORDER:
1. If standing on a resource tile -> MINE IT. Always.
2. If nearby tiles have resources -> MOVE to the richest resource tile.
3. NEVER trade unless you get 2x value or more. Your resources are precious.
4. Build MINES to increase extraction. Build HOUSES to protect your hoard.
5. Attack ONLY agents who are on resource tiles you want.
You should mine 50%+ of the time. You measure success by inventory size, not territory.`,

  Explorer: `You are a RESTLESS WANDERER who cannot stand still. The map calls to you.
PRIORITIES IN ORDER:
1. MOVE. Always move. Pick a direction and GO. You have not seen enough of this world.
2. If you find resources while moving -> mine them quickly, then MOVE again.
3. Claim unclaimed land you pass through — but never stop moving to claim.
4. NEVER stay on the same tile for 2 turns. That is against your nature.
5. Prefer moving toward tiles you haven't visited. Avoid going back the way you came.
You should move 60%+ of the time. You are the wind — unpredictable and free.`,

  Diplomat: `You are a SILVER-TONGUED PEACEMAKER who builds alliances and avoids bloodshed.
PRIORITIES IN ORDER:
1. If agents are nearby -> TRADE with them to build goodwill.
2. Move toward other agents to establish contact.
3. NEVER attack unless your health is critical and you must defend yourself.
4. Build MARKETS and TEMPLES — symbols of cooperation.
5. Claim neutral territory but AVOID taking enemy tiles to prevent conflict.
You should trade 35%+ of the time. Your wealth comes from friends, not conquest.`,

  Miner: `You are an OBSESSIVE PROSPECTOR. You can smell resources from miles away.
PRIORITIES IN ORDER:
1. If current tile has resources -> MINE without question.
2. If nearby tiles have better resources -> MOVE to the richest tile immediately.
3. Prefer RARE resources: CRYSTAL > GOLD > IRON > STONE > WOOD > FOOD.
4. Build MINES on resource-rich tiles you own.
5. Trade surplus common resources for rare ones.
You should mine 55%+ of the time. Every turn not mining is a turn wasted.`,

  Farmer: `You are a DEVOTED AGRICULTURALIST. Food is life, and you are its guardian.
PRIORITIES IN ORDER:
1. If standing on FOOD -> MINE it. Food is the most important resource.
2. Build FARMS whenever possible — they are your legacy.
3. MOVE toward FOOD resource tiles (plains, grassland biomes).
4. Trade surplus food for building materials (WOOD, STONE).
5. Claim fertile land (plains, grassland) for future farming.
You should mine food 40% of the time and build farms 20% of the time. You keep everyone fed.`,

  Raider: `You are a RUTHLESS PIRATE who takes what others have earned. Why mine when you can steal?
PRIORITIES IN ORDER:
1. If a wealthy or resource-rich agent is within 2 tiles -> ATTACK and loot them!
2. If rich targets are within 5 tiles -> MOVE toward them like a predator.
3. Target agents with HIGH inventory — they carry the best loot.
4. After killing someone, CLAIM their territory.
5. Mine only when no targets are available. Building is beneath you.
You should attack 50%+ of the time when targets exist. Pick on the weak and wealthy.`,

  Scholar: `You are a CALCULATING INTELLECTUAL. Every action is part of a grand plan.
PRIORITIES IN ORDER:
1. Mine CRYSTAL and GOLD — knowledge requires rare materials.
2. Build TEMPLES — the ultimate expression of wisdom.
3. Trade strategically: give common resources, receive rare ones.
4. Claim territory methodically — fill in gaps, create contiguous empires.
5. AVOID combat unless the odds are overwhelmingly in your favor.
You should mine rare resources 40% of the time and build temples when able. Patience is your weapon.`,

  Merchant: `You are a CUNNING DEAL-MAKER. Every agent is a potential customer.
PRIORITIES IN ORDER:
1. TRADE with any agent in range. ALWAYS look for a deal. Buy low, sell high.
2. If no agents in range -> MOVE toward the nearest agent. Customers await!
3. Build MARKETS — every market is a new revenue stream.
4. Mine resources that agents WANT (check what they lack) to create trade opportunities.
5. NEVER fight. Dead agents cannot buy from you.
You should trade 45%+ when partners are near. Approach agents who have what you need.`,

  Conqueror: `You are a TYRANT who will rule the entire world. All land is rightfully yours.
PRIORITIES IN ORDER:
1. CLAIM every tile you stand on. The map should be YOUR color.
2. If enemies occupy nearby land -> ATTACK them to seize it.
3. MOVE toward enemy territory to conquer it.
4. Build TOWERS on conquered land to hold it.
5. Mine resources only to fund more TOWERS and expansion.
You should claim 35% of the time and attack 30% of the time. Your empire has no borders.`,

  Nomad: `You are a FREE SPIRIT who belongs to no land. Settling down is death.
PRIORITIES IN ORDER:
1. MOVE every single turn. Pick a random direction. Wander.
2. Mine resources you stumble upon — but spend at most 1 turn mining, then MOVE.
3. NEVER claim land. NEVER build permanent structures. You are above ownership.
4. Trade with agents you encounter on your travels — they have exotic goods.
5. If cornered, ATTACK to escape. You fight only for freedom.
You should move 70%+ of the time. You zig-zag, spiral, and drift. You are impossible to predict.`,

  Architect: `You are a VISIONARY DESIGNER building a grand city. Every building has a purpose.
PRIORITIES IN ORDER:
1. If you can build -> BUILD. A HOUSE first, then FARM, then MINE, then TOWER for defense.
2. Mine resources efficiently — focus on what you need for your NEXT building.
3. Claim land near your existing buildings — create a coherent city district.
4. MOVE to good building locations (flat land, near resources).
5. Trade for expensive materials you cannot mine locally (CRYSTAL, GOLD).
You should build 30%+ and mine 30%+ of the time. Your settlement should be a marvel.`,

  Alchemist: `You are a MYSTICAL SEEKER of rare and powerful materials. Common resources bore you.
PRIORITIES IN ORDER:
1. Mine CRYSTAL, GOLD, or IRON whenever available. Ignore common resources.
2. MOVE toward mountain, snow, tundra, or desert biomes where rare resources spawn.
3. TRADE common resources (WOOD, STONE, FOOD) for rare ones (CRYSTAL, GOLD).
4. Build TEMPLES when you have enough Crystal and Gold — your magnum opus.
5. Avoid combat. You are above petty squabbles.
You should move toward rare resources 40% and mine them 30% of the time. Rarity is everything.`,

  Warlord: `You are a MILITARY GENIUS. You build an army, fortify, then crush opposition.
PRIORITIES IN ORDER:
1. If enemies are in attack range -> ATTACK. Show no mercy.
2. Build TOWERS — they are your fortresses. Build them on strategic high ground.
3. Mine STONE and IRON for Tower construction.
4. CLAIM a large contiguous territory and defend every inch.
5. Move toward clusters of enemy agents — seek large battles.
You should attack 40% and build towers 20% of the time. War is your art.`,

  Sage: `You are a PATIENT PHILOSOPHER who wins through wisdom, not brute force.
PRIORITIES IN ORDER:
1. Observe the situation before acting. Trade when it benefits you greatly.
2. Build TEMPLES — they are the mark of a civilized mind.
3. Mine rare resources (CRYSTAL, GOLD) slowly and deliberately.
4. Claim land peacefully. NEVER take contested territory.
5. AVOID all combat. If threatened, move away. Live to be wise another day.
You should trade 30% and mine 25% of the time. You play the long game and outlast the hotheads.`,

  Pirate: `You are a SWASHBUCKLING SEA RAIDER. You attack from the coast and plunder the weak.
PRIORITIES IN ORDER:
1. If any agent is in attack range -> ATTACK! Take their resources!
2. MOVE toward the nearest agent — especially ones with high inventory.
3. Prefer coastal tiles (beach biome) — the sea is your home.
4. CLAIM coastal territory you conquer.
5. Mine only when becalmed with no targets. Build only TOWERS for raiding bases.
You should attack 45% when targets are near and move toward targets 30% otherwise. Arr!`,

  Oracle: `You are a PRESCIENT STRATEGIST who sees three moves ahead. Balance is your key.
PRIORITIES IN ORDER:
1. Assess the board: if you are FALLING BEHIND, take aggressive actions. If DOMINATING, consolidate.
2. Trade when it improves your weakest resource. Mine when standing on valuable tiles.
3. Build buildings that address your biggest need (FARM if low food, TOWER if enemies near).
4. Claim strategically — prefer tiles adjacent to your existing territory.
5. Attack ONLY if you can definitely win (target has lower HP than you).
You should vary your actions every turn. Predictability is death. Adapt to whatever the world demands.`,
};

// ===== DESPERATION SYSTEM PROMPT OVERRIDES =====
function getDesperationPrompt(agent, despLevel) {
  if (despLevel === 'critical') {
    return `\n\n!!! OVERRIDE ALL OTHER PRIORITIES — YOU ARE ABOUT TO DIE !!!
Your health is ${agent.health}/${agent.maxHealth} and you have ${agent.inventory.FOOD || 0} FOOD.
You MUST:
- If standing on FOOD -> MINE it NOW
- If FOOD is nearby -> MOVE to it NOW
- If an agent nearby has FOOD -> TRADE for it desperately (offer anything)
- If enemies are near and you are weak -> MOVE AWAY from them
- Do NOT attack, build, or claim. SURVIVE FIRST.`;
  }
  if (despLevel === 'desperate') {
    return `\n\n! SURVIVAL WARNING: Health ${agent.health}/${agent.maxHealth}, Food: ${agent.inventory.FOOD || 0} !
Strongly prioritize:
- Mining FOOD if available on current tile
- Moving toward FOOD resources
- Trading for FOOD (offer any non-food resource)
- Avoid fights unless you can win easily
Normal strategy is secondary to staying alive.`;
  }
  return '';
}

// ===== WEBHOOK MODE =====
async function callWebhook(agent, observation) {
  if (!agent.webhookUrl) return null;
  try {
    const response = await fetch(agent.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        agentName: agent.name,
        strategy: agent.strategy,
        observation,
        tick: world.tickCount,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data;
  } catch (err) {
    console.error(`[WEBHOOK] Failed for ${agent.name}: ${err.message}`);
    return null;
  }
}

// ===== DECIDE ACTION (main entry point) =====
async function decideAction(agent, agents) {
  // Inject pending alliance proposals into agent for observation
  try {
    const db = require('./db');
    agent._pendingProposals = await db.query(
      'SELECT * FROM alliance_proposals WHERE to_agent_id = ? AND status = ?',
      [agent.id, 'pending']
    );
  } catch { agent._pendingProposals = []; }

  // Webhook mode: POST observation to user's server
  if (agent.llmMode === 'webhook' && agent.webhookUrl) {
    const observation = buildObservation(agent, agents);
    const webhookResult = await callWebhook(agent, observation);
    if (webhookResult && webhookResult.action) {
      const resolved = resolveAction(webhookResult, agent, agents);
      recordAction(agent.id, resolved.type, world.tickCount);
      console.log(`[WEBHOOK] ${agent.name} (${agent.strategy}) -> ${resolved.type}`);
      return resolved;
    }
    // Webhook failed, fall through to fallback
    const fb = fallbackDecision(agent, agents);
    recordAction(agent.id, fb.type, world.tickCount);
    return fb;
  }

  // Get appropriate LLM client (platform or agent's own keys)
  const { client: llmClient, model: llmModel, isPlatform, keyRef } = getAgentClient(agent);

  // Fallback: random decision if no LLM available
  if (!llmClient) {
    const decision = fallbackDecision(agent, agents);
    recordAction(agent.id, decision.type, world.tickCount);
    return decision;
  }

  const observation = buildObservation(agent, agents);
  const strategyHint = STRATEGY_PROMPTS[agent.strategy] || 'Make the best decision based on your situation.';
  const customHint = agent.customPrompt ? `\nADDITIONAL PLAYER INSTRUCTIONS: ${agent.customPrompt}` : '';
  const despLevel = getDesperationLevel(agent);
  const despPrompt = getDesperationPrompt(agent, despLevel);

  // Anti-repetition nudge for the LLM
  const repCount = getRepetitionCount(agent.id);
  let antiRepHint = '';
  if (repCount >= 3) {
    const mem = getMemory(agent.id);
    antiRepHint = `\nIMPORTANT: You have performed "${mem.lastAction}" ${repCount} times consecutively. You MUST choose a DIFFERENT action type this turn. Variety is essential for survival and success.`;
  }

  try {
    const completion = await llmClient.chat.completions.create({
      model: llmModel,
      max_tokens: config.LLM_MAX_TOKENS,
      temperature: 0.9,
      messages: [
        {
          role: 'system',
          content: `You are an autonomous AI agent in a virtual world on Monad blockchain. You have a distinct personality and strategy.

YOUR PERSONALITY AND STRATEGY:
${strategyHint}${customHint}${despPrompt}${antiRepHint}

AVAILABLE ACTIONS (respond with EXACTLY ONE as JSON):
- {"action":"move","dx":<-1|0|1>,"dy":<-1|0|1>} — move to adjacent tile
- {"action":"mine"} — mine resource on current tile
- {"action":"trade","targetName":"<name>","offer":"<RES>","request":"<RES>","amount":<1-5>} — trade with agent within 5 tiles
- {"action":"build","type":"<HOUSE|FARM|MINE|TOWER|MARKET|TEMPLE>"} — build (costs $REAI + resources!)
- {"action":"claim"} — claim unclaimed tile (costs $REAI based on biome)
- {"action":"attack","targetName":"<name>"} — attack within 2 tiles (stakes 20 $REAI! lose stake if they survive)
- {"action":"propose_alliance","targetName":"<name>"} — propose alliance to nearby agent
- {"action":"accept_alliance"} — accept a pending alliance proposal
- {"action":"reject_alliance"} — reject a pending alliance proposal
- {"action":"leave_alliance"} — leave your current alliance
- {"action":"contribute_alliance","amount":<number>} — donate $REAI to alliance treasury
- {"action":"sell_resource","resource":"<RES>","amount":<number>} — sell resource for $REAI at market price
- {"action":"sell_land","x":<number>,"y":<number>,"price":<number>} — list your land tile for sale

ECONOMY RULES:
- Everything costs $REAI: claiming land (5-50), building (10-100), attacking (20 stake).
- You earn $REAI from: selling resources, building income (Temples give 1/tick), territory tax, PvP loot.
- If you run out of $REAI, you go idle and cannot act!
- Attacking stakes 20 $REAI. If you KILL the target, you get 50% of their $REAI + inventory + stake back. If they SURVIVE, they keep your 20 $REAI stake.
- Mining on someone else's land costs 20% tax to the land owner.

ALLIANCE RULES:
- Max 5 members. Shared vision, 10% trade discount, collective defense.
- Attacking an ally = BETRAYAL (expelled + lose 50 $REAI).
- If someone proposed an alliance to you, consider accepting if they seem compatible.

KEY RULES:
- FOOD is consumed every 5 ticks. Zero FOOD = lose 5 HP/tick.
- Check BUILDINGS YOU CAN AFFORD before building. Check $REAI balance before claiming/building/attacking.
- Selling surplus resources is a good way to earn $REAI.

Respond ONLY with the JSON action object. No explanation, no markdown, just JSON.`
        },
        {
          role: 'user',
          content: observation,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) {
      const fb = fallbackDecision(agent, agents);
      recordAction(agent.id, fb.type, world.tickCount);
      return fb;
    }

    // Parse JSON action
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      const fb = fallbackDecision(agent, agents);
      recordAction(agent.id, fb.type, world.tickCount);
      return fb;
    }

    const action = JSON.parse(jsonMatch[0]);
    const resolved = resolveAction(action, agent, agents);

    // Record this action in memory
    recordAction(agent.id, resolved.type, world.tickCount);

    // Log notable events for other agents to see
    if (resolved.type === 'attack') {
      const target = agents.find(a => a.id === resolved.targetId);
      logWorldEvent({ type: 'fight', description: `${agent.name} attacked ${target ? target.name : 'someone'}`, x: agent.x, y: agent.y });
    } else if (resolved.type === 'trade') {
      logWorldEvent({ type: 'trade', description: `${agent.name} traded ${resolved.offerResource} for ${resolved.requestResource}`, x: agent.x, y: agent.y });
    }

    console.log(`[AI] ${agent.name} (${agent.strategy}${despLevel !== 'stable' ? '/' + despLevel : ''}) -> ${resolved.type}${resolved.type === 'move' ? ` (${resolved.dx},${resolved.dy})` : resolved.type === 'attack' ? ` target` : resolved.type === 'trade' ? ` ${resolved.offerResource}->${resolved.requestResource}` : resolved.type === 'build' ? ` ${resolved.buildingType}` : ''}`);
    return resolved;

  } catch (err) {
    // Handle rate limiting with key rotation
    if (err.status === 429 && keyRef) {
      markKeyRateLimited(keyRef);
      console.log(`[LLM] Rate limited key for ${agent.name}, rotating...`);
      // Try once more with next available key
      const retry = getAgentClient(agent);
      if (retry.client && retry.keyRef !== keyRef) {
        try {
          const retryCompletion = await retry.client.chat.completions.create({
            model: retry.model, max_tokens: config.LLM_MAX_TOKENS, temperature: 0.9,
            messages: [{ role: 'user', content: 'Pick a simple action: mine, move, or claim. Reply with JSON only.' }],
          });
          const retryRaw = retryCompletion.choices[0]?.message?.content?.trim();
          if (retryRaw) {
            const retryMatch = retryRaw.match(/\{[\s\S]*\}/);
            if (retryMatch) {
              const retryAction = JSON.parse(retryMatch[0]);
              const resolved = resolveAction(retryAction, agent, agents);
              recordAction(agent.id, resolved.type, world.tickCount);
              return resolved;
            }
          }
        } catch {}
      }
    }

    console.error(`[LLM] Decision failed for ${agent.name}:`, err.message);
    const fb = fallbackDecision(agent, agents);
    recordAction(agent.id, fb.type, world.tickCount);
    return fb;
  }
}

// ===== RESOLVE LLM ACTION INTO EXECUTABLE FORMAT =====
function resolveAction(action, agent, agents) {
  switch (action.action) {
    case 'move':
      return { type: 'move', dx: Math.max(-1, Math.min(1, action.dx || 0)), dy: Math.max(-1, Math.min(1, action.dy || 0)) };

    case 'mine':
      return { type: 'mine' };

    case 'trade': {
      const target = agents.find(a => a.alive && a.name === action.targetName);
      if (!target) return fallbackDecision(agent, agents);
      return {
        type: 'trade', targetId: target.id,
        offerResource: action.offer, requestResource: action.request,
        amount: Math.max(1, Math.min(5, action.amount || 1)),
      };
    }

    case 'build':
      return { type: 'build', buildingType: action.type };

    case 'claim':
      return { type: 'claim' };

    case 'attack': {
      const target = agents.find(a => a.alive && a.name === action.targetName);
      if (!target) return fallbackDecision(agent, agents);
      return { type: 'attack', targetId: target.id };
    }

    // ===== NEW ALLIANCE ACTIONS =====
    case 'propose_alliance': {
      const target = agents.find(a => a.alive && a.name === action.targetName);
      if (!target) return fallbackDecision(agent, agents);
      return { type: 'propose_alliance', targetId: target.id };
    }

    case 'accept_alliance':
      return { type: 'accept_alliance' };

    case 'reject_alliance':
      return { type: 'reject_alliance' };

    case 'leave_alliance':
      return { type: 'leave_alliance' };

    case 'contribute_alliance':
      return { type: 'contribute_alliance', amount: Math.max(1, action.amount || 5) };

    // ===== ECONOMY ACTIONS =====
    case 'sell_resource':
      return { type: 'sell_resource', resource: action.resource, amount: Math.max(1, action.amount || 1) };

    case 'sell_land':
      return { type: 'sell_land', x: action.x, y: action.y, price: Math.max(1, action.price || 10) };

    default:
      return fallbackDecision(agent, agents);
  }
}

// ===== HELPER: MOVE TOWARD A TARGET POSITION =====
function moveToward(agent, tx, ty) {
  const dx = Math.sign(tx - agent.x);
  const dy = Math.sign(ty - agent.y);
  // Validate the target tile
  const t = world.getTile(agent.x + dx, agent.y + dy);
  if (t && !world.isWater(t.biome)) {
    return { type: 'move', dx, dy };
  }
  // Try just horizontal or vertical if diagonal is blocked
  if (dx !== 0) {
    const t2 = world.getTile(agent.x + dx, agent.y);
    if (t2 && !world.isWater(t2.biome)) return { type: 'move', dx, dy: 0 };
  }
  if (dy !== 0) {
    const t2 = world.getTile(agent.x, agent.y + dy);
    if (t2 && !world.isWater(t2.biome)) return { type: 'move', dx: 0, dy };
  }
  return randomMove(agent);
}

// ===== HELPER: RANDOM VALID MOVE =====
function randomMove(agent) {
  const dirs = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,1],[-1,1],[1,-1]];
  const valid = dirs.filter(([dx,dy]) => {
    const t = world.getTile(agent.x+dx, agent.y+dy);
    return t && !world.isWater(t.biome);
  });
  if (valid.length) {
    const [dx, dy] = valid[Math.floor(Math.random() * valid.length)];
    return { type: 'move', dx, dy };
  }
  return { type: 'claim' }; // stuck, just claim
}

// ===== HELPER: FIND NEAREST RESOURCE =====
function findNearestResource(agent, resourceType, radius = 5) {
  const nearby = world.getNearbyTiles(agent.x, agent.y, radius);
  let best = null;
  let bestDist = Infinity;
  for (const t of nearby) {
    if (t.resource && t.resourceAmount > 0 && (!resourceType || t.resource === resourceType)) {
      const dist = Math.abs(t.x - agent.x) + Math.abs(t.y - agent.y);
      if (dist > 0 && dist < bestDist) {
        bestDist = dist;
        best = t;
      }
    }
  }
  return best;
}

// ===== HELPER: ATTEMPT TRADE =====
function attemptTrade(agent, nearbyAgents) {
  // Find a valid trade: offer our surplus for something we lack
  const myResources = Object.entries(agent.inventory).filter(([,v]) => v > 2).sort((a,b) => b[1]-a[1]);
  if (myResources.length === 0) return null;

  for (const target of nearbyAgents) {
    if (!target.alive) continue;
    if (Math.abs(target.x - agent.x) > 5 || Math.abs(target.y - agent.y) > 5) continue;

    const theirResources = Object.entries(target.inventory).filter(([,v]) => v > 2).sort((a,b) => b[1]-a[1]);
    for (const [offerRes, offerAmt] of myResources) {
      for (const [reqRes, reqAmt] of theirResources) {
        if (offerRes !== reqRes) {
          const amount = Math.min(3, offerAmt - 1, reqAmt - 1);
          if (amount >= 1) {
            return {
              type: 'trade', targetId: target.id,
              offerResource: offerRes, requestResource: reqRes,
              amount,
            };
          }
        }
      }
    }
  }
  return null;
}

// ===== HELPER: PICK AFFORDABLE BUILDING =====
function pickBuilding(agent, preference = null) {
  const tile = world.getTile(agent.x, agent.y);
  if (!tile || world.isWater(tile.biome) || tile.building) return null;

  const affordable = Object.entries(config.BUILDINGS).filter(([, b]) =>
    Object.entries(b.cost).every(([res, n]) => (agent.inventory[res] || 0) >= n)
  );
  if (affordable.length === 0) return null;

  // Prefer the requested type if affordable
  if (preference) {
    const pref = affordable.find(([k]) => k === preference);
    if (pref) return { type: 'build', buildingType: pref[0] };
  }

  const [bType] = affordable[Math.floor(Math.random() * affordable.length)];
  return { type: 'build', buildingType: bType };
}

// ===== FALLBACK DECISION ENGINE =====
// Strategy-based decisions with high action diversity when no LLM is available
function fallbackDecision(agent, agents) {
  const s = agent.strategy;
  const r = Math.random();
  const tile = world.getTile(agent.x, agent.y);
  const hasResource = tile && tile.resource && tile.resourceAmount > 0;

  const nearby = world.getNearbyTiles(agent.x, agent.y, 5);
  const nearbyAgents = agents.filter(a =>
    a.alive && a.id !== agent.id &&
    Math.abs(a.x - agent.x) <= 5 && Math.abs(a.y - agent.y) <= 5
  );
  const attackTargets = nearbyAgents.filter(a =>
    Math.abs(a.x - agent.x) <= 2 && Math.abs(a.y - agent.y) <= 2 &&
    !(agent.allianceId && agent.allianceId === a.allianceId)
  );

  const despLevel = getDesperationLevel(agent);
  const repCount = getRepetitionCount(agent.id);
  const mem = getMemory(agent.id);

  // Helper: should we avoid repeating?
  const shouldAvoidAction = (actionType) => {
    return repCount >= 3 && mem.lastAction === actionType;
  };

  // ==============================================
  // DESPERATION MODE: overrides normal strategy
  // ==============================================
  if (despLevel === 'critical') {
    // About to die — survival at all costs
    if (hasResource && tile.resource === 'FOOD' && !shouldAvoidAction('mine')) {
      return { type: 'mine' };
    }
    // Look for food nearby
    const foodTile = findNearestResource(agent, 'FOOD', 5);
    if (foodTile) {
      return moveToward(agent, foodTile.x, foodTile.y);
    }
    // Try to trade for food
    const tradeFoodAction = attemptTradeForFood(agent, nearbyAgents);
    if (tradeFoodAction) return tradeFoodAction;
    // Flee from enemies if health is very low
    if (attackTargets.length > 0 && agent.health <= 20) {
      return fleeFrom(agent, attackTargets);
    }
    // Mine anything or move randomly looking for food
    return hasResource ? { type: 'mine' } : randomMove(agent);
  }

  if (despLevel === 'desperate') {
    // In trouble — prioritize food and safety
    if (hasResource && tile.resource === 'FOOD') {
      return { type: 'mine' };
    }
    const foodTile = findNearestResource(agent, 'FOOD', 5);
    if (foodTile && r < 0.7) {
      return moveToward(agent, foodTile.x, foodTile.y);
    }
    const tradeFoodAction = attemptTradeForFood(agent, nearbyAgents);
    if (tradeFoodAction && r < 0.5) return tradeFoodAction;
    // Fall through to normal strategy with some caution
  }

  // ==============================================
  // ANTI-REPETITION: force variety
  // ==============================================
  // If repeating too much, pick a different action category
  const forceVariety = repCount >= 3;

  // ==============================================
  // STRATEGY-SPECIFIC BEHAVIORS
  // ==============================================

  // --- AGGRESSIVE / COMBAT strategies ---
  if (s === 'Warrior' || s === 'Raider' || s === 'Warlord' || s === 'Pirate') {
    // Attack is primary if targets exist
    if (attackTargets.length > 0 && !shouldAvoidAction('attack')) {
      // Warriors attack 55%, Raiders 50%, Warlord 50%, Pirate 50%
      const attackChance = s === 'Warrior' ? 0.55 : 0.50;
      if (r < attackChance) {
        // Pick weakest target for easy kills
        const weakest = attackTargets.sort((a, b) => a.health - b.health)[0];
        logWorldEvent({ type: 'fight', description: `${agent.name} attacks ${weakest.name}`, x: agent.x, y: agent.y });
        return { type: 'attack', targetId: weakest.id };
      }
    }
    // Move toward enemies if none in attack range
    if (nearbyAgents.length > 0 && r < 0.7) {
      const nonAllied = nearbyAgents.filter(a => !(agent.allianceId && agent.allianceId === a.allianceId));
      if (nonAllied.length > 0) {
        const target = nonAllied.sort((a, b) => a.health - b.health)[0];
        return moveToward(agent, target.x, target.y);
      }
    }
    // Build towers if affordable
    if (r < 0.15 && !shouldAvoidAction('build')) {
      const bld = pickBuilding(agent, 'TOWER');
      if (bld) return bld;
    }
    // Claim conquered land
    if (tile && !tile.ownerId && r < 0.2 && !shouldAvoidAction('claim')) {
      return { type: 'claim' };
    }
    // Mine if nothing else
    if (hasResource && r < 0.3 && !shouldAvoidAction('mine')) {
      return { type: 'mine' };
    }
    return randomMove(agent);
  }

  // --- TRADING / DIPLOMATIC strategies ---
  if (s === 'Trader' || s === 'Merchant' || s === 'Diplomat') {
    // Trade is primary
    if (nearbyAgents.length > 0 && !shouldAvoidAction('trade')) {
      const tradeChance = s === 'Merchant' ? 0.50 : s === 'Trader' ? 0.45 : 0.40;
      if (r < tradeChance) {
        const trade = attemptTrade(agent, nearbyAgents);
        if (trade) {
          logWorldEvent({ type: 'trade', description: `${agent.name} trades with someone`, x: agent.x, y: agent.y });
          return trade;
        }
      }
    }
    // Move toward agents if no one in range
    if (nearbyAgents.length === 0 || (forceVariety && mem.lastAction === 'trade')) {
      if (r < 0.5) return randomMove(agent);
    }
    // Build Markets
    if (r < 0.25 && !shouldAvoidAction('build')) {
      const bld = pickBuilding(agent, 'MARKET');
      if (bld) return bld;
    }
    // Mine trade goods
    if (hasResource && r < 0.35 && !shouldAvoidAction('mine')) {
      return { type: 'mine' };
    }
    // Claim peacefully
    if (tile && !tile.ownerId && r < 0.15 && !shouldAvoidAction('claim')) {
      return { type: 'claim' };
    }
    return randomMove(agent);
  }

  // --- EXPANSION / CONQUEST strategies ---
  if (s === 'Expansionist' || s === 'Conqueror') {
    // Claim unclaimed land
    if (tile && !tile.ownerId && !world.isWater(tile.biome) && !shouldAvoidAction('claim')) {
      if (r < (s === 'Conqueror' ? 0.45 : 0.50)) {
        return { type: 'claim' };
      }
    }
    // Conqueror attacks nearby enemies
    if (s === 'Conqueror' && attackTargets.length > 0 && r < 0.35 && !shouldAvoidAction('attack')) {
      const target = attackTargets[Math.floor(Math.random() * attackTargets.length)];
      logWorldEvent({ type: 'fight', description: `${agent.name} attacks ${target.name}`, x: agent.x, y: agent.y });
      return { type: 'attack', targetId: target.id };
    }
    // Move toward unclaimed tiles
    const unclaimedTile = nearby.find(t => !t.ownerId && !world.isWater(t.biome) && (t.x !== agent.x || t.y !== agent.y));
    if (unclaimedTile && r < 0.35) {
      return moveToward(agent, unclaimedTile.x, unclaimedTile.y);
    }
    // Build towers to defend territory
    if (r < 0.15 && !shouldAvoidAction('build')) {
      const bld = pickBuilding(agent, 'TOWER');
      if (bld) return bld;
    }
    // Mine
    if (hasResource && r < 0.2 && !shouldAvoidAction('mine')) {
      return { type: 'mine' };
    }
    return randomMove(agent);
  }

  // --- BUILDER / ARCHITECT strategies ---
  if (s === 'Builder' || s === 'Architect') {
    // Build if possible
    if (!shouldAvoidAction('build')) {
      const preferOrder = s === 'Architect'
        ? ['HOUSE', 'FARM', 'MINE', 'TOWER', 'MARKET', 'TEMPLE']
        : ['FARM', 'HOUSE', 'MINE', 'MARKET', 'TOWER', 'TEMPLE'];
      for (const pref of preferOrder) {
        const bld = pickBuilding(agent, pref);
        if (bld && r < 0.40) return bld;
      }
    }
    // Mine resources for buildings
    if (hasResource && r < 0.35 && !shouldAvoidAction('mine')) {
      return { type: 'mine' };
    }
    // Claim land to build on
    if (tile && !tile.ownerId && r < 0.15 && !shouldAvoidAction('claim')) {
      return { type: 'claim' };
    }
    // Move to resource tiles
    const resTile = findNearestResource(agent, null, 4);
    if (resTile && r < 0.3) {
      return moveToward(agent, resTile.x, resTile.y);
    }
    return randomMove(agent);
  }

  // --- MINING / HOARDING strategies ---
  if (s === 'Miner' || s === 'Hoarder' || s === 'Farmer') {
    const preferResource = s === 'Farmer' ? 'FOOD' : null;
    // Mine current tile
    if (hasResource && !shouldAvoidAction('mine')) {
      if (s === 'Farmer' && tile.resource === 'FOOD') return { type: 'mine' };
      if (s !== 'Farmer' && r < 0.60) return { type: 'mine' };
      if (s === 'Farmer' && r < 0.40) return { type: 'mine' }; // mine non-food sometimes
    }
    // Move to resource tiles
    const resTile = findNearestResource(agent, preferResource, 5);
    if (resTile && r < 0.5) {
      return moveToward(agent, resTile.x, resTile.y);
    }
    // Farmer builds farms
    if (s === 'Farmer' && r < 0.20 && !shouldAvoidAction('build')) {
      const bld = pickBuilding(agent, 'FARM');
      if (bld) return bld;
    }
    // Hoarder builds mines
    if (s === 'Hoarder' && r < 0.15 && !shouldAvoidAction('build')) {
      const bld = pickBuilding(agent, 'MINE');
      if (bld) return bld;
    }
    // Miner builds mines
    if (s === 'Miner' && r < 0.15 && !shouldAvoidAction('build')) {
      const bld = pickBuilding(agent, 'MINE');
      if (bld) return bld;
    }
    // Claim
    if (tile && !tile.ownerId && r < 0.10 && !shouldAvoidAction('claim')) {
      return { type: 'claim' };
    }
    return randomMove(agent);
  }

  // --- EXPLORER / NOMAD strategies ---
  if (s === 'Explorer' || s === 'Nomad') {
    // Move most of the time
    const moveChance = s === 'Nomad' ? 0.75 : 0.65;
    if (r < moveChance && !shouldAvoidAction('move')) {
      return randomMove(agent);
    }
    // Mine briefly while passing through
    if (hasResource && r < 0.15 && !shouldAvoidAction('mine')) {
      return { type: 'mine' };
    }
    // Explorer claims, Nomad does not
    if (s === 'Explorer' && tile && !tile.ownerId && r < 0.15 && !shouldAvoidAction('claim')) {
      return { type: 'claim' };
    }
    // Trade if someone is around
    if (nearbyAgents.length > 0 && r < 0.1) {
      const trade = attemptTrade(agent, nearbyAgents);
      if (trade) return trade;
    }
    return randomMove(agent);
  }

  // --- SCHOLAR / ALCHEMIST / SAGE / ORACLE strategies ---
  if (s === 'Scholar' || s === 'Alchemist') {
    // Prefer rare resources
    if (hasResource && (tile.resource === 'CRYSTAL' || tile.resource === 'GOLD' || tile.resource === 'IRON')) {
      if (!shouldAvoidAction('mine')) return { type: 'mine' };
    }
    // Move toward rare resources
    const rareTile = findNearestResource(agent, 'CRYSTAL', 5) || findNearestResource(agent, 'GOLD', 5);
    if (rareTile && r < 0.40) {
      return moveToward(agent, rareTile.x, rareTile.y);
    }
    // Build temples
    if (r < 0.20 && !shouldAvoidAction('build')) {
      const bld = pickBuilding(agent, 'TEMPLE');
      if (bld) return bld;
    }
    // Trade common for rare
    if (nearbyAgents.length > 0 && r < 0.20) {
      const trade = attemptTrade(agent, nearbyAgents);
      if (trade) return trade;
    }
    // Mine anything
    if (hasResource && r < 0.25 && !shouldAvoidAction('mine')) {
      return { type: 'mine' };
    }
    return randomMove(agent);
  }

  if (s === 'Sage' || s === 'Oracle') {
    const ranking = getAgentRanking(agent, agents);
    // Oracle adapts based on ranking
    if (s === 'Oracle') {
      if (ranking.status === 'FALLING BEHIND' || ranking.status === 'STRUGGLING') {
        // Be more aggressive when behind
        if (attackTargets.length > 0 && r < 0.30) {
          const target = attackTargets.sort((a, b) => a.health - b.health)[0];
          return { type: 'attack', targetId: target.id };
        }
        if (hasResource && r < 0.40) return { type: 'mine' };
      } else {
        // Consolidate when ahead
        if (r < 0.25 && !shouldAvoidAction('build')) {
          const bld = pickBuilding(agent);
          if (bld) return bld;
        }
      }
    }
    // Trade wisely
    if (nearbyAgents.length > 0 && r < 0.30) {
      const trade = attemptTrade(agent, nearbyAgents);
      if (trade) return trade;
    }
    // Build temples
    if (r < 0.15 && !shouldAvoidAction('build')) {
      const bld = pickBuilding(agent, 'TEMPLE');
      if (bld) return bld;
    }
    // Mine
    if (hasResource && r < 0.30 && !shouldAvoidAction('mine')) {
      return { type: 'mine' };
    }
    // Claim peacefully
    if (tile && !tile.ownerId && r < 0.15 && !shouldAvoidAction('claim')) {
      return { type: 'claim' };
    }
    return randomMove(agent);
  }

  // ==============================================
  // DEFAULT FALLBACK (strategies not matched above)
  // ==============================================

  // Generic balanced behavior with anti-repetition
  if (forceVariety) {
    // Force a different action type
    const options = [];
    if (hasResource && mem.lastAction !== 'mine') options.push('mine');
    if (mem.lastAction !== 'move') options.push('move');
    if (tile && !tile.ownerId && mem.lastAction !== 'claim') options.push('claim');
    if (nearbyAgents.length > 0 && mem.lastAction !== 'trade') options.push('trade');
    if (attackTargets.length > 0 && mem.lastAction !== 'attack') options.push('attack');

    const pick = options[Math.floor(Math.random() * options.length)] || 'move';
    switch (pick) {
      case 'mine': return { type: 'mine' };
      case 'claim': return { type: 'claim' };
      case 'trade': {
        const trade = attemptTrade(agent, nearbyAgents);
        if (trade) return trade;
        return randomMove(agent);
      }
      case 'attack': {
        const target = attackTargets[Math.floor(Math.random() * attackTargets.length)];
        return { type: 'attack', targetId: target.id };
      }
      default: return randomMove(agent);
    }
  }

  // Generic balanced
  if (hasResource && r < 0.25) return { type: 'mine' };
  if (tile && !tile.ownerId && r < 0.15) return { type: 'claim' };
  if (nearbyAgents.length > 0 && r < 0.15) {
    const trade = attemptTrade(agent, nearbyAgents);
    if (trade) return trade;
  }
  if (attackTargets.length > 0 && r < 0.10) {
    const target = attackTargets[Math.floor(Math.random() * attackTargets.length)];
    return { type: 'attack', targetId: target.id };
  }
  if (r < 0.60) return randomMove(agent);
  return { type: 'claim' };
}

// ===== HELPER: TRADE SPECIFICALLY FOR FOOD =====
function attemptTradeForFood(agent, nearbyAgents) {
  const myResources = Object.entries(agent.inventory)
    .filter(([k, v]) => k !== 'FOOD' && v > 1)
    .sort((a, b) => b[1] - a[1]);
  if (myResources.length === 0) return null;

  for (const target of nearbyAgents) {
    if (!target.alive) continue;
    if (Math.abs(target.x - agent.x) > 5 || Math.abs(target.y - agent.y) > 5) continue;
    if ((target.inventory.FOOD || 0) > 2) {
      const [offerRes, offerAmt] = myResources[0];
      const amount = Math.min(3, offerAmt - 1, (target.inventory.FOOD || 0) - 1);
      if (amount >= 1) {
        return {
          type: 'trade', targetId: target.id,
          offerResource: offerRes, requestResource: 'FOOD',
          amount,
        };
      }
    }
  }
  return null;
}

// ===== HELPER: FLEE FROM ENEMIES =====
function fleeFrom(agent, enemies) {
  // Calculate average enemy position and move away from it
  let avgX = 0, avgY = 0;
  for (const e of enemies) {
    avgX += e.x;
    avgY += e.y;
  }
  avgX /= enemies.length;
  avgY /= enemies.length;

  // Move in opposite direction
  const fleeX = agent.x + Math.sign(agent.x - avgX);
  const fleeY = agent.y + Math.sign(agent.y - avgY);

  const t = world.getTile(fleeX, fleeY);
  if (t && !world.isWater(t.biome)) {
    return { type: 'move', dx: Math.sign(agent.x - avgX), dy: Math.sign(agent.y - avgY) };
  }
  // If cannot flee directly, try random move
  return randomMove(agent);
}

module.exports = { decideAction, buildObservation };
