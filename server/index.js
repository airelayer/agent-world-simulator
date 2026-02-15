const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const cors = require('cors');
const config = require('./config');
const db = require('./db');
const world = require('./world');
const agents = require('./agents');
const blockchain = require('./blockchain');
const llm = require('./llm');
const economy = require('./economy');
const apiRouter = require('./api');

const app = express();
const server = http.createServer(app);

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

const websitePath = path.join(__dirname, '..', 'website');
const appPath = path.join(__dirname, '..', 'public');

// ===== API ROUTES =====
app.use('/api', apiRouter);

// Relayer AI website at root
app.use(express.static(websitePath));

// Agent World app at /app
app.use('/app', express.static(appPath));

// SPA fallback for Agent World
app.get('/app*', (req, res) => {
  res.sendFile(path.join(appPath, 'index.html'));
});

// ===== WEBSOCKET =====
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`[WS] Client connected (total: ${wsClients.size})`);

  // Send initial state
  const meta = world.getWorldMeta();
  const allAgents = agents.getAllAgents().map(a => agents.getAgentPublicData(a));
  ws.send(JSON.stringify({ type: 'init', meta, agents: allAgents }));

  ws.on('close', () => {
    wsClients.delete(ws);
  });

  ws.on('error', () => {
    wsClients.delete(ws);
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch {}
    }
  }
}

// ===== SIMULATION TICK =====
let tickRunning = false;
let agentRoundRobin = 0;

async function simulationTick() {
  if (tickRunning) return;
  tickRunning = true;

  try {
    await world.incrementTick();
    const meta = world.getWorldMeta();
    const aliveAgents = agents.getAliveAgents();

    // ===== HUNGER (every 5 ticks) =====
    if (meta.tickCount % 5 === 0) {
      for (const agent of aliveAgents) {
        await agents.processHunger(agent);
      }
    }

    // ===== BUILDING INCOME (every tick) =====
    await economy.processBuildingIncome(meta.tickCount);

    // ===== TOWER FEES (every 3 ticks) =====
    if (meta.tickCount % 3 === 0) {
      await economy.chargeTowerFees(aliveAgents, meta.tickCount);
    }

    // ===== ALLIANCE PROPOSAL EXPIRY =====
    await agents.expireProposals();

    // ===== BRAIN FEE + IDLE CHECK for non-builtin platform agents =====
    for (const agent of aliveAgents) {
      if (!agent.isBuiltin && agent.llmMode === 'platform') {
        await agents.checkIdleStatus(agent);
      }
    }

    // ===== LLM DECISIONS — stagger 3 per tick (round-robin) =====
    const activeAgents = agents.getAliveAgents().filter(a => !a.idle);
    const builtinAgents = activeAgents.filter(a => a.isBuiltin);
    const allAgentsList = agents.getAllAgents();
    const AGENTS_PER_TICK = 3;

    const tickBatch = [];
    for (let i = 0; i < AGENTS_PER_TICK && builtinAgents.length > 0; i++) {
      const idx = (agentRoundRobin + i) % builtinAgents.length;
      tickBatch.push(builtinAgents[idx]);
    }
    agentRoundRobin = (agentRoundRobin + AGENTS_PER_TICK) % Math.max(1, builtinAgents.length);

    // Also include active non-builtin agents (user agents that aren't idle)
    const userActiveAgents = activeAgents.filter(a => !a.isBuiltin);
    for (const agent of userActiveAgents) {
      // Charge brain fee for platform LLM users
      if (agent.llmMode === 'platform') {
        const feeResult = await economy.chargeBrainFee(agent.id, meta.tickCount);
        if (!feeResult.success) continue; // Went idle
        agent.xyzBalance = feeResult.balance;
      }
      tickBatch.push(agent);
    }

    // Call LLM for this tick's batch (sequential to avoid rate limits)
    for (const agent of tickBatch) {
      if (!agent.alive || agent.idle) continue;
      try {
        const decision = await llm.decideAction(agent, allAgentsList);
        await executeAgentAction(agent, decision);
        // Sync balance after action
        await agents.syncBalance(agent);
      } catch (err) {
        console.error(`[TICK] Error for ${agent.name}:`, err.message);
      }
    }

    // ===== ALLIANCE COUNTER-ATTACKS (queued from previous attacks) =====
    await agents.processCounterAttacks();

    // ===== LEADERBOARD REWARDS (every epoch) =====
    if (meta.tickCount % config.ECONOMY.EPOCH_TICKS === 0 && meta.tickCount > 0) {
      const rewards = await economy.distributeLeaderboardRewards(agents.getAliveAgents(), meta.tickCount);
      if (rewards.length > 0) {
        const rewardStr = rewards.map(r => `#${r.rank} ${r.name}: +${r.reward} $REAI`).join(', ');
        await world.addActivity('leaderboard', `Epoch rewards: ${rewardStr}`);
        console.log(`[EPOCH] Leaderboard rewards: ${rewardStr}`);
      }
    }

    // Settlement runs on its own 10-minute interval (see below), not per-tick

    // ===== BROADCAST to all WebSocket clients =====
    const updatedAgents = agents.getAllAgents().map(a => agents.getAgentPublicData(a));
    const activities = await world.getRecentActivities(15);
    const prices = await world.getMarketPrices();
    const chainStats = await blockchain.getOnChainStats();
    const recentTxns = await blockchain.getRecentTransactions(10);
    const alliances = await agents.getAlliances();

    broadcast({
      type: 'tick',
      meta: world.getWorldMeta(),
      agents: updatedAgents,
      activities,
      marketPrices: prices,
      chainStats,
      transactions: recentTxns,
      alliances,
    });

  } catch (err) {
    console.error('[TICK] Error:', err);
  } finally {
    tickRunning = false;
  }
}

