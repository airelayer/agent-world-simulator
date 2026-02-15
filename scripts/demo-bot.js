#!/usr/bin/env node
// =============================================================================
//  Agent World Simulator -- External Bot Demo
// =============================================================================
//
//  This script demonstrates how an external agent connects to the Agent World
//  API and plays the game autonomously. It uses ONLY built-in Node.js modules
//  (fetch is available natively in Node 18+).
//
//  Usage:
//    node scripts/demo-bot.js                          # defaults to localhost:3000
//    node scripts/demo-bot.js http://remote-host:3000  # custom server URL
//
//  The bot follows a survival-first strategy:
//    1. Always keep food above a safety threshold (avoid starvation).
//    2. Mine any resource found on the current tile.
//    3. Claim unclaimed territory when possible.
//    4. Explore toward resource-rich tiles visible in its surroundings.
//    5. Trade with nearby agents when it has surplus of one resource.
//    6. Build structures when it has accumulated enough materials.
//    7. Attack weak hostile agents that wander too close.
//
//  Every decision is logged with its reasoning so you can follow along.
// =============================================================================

const API_BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '') + '/api';
const TICK_MS  = 5000; // How often the bot acts (matches server tick interval)

// ---------------------------------------------------------------------------
//  Utility: pretty-print a JSON response from the API
// ---------------------------------------------------------------------------
function prettyJson(obj) {
  return JSON.stringify(obj, null, 2);
}

// ---------------------------------------------------------------------------
//  Utility: colored console output for readability
// ---------------------------------------------------------------------------
const LOG_PREFIX = '[DemoBot]';

function log(msg, data) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `${ts} ${LOG_PREFIX} ${msg}`;
  if (data !== undefined) {
    console.log(line, typeof data === 'object' ? prettyJson(data) : data);
  } else {
    console.log(line);
  }
}

function logAction(action, reason) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} ${LOG_PREFIX} ACTION  => ${JSON.stringify(action)}`);
  console.log(`${ts} ${LOG_PREFIX} REASON  => ${reason}`);
}

function logError(msg, err) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`${ts} ${LOG_PREFIX} ERROR: ${msg}`, err?.message || err || '');
}

// ---------------------------------------------------------------------------
//  API helpers -- thin wrappers around fetch
// ---------------------------------------------------------------------------

/**
 * Register a new agent with the server.
 * Returns { agent: { id, apiKey, walletAddress, ... }, instructions: { ... } }
 */
async function registerAgent(name, strategy, customPrompt) {
  const res = await fetch(`${API_BASE}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, strategy, customPrompt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Registration failed (${res.status}): ${body.error || res.statusText}`);
  }
  return res.json();
}

/**
 * Observe: fetch our agent's full state including private data (nearby tiles,
 * nearby agents). Requires the X-API-Key header we received at registration.
 */
async function observe(agentId, apiKey) {
  const res = await fetch(`${API_BASE}/agents/${agentId}`, {
    headers: { 'X-API-Key': apiKey },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Observe failed (${res.status}): ${body.error || res.statusText}`);
  }
  return res.json();
}

/**
 * Act: send an action to the server on behalf of our agent.
 * action is an object like { type: 'move', dx: 1, dy: 0 }
 */
async function act(agentId, apiKey, action) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Action failed (${res.status}): ${body.error || res.statusText}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
//  Decision engine -- the brain of the bot
// ---------------------------------------------------------------------------

// Resources that can be mined from tiles
const ALL_RESOURCES = ['WOOD', 'STONE', 'GOLD', 'FOOD', 'IRON', 'CRYSTAL'];