async function executeAgentAction(agent, decision) {
  switch (decision.type) {
    case 'move':
      await agents.moveAgent(agent, decision.dx || 0, decision.dy || 0);
      break;
    case 'mine':
      await agents.mineResource(agent);
      break;
    case 'trade':
      await agents.executeTrade(agent, decision.targetId, decision.offerResource, decision.requestResource, decision.amount);
      break;
    case 'build':
      await agents.buildStructure(agent, decision.buildingType);
      break;
    case 'claim':
      await agents.claimLand(agent);
      break;
    case 'attack':
      await agents.attackAgent(agent, decision.targetId);
      break;
    case 'propose_alliance':
      await agents.proposeAlliance(agent, decision.targetId);
      break;
    case 'accept_alliance':
      await agents.acceptAlliance(agent);
      break;
    case 'reject_alliance':
      await agents.rejectAlliance(agent);
      break;
    case 'leave_alliance':
      await agents.leaveAlliance(agent);
      break;
    case 'contribute_alliance':
      await agents.contributeAlliance(agent, decision.amount || 5);
      break;
    case 'sell_resource':
      await agents.sellResource(agent, decision.resource, decision.amount || 1);
      break;
    case 'sell_land':
      await agents.sellLand(agent, decision.x, decision.y, decision.price || 10);
      break;
  }
}

// ===== STARTUP =====
async function start() {
  console.log('========================================');
  console.log('  AGENT WORLD — Moltiverse on Monad');
  console.log('========================================');

  // Init database
  await db.init();

  // Generate or load world
  await world.generateWorld();

  // Load existing agents
  await agents.loadAgents();

  // Spawn built-in agents if needed
  await agents.spawnBuiltinAgents(10);

  // Check master wallet
  if (config.MASTER_PRIVATE_KEY) {
    const wallet = blockchain.getMasterWallet();
    if (wallet) {
      const balance = await blockchain.getBalance(wallet.address);
      console.log(`[CHAIN] Master wallet: ${wallet.address}`);
      console.log(`[CHAIN] Balance: ${balance} MON`);
    }
  } else {
    console.log('[CHAIN] No master wallet configured (on-chain features disabled)');
  }

  // Economy info
  console.log(`[ECONOMY] Deploy deposit: ${config.ECONOMY.DEPLOY_DEPOSIT} $REAI`);
  console.log(`[ECONOMY] Brain fee: ${config.ECONOMY.BRAIN_FEE_PER_TICK} $REAI/tick`);
  console.log(`[ECONOMY] Attack stake: ${config.ECONOMY.ATTACK_STAKE} $REAI`);
  console.log(`[ECONOMY] Epoch rewards every ${config.ECONOMY.EPOCH_TICKS} ticks`);

  // Start tick loop
  const tickInterval = setInterval(simulationTick, config.TICK_INTERVAL);
  console.log(`[SIM] Tick interval: ${config.TICK_INTERVAL}ms`);

  // Start on-chain settlement every 10 minutes
  const SETTLEMENT_INTERVAL = 10 * 60 * 1000; // 10 minutes
  const settlementInterval = setInterval(async () => {
    try {
      console.log('[SETTLE] Running scheduled on-chain settlement...');
      const result = await blockchain.settleAgentBalances();
      if (result.settled > 0) {
        await world.addActivity('settlement', `On-chain settlement: ${result.settled} agents settled`);
      }
    } catch (err) {
      console.error('[SETTLE] Settlement failed:', err.message);
    }
  }, SETTLEMENT_INTERVAL);
  console.log(`[SETTLE] On-chain settlement every 10 minutes`);

  // Start server
  server.listen(config.PORT, config.HOST, () => {
    console.log(`[SERVER] Running at http://localhost:${config.PORT}`);
    console.log(`[WS] WebSocket at ws://localhost:${config.PORT}/ws`);
    console.log(`[API] REST API at http://localhost:${config.PORT}/api`);
    console.log('========================================');
    console.log(`  Ready! Open http://localhost:${config.PORT}`);
    console.log('========================================');
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Saving state...');
    clearInterval(tickInterval);
    clearInterval(settlementInterval);
    await db.setState('epoch', world.getWorldMeta().epoch);
    await db.setState('tickCount', world.getWorldMeta().tickCount);
    await db.setState('txnCount', world.getWorldMeta().txnCount);
    await db.setState('tradeCount', world.getWorldMeta().tradeCount);
    process.exit(0);
  });
}

start().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