// Building recipes (mirrored from server config for decision-making)
const BUILDINGS = {
  FARM:   { cost: { WOOD: 3, FOOD: 2 },   priority: 1 }, // farms produce food over time
  HOUSE:  { cost: { WOOD: 5, STONE: 3 },   priority: 2 },
  MINE:   { cost: { WOOD: 4, IRON: 2 },    priority: 3 },
  MARKET: { cost: { WOOD: 6, GOLD: 3 },    priority: 4 },
  TOWER:  { cost: { STONE: 8, IRON: 4 },   priority: 5 },
  TEMPLE: { cost: { STONE: 10, CRYSTAL: 5, GOLD: 5 }, priority: 6 },
};

// Water biomes that block movement
const WATER_BIOMES = new Set(['deepWater', 'water', 'shallowWater']);

// Track recent positions to avoid getting stuck in loops
const positionHistory = [];
const MAX_HISTORY = 12;

/**
 * Core decision function. Given the full state of our agent (including nearby
 * tiles and nearby agents), decide what action to take and why.
 *
 * Returns { action: Object, reason: String }
 */
function decide(state) {
  const inv   = state.inventory || {};
  const tiles = state.nearbyTiles || [];
  const nearby = state.nearbyAgents || [];
  const myX = state.x;
  const myY = state.y;

  // Record position for loop detection
  positionHistory.push(`${myX},${myY}`);
  if (positionHistory.length > MAX_HISTORY) positionHistory.shift();

  // ------ Find the tile we're standing on ------
  const currentTile = tiles.find(t => t.x === myX && t.y === myY);

  // =====================================================================
  //  Priority 1: MINE if standing on a resource
  // =====================================================================
  //  Mining is always valuable -- resources are the foundation of everything.
  if (currentTile && currentTile.resource && currentTile.resourceAmount > 0) {
    return {
      action: { type: 'mine' },
      reason: `Standing on ${currentTile.resource} (amount: ${currentTile.resourceAmount}) -- mining it`,
    };
  }

  // =====================================================================
  //  Priority 2: CLAIM unclaimed land
  // =====================================================================
  //  If the tile we're on is unclaimed, grab it for free territory points.
  if (currentTile && currentTile.ownerId === null) {
    return {
      action: { type: 'claim' },
      reason: `Tile (${myX},${myY}) is unclaimed -- claiming territory`,
    };
  }

  // =====================================================================
  //  Priority 3: BUILD if we have enough resources
  // =====================================================================
  //  Check each building type in priority order. Only build if the current
  //  tile has no building already and is land we own.
  if (currentTile && !currentTile.building && currentTile.ownerId === state.id) {
    for (const [type, spec] of Object.entries(BUILDINGS)) {
      const canAfford = Object.entries(spec.cost).every(
        ([res, cost]) => (inv[res] || 0) >= cost
      );
      if (canAfford) {
        return {
          action: { type: 'build', buildingType: type },
          reason: `Can afford ${type} (cost: ${JSON.stringify(spec.cost)}) and standing on own empty tile`,
        };
      }
    }
  }

  // =====================================================================
  //  Priority 4: ATTACK a weak nearby enemy
  // =====================================================================
  //  If there's a low-health agent within attack range (2 tiles) and they
  //  are not our ally, take a shot. We only attack if we're reasonably
  //  healthy ourselves.
  if (state.health >= 50 && nearby.length > 0) {
    const attackable = nearby
      .filter(a => {
        if (!a.alive) return false;
        // Don't attack alliance mates
        if (state.allianceId && a.allianceId === state.allianceId) return false;
        // Must be within attack range (2 tiles)
        if (Math.abs(a.x - myX) > 2 || Math.abs(a.y - myY) > 2) return false;
        // Only attack if they look weak
        return a.health <= 40;
      })
      .sort((a, b) => a.health - b.health); // weakest first

    if (attackable.length > 0) {
      const target = attackable[0];
      return {
        action: { type: 'attack', targetId: target.id },
        reason: `Attacking weakened ${target.name} (hp: ${target.health}) at (${target.x},${target.y})`,
      };
    }
  }

  // =====================================================================
  //  Priority 5: TRADE with a nearby agent
  // =====================================================================
  //  If we have surplus (>= 5) of one resource and a neighbor has surplus
  //  of a resource we need, propose a 1:1 trade.
  if (nearby.length > 0) {
    // Find our most abundant non-FOOD resource
    const surplus = ALL_RESOURCES
      .filter(r => (inv[r] || 0) >= 5)
      .sort((a, b) => (inv[b] || 0) - (inv[a] || 0));

    if (surplus.length > 0) {
      for (const neighbor of nearby) {
        if (!neighbor.alive) continue;
        if (Math.abs(neighbor.x - myX) > 5 || Math.abs(neighbor.y - myY) > 5) continue;

        // What do they have that we lack?
        const theirInv = neighbor.inventory || {};
        for (const offerRes of surplus) {
          for (const wantRes of ALL_RESOURCES) {
            if (wantRes === offerRes) continue;
            if ((inv[wantRes] || 0) >= 5) continue;          // we don't need it
            if ((theirInv[wantRes] || 0) < 2) continue;       // they don't have it
            if ((theirInv[offerRes] || 0) >= 10) continue;     // they don't need ours

            return {
              action: {
                type: 'trade',
                targetId: neighbor.id,
                offerResource: offerRes,
                requestResource: wantRes,
                amount: 2,
              },
              reason: `Trading 2 ${offerRes} (have ${inv[offerRes]}) with ${neighbor.name} for 2 ${wantRes} (have ${inv[wantRes] || 0})`,
            };
          }
        }
      }
    }
  }

  // =====================================================================
  //  Priority 6: MOVE toward a resource-rich tile
  // =====================================================================
  //  Scan nearby tiles for resources and pick the closest one. If nothing
  //  interesting is nearby, wander in a random direction. Avoid water and
  //  try not to revisit the same tiles repeatedly (loop avoidance).

  // Score each nearby tile based on how desirable it is to move there
  const candidates = tiles
    .filter(t => {
      // Must not be our current position
      if (t.x === myX && t.y === myY) return false;
      // Must be walkable (not water)
      if (WATER_BIOMES.has(t.biome)) return false;
      // Must be reachable in one step (adjacent including diagonals)
      if (Math.abs(t.x - myX) > 1 || Math.abs(t.y - myY) > 1) return false;
      return true;
    })
    .map(t => {
      let score = 0;

      // Resources are highly attractive
      if (t.resource && t.resourceAmount > 0) {
        score += 10;
        // Prioritize FOOD when running low
        if (t.resource === 'FOOD' && (inv.FOOD || 0) < 4) score += 20;
        // Bonus for rare resources
        if (t.resource === 'CRYSTAL' || t.resource === 'GOLD') score += 5;
      }

      // Unclaimed land is attractive
      if (t.ownerId === null) score += 3;

      // Penalize recently visited positions (loop avoidance)
      const posKey = `${t.x},${t.y}`;
      const timesVisited = positionHistory.filter(p => p === posKey).length;
      score -= timesVisited * 4;

      return { tile: t, score, dx: t.x - myX, dy: t.y - myY };
    })
    .sort((a, b) => b.score - a.score);

  if (candidates.length > 0) {
    const best = candidates[0];
    let reason;
    if (best.tile.resource && best.tile.resourceAmount > 0) {
      reason = `Moving toward ${best.tile.resource} at (${best.tile.x},${best.tile.y})`;
    } else if (best.tile.ownerId === null) {
      reason = `Moving to unclaimed tile (${best.tile.x},${best.tile.y})`;
    } else {
      reason = `Exploring toward (${best.tile.x},${best.tile.y}) [biome: ${best.tile.biome}]`;
    }

    return {
      action: { type: 'move', dx: best.dx, dy: best.dy },
      reason,
    };
  }

  // Fallback: random walk (should rarely happen -- only if surrounded by water)
  const dx = Math.floor(Math.random() * 3) - 1; // -1, 0, or 1
  const dy = Math.floor(Math.random() * 3) - 1;
  return {
    action: { type: 'move', dx, dy },
    reason: 'No interesting tiles visible -- random exploration',
  };
}

// ---------------------------------------------------------------------------
//  Main game loop
// ---------------------------------------------------------------------------

async function main() {
  log('='.repeat(60));
  log('  Agent World Simulator -- External Bot Demo');
  log(`  Connecting to: ${API_BASE}`);
  log('='.repeat(60));

  // -- Step 1: Register our agent with a unique name ----------------------
  const botName = `ExternalBot-${Math.random().toString(36).slice(2, 8)}`;
  const strategy = 'Resourceful Survivor';
  const customPrompt = [
    'I am an autonomous external bot connected via the REST API.',
    'My priorities: gather resources, avoid starvation, expand territory,',
    'build structures, and trade with neighbors when beneficial.',
    'I prefer diplomacy over combat but will attack weakened enemies.',
  ].join(' ');

  log(`Registering as "${botName}" with strategy "${strategy}"...`);

  let agentId, apiKey;
  try {
    const regResult = await registerAgent(botName, strategy, customPrompt);
    agentId = regResult.agent.id;
    apiKey  = regResult.agent.apiKey;

    log('Registration successful!');
    log('  Agent ID:       ' + agentId);
    log('  API Key:        ' + apiKey.slice(0, 12) + '...');
    log('  Wallet:         ' + regResult.agent.walletAddress);
    log('  Spawn position: (' + regResult.agent.x + ',' + regResult.agent.y + ')');
    log('');
    log('API instructions returned by server:', regResult.instructions);
    log('');
  } catch (err) {
    logError('Failed to register. Is the server running?', err);
    process.exit(1);
  }

  // -- Step 2: Game loop -- observe, decide, act --------------------------
  let tickCount = 0;

  async function tick() {
    tickCount++;
    log(`--- Tick #${tickCount} ---`);

    // 2a. Observe: get our full agent state with private data
    let state;
    try {
      state = await observe(agentId, apiKey);
    } catch (err) {
      logError('Observation failed, skipping tick', err);
      return;
    }

    // Check if we're still alive
    if (!state.alive) {
      log('Agent has died! Game over.');
      log(`Final stats: wealth=${state.wealth}, territory=${state.territory}, ` +
          `buildings=${state.buildingsCount}, kills=${state.kills}`);
      log('Inventory:', state.inventory);
      clearInterval(loopHandle);
      return;
    }

    // Log current status
    log(`Position: (${state.x},${state.y})  HP: ${state.health}/${state.maxHealth}  ` +
        `Wealth: ${state.wealth}  Territory: ${state.territory}`);
    log(`Inventory: ${formatInventory(state.inventory)}`);
    log(`Nearby tiles: ${(state.nearbyTiles || []).length}  ` +
        `Nearby agents: ${(state.nearbyAgents || []).map(a => a.name).join(', ') || 'none'}`);

    // 2b. Decide what to do
    const decision = decide(state);
    logAction(decision.action, decision.reason);

    // 2c. Act: send the chosen action to the server
    try {
      const result = await act(agentId, apiKey, decision.action);
      log('Result:', result);
    } catch (err) {
      logError('Action failed', err);
    }

    log(''); // blank line between ticks for readability
  }

  // Format inventory as a compact readable string
  function formatInventory(inv) {
    return Object.entries(inv || {})
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}:${v}`)
      .join('  ') || '(empty)';
  }

  // Run first tick immediately, then every TICK_MS
  await tick();
  const loopHandle = setInterval(tick, TICK_MS);

  // -- Graceful shutdown ---------------------------------------------------
  process.on('SIGINT', () => {
    log('');
    log('Shutting down gracefully (Ctrl+C)...');
    clearInterval(loopHandle);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('Received SIGTERM, stopping...');
    clearInterval(loopHandle);
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
//  Entrypoint
// ---------------------------------------------------------------------------
main().catch(err => {
  logError('Unhandled error in main()', err);
  process.exit(1);
});
