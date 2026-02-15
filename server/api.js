const express = require('express');
const config = require('./config');
const world = require('./world');
const agents = require('./agents');
const blockchain = require('./blockchain');
const economy = require('./economy');
const auth = require('./auth');

const router = express.Router();

// ===== AUTH ENDPOINTS =====

// POST /api/auth/nonce — get nonce for wallet signature
router.post('/auth/nonce', async (req, res) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' });

    const user = await auth.getOrCreateUser(walletAddress);
    const message = auth.getSignMessage(user.nonce);
    res.json({ nonce: user.nonce, message, isNew: user.isNew });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/verify — verify signature and get session token
router.post('/auth/verify', async (req, res) => {
  try {
    const { walletAddress, signature } = req.body;
    if (!walletAddress || !signature) {
      return res.status(400).json({ error: 'walletAddress and signature required' });
    }

    const result = await auth.verifySignature(walletAddress, signature);
    if (!result.success) return res.status(401).json({ error: result.reason });

    // Get user's agents
    const userAgents = await auth.getUserAgents(walletAddress);

    res.json({
      sessionToken: result.sessionToken,
      userId: result.userId,
      walletAddress: result.walletAddress,
      agentCount: userAgents.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/session — check current session
router.get('/auth/session', async (req, res) => {
  const session = req.headers['x-session-token'];
  if (!session) return res.json({ authenticated: false });

  const user = await auth.verifySession(session);
  if (!user) return res.json({ authenticated: false });

  res.json({ authenticated: true, ...user });
});

// ===== WORLD ENDPOINTS =====

router.get('/world/state', async (req, res) => {
  try {
    const meta = world.getWorldMeta();
    const tiles = world.getWorldSnapshot();
    const allAgents = agents.getAllAgents().map(a => agents.getAgentPublicData(a));
    const prices = await world.getMarketPrices();
    const alliances = await agents.getAlliances();

    res.json({ meta, tiles, agents: allAgents, marketPrices: prices, alliances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/world/meta', (req, res) => {
  res.json(world.getWorldMeta());
});

router.get('/world/nearby/:x/:y', (req, res) => {
  const x = parseInt(req.params.x);
  const y = parseInt(req.params.y);
  const radius = parseInt(req.query.radius || '5');
  const tiles = world.getNearbyTiles(x, y, Math.min(radius, 10));
  const nearbyAgents = agents.getAliveAgents()
    .filter(a => Math.abs(a.x - x) <= radius && Math.abs(a.y - y) <= radius)
    .map(a => agents.getAgentPublicData(a));
  res.json({ tiles, agents: nearbyAgents });
});

router.get('/market/prices', async (req, res) => {
  const prices = await world.getMarketPrices();
  res.json(prices);
});

// ===== AGENT ENDPOINTS =====

// POST /api/agents/register — register a new agent
router.post('/agents/register', async (req, res) => {
  try {
    const { name, strategy, emoji, color, webhookUrl, customPrompt, llmMode, llmKeys, depositAmount } = req.body;
    if (!name || name.length < 2 || name.length > 32) {
      return res.status(400).json({ error: 'Name must be 2-32 characters' });
    }

    // Check name uniqueness
    const existing = agents.getAllAgents().find(a => a.name.toLowerCase() === name.toLowerCase());
    if (existing) return res.status(400).json({ error: 'Agent name already taken' });

    // Get owner address from session if authenticated
    let ownerAddress = null;
    const session = req.headers['x-session-token'];
    if (session) {
      const user = await auth.verifySession(session);
      if (user) ownerAddress = user.walletAddress;
    }

    const result = await agents.registerAgent({
      name, strategy, emoji, color, webhookUrl, customPrompt,
      ownerAddress,
      llmMode: llmMode || 'platform',
      llmKeys: llmKeys || null,
      depositAmount: depositAmount || config.ECONOMY.DEPLOY_DEPOSIT,
    });

    res.json({
      message: 'Agent registered successfully',
      agent: result,
      instructions: {
        observe: `GET /api/agents/${result.id}`,
        act: `POST /api/agents/${result.id}/action`,
        auth: `Include header: X-API-Key: ${result.apiKey}`,
        websocket: 'Connect to ws://host:port/ws for live updates',
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agents — list all agents
router.get('/agents', (req, res) => {
  const all = agents.getAllAgents().map(a => agents.getAgentPublicData(a));
  res.json(all);
});

// GET /api/agents/:id — single agent detail
router.get('/agents/:id', (req, res) => {
  const agent = agents.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const data = agents.getAgentPublicData(agent);

  // If authenticated with API key, include private data
  const apiKey = req.headers['x-api-key'];
  if (apiKey && agent.apiKey === apiKey) {
    data.apiKey = agent.apiKey;
    data.walletPrivateKey = agent.walletPrivateKey;
    data.nearbyTiles = world.getNearbyTiles(agent.x, agent.y, 5);
    data.nearbyAgents = agents.getAliveAgents()
      .filter(a => a.id !== agent.id && Math.abs(a.x - agent.x) <= 5 && Math.abs(a.y - agent.y) <= 5)
      .map(a => agents.getAgentPublicData(a));
  }

  res.json(data);
});

// POST /api/agents/:id/action — submit action
router.post('/agents/:id/action', async (req, res) => {
  try {
    const agent = agents.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!agent.alive) return res.status(400).json({ error: 'Agent is dead' });
    if (agent.idle) return res.status(400).json({ error: 'Agent is idle (0 $REAI). Top up to resume.' });

    const apiKey = req.headers['x-api-key'];
    if (!apiKey || agent.apiKey !== apiKey) {
      return res.status(401).json({ error: 'Invalid API key. Include X-API-Key header.' });
    }

    const { action } = req.body;
    if (!action) return res.status(400).json({ error: 'Missing action field' });

    let result;
    const actionType = action.type || action.action || action;

    switch (actionType) {
      case 'move':
        result = await agents.moveAgent(agent, action.dx || 0, action.dy || 0);
        break;
      case 'mine':
        result = await agents.mineResource(agent);
        break;
      case 'trade':
        result = await agents.executeTrade(agent, action.targetId, action.offerResource || action.offer, action.requestResource || action.request, action.amount || 1);
        break;
      case 'build':
        result = await agents.buildStructure(agent, action.buildingType || action.type);
        break;
      case 'claim':
        result = await agents.claimLand(agent);
        break;
      case 'attack':
        result = await agents.attackAgent(agent, action.targetId);
        break;
      case 'propose_alliance': {
        const target = action.targetId || (action.targetName && agents.getAgentByName(action.targetName)?.id);
        result = await agents.proposeAlliance(agent, target);
        break;
      }
      case 'accept_alliance':
        result = await agents.acceptAlliance(agent);
        break;
      case 'reject_alliance':
        result = await agents.rejectAlliance(agent);
        break;
      case 'leave_alliance':
        result = await agents.leaveAlliance(agent);
        break;
      case 'contribute_alliance':
        result = await agents.contributeAlliance(agent, action.amount || 5);
        break;
      case 'sell_resource':
        result = await agents.sellResource(agent, action.resource, action.amount || 1);
        break;
      case 'sell_land':
        result = await agents.sellLand(agent, action.x, action.y, action.price || 10);
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${actionType}` });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/:id/topup — top up agent $REAI balance
router.post('/agents/:id/topup', async (req, res) => {
  try {
    const agent = agents.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Verify ownership
    const session = req.headers['x-session-token'];
    const apiKey = req.headers['x-api-key'];
    let authorized = false;

    if (apiKey && agent.apiKey === apiKey) authorized = true;
    if (session) {
      const user = await auth.verifySession(session);
      if (user && agent.ownerAddress === user.walletAddress) authorized = true;
    }

    if (!authorized) return res.status(401).json({ error: 'Not authorized' });

    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });

    const result = await agents.topUp(agent.id, amount);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/:id/withdraw — withdraw MON from agent wallet to owner
router.post('/agents/:id/withdraw', async (req, res) => {
  try {
    const agent = agents.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Verify ownership
    const session = req.headers['x-session-token'];
    const apiKey = req.headers['x-api-key'];
    let authorized = false;
    let ownerAddr = null;

    if (apiKey && agent.apiKey === apiKey) { authorized = true; ownerAddr = agent.ownerAddress; }
    if (session) {
      const user = await auth.verifySession(session);
      if (user && agent.ownerAddress === user.walletAddress) { authorized = true; ownerAddr = user.walletAddress; }
    }

    if (!authorized) return res.status(401).json({ error: 'Not authorized' });

    const { toAddress, amount } = req.body;
    const dest = toAddress || ownerAddr;
    if (!dest) return res.status(400).json({ error: 'No destination address. Provide toAddress or connect wallet.' });

    // Send MON from agent wallet
    const result = await blockchain.withdrawFromAgent(agent.walletPrivateKey, dest, amount);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agents/:id/export — export agent wallet private key (requires auth)
router.get('/agents/:id/export', async (req, res) => {
  try {
    const agent = agents.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const session = req.headers['x-session-token'];
    const apiKey = req.headers['x-api-key'];
    let authorized = false;

    if (apiKey && agent.apiKey === apiKey) authorized = true;
    if (session) {
      const user = await auth.verifySession(session);
      if (user && agent.ownerAddress === user.walletAddress) authorized = true;
    }

    if (!authorized) return res.status(401).json({ error: 'Not authorized' });

    res.json({
      walletAddress: agent.walletAddress,
      privateKey: agent.walletPrivateKey,
      warning: 'Keep this private key safe. Anyone with it can access your agent wallet funds.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agents/:id/financials — detailed P&L
router.get('/agents/:id/financials', async (req, res) => {
  try {
    const financials = await economy.getAgentFinancials(req.params.id);
    if (!financials) return res.status(404).json({ error: 'Agent not found' });
    res.json(financials);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== DASHBOARD ENDPOINTS =====

// GET /api/dashboard — user's dashboard (requires auth)
router.get('/dashboard', async (req, res) => {
  try {
    const session = req.headers['x-session-token'];
    if (!session) return res.status(401).json({ error: 'Auth required' });

    const user = await auth.verifySession(session);
    if (!user) return res.status(401).json({ error: 'Invalid session' });

    // Get user's agents
    const userAgentRows = await auth.getUserAgents(user.walletAddress);
    const userAgents = userAgentRows.map(r => {
      const agent = agents.getAgent(r.id);
      return agent ? {
        ...agents.getAgentPublicData(agent),
        xyzBalance: agent.xyzBalance,
        totalDeposited: agent.totalDeposited,
        totalEarned: agent.totalEarned,
        totalSpent: agent.totalSpent,
        roi: agent.totalEarned - agent.totalSpent,
        roiPct: agent.totalDeposited > 0
          ? ((agent.totalEarned - agent.totalSpent) / agent.totalDeposited * 100).toFixed(1)
          : '0',
        llmMode: agent.llmMode,
      } : null;
    }).filter(Boolean);

    // Get user's alliances
    const allianceIds = [...new Set(userAgents.filter(a => a.allianceId).map(a => a.allianceId))];
    const alliances = await agents.getAlliances();
    const userAlliances = alliances.filter(a => allianceIds.includes(a.id));

    res.json({
      walletAddress: user.walletAddress,
      agents: userAgents,
      alliances: userAlliances,
      totalXyzBalance: userAgents.reduce((sum, a) => sum + (a.xyzBalance || 0), 0),
      totalRoi: userAgents.reduce((sum, a) => sum + (a.roi || 0), 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ACTIVITY & TRANSACTIONS =====

router.get('/activities', async (req, res) => {
  const limit = parseInt(req.query.limit || '50');
  const activities = await world.getRecentActivities(Math.min(limit, 200));
  res.json(activities);
});

router.get('/transactions', async (req, res) => {
  const txns = await blockchain.getRecentTransactions(50);
  res.json(txns);
});

router.get('/transactions/stats', async (req, res) => {
  const stats = await blockchain.getTransactionStats();
  res.json(stats);
});

router.get('/chain/stats', async (req, res) => {
  const stats = await blockchain.getOnChainStats();
  if (!stats) return res.json({ error: 'Contract not deployed or not reachable' });
  const balance = await blockchain.getBalance(blockchain.getMasterWallet()?.address || '');
  res.json({ ...stats, masterBalance: balance });
});

// ===== ALLIANCES =====

router.get('/alliances', async (req, res) => {
  const alliances = await agents.getAlliances();

  // Enrich with member details
  const enriched = alliances.map(a => ({
    ...a,
    members: a.memberIds.map(id => {
      const agent = agents.getAgent(id);
      return agent ? { id: agent.id, name: agent.name, emoji: agent.emoji, strategy: agent.strategy } : null;
    }).filter(Boolean),
  }));

  res.json(enriched);
});

// ===== LEADERBOARD =====

router.get('/leaderboard', (req, res) => {
  const sorted = agents.getAllAgents()
    .filter(a => a.alive)
    .map(a => {
      const pub = agents.getAgentPublicData(a);
      return {
        ...pub,
        score: pub.score,
        roi: a.totalEarned - a.totalSpent,
        roiPct: a.totalDeposited > 0
          ? ((a.totalEarned - a.totalSpent) / a.totalDeposited * 100).toFixed(1)
          : '0',
        ownerAddress: a.ownerAddress ? a.ownerAddress.slice(0, 6) + '...' + a.ownerAddress.slice(-4) : 'Platform',
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  res.json(sorted);
});

// GET /api/leaderboard/alliances
router.get('/leaderboard/alliances', async (req, res) => {
  const alliances = await agents.getAlliances();
  const enriched = alliances.map(a => {
    const members = a.memberIds.map(id => agents.getAgent(id)).filter(Boolean);
    const totalScore = members.reduce((sum, m) => {
      return sum + m.wealth + m.territory * config.SCORE.TERRITORY_MULT + m.buildingsCount * config.SCORE.BUILDINGS_MULT + m.kills * config.SCORE.KILLS_MULT;
    }, 0);
    const totalTerritory = members.reduce((sum, m) => sum + m.territory, 0);

    return {
      id: a.id, name: a.name, color: a.color,
      memberCount: members.length,
      treasury: a.treasury,
      totalTerritory,
      totalScore,
    };
  }).sort((a, b) => b.totalScore - a.totalScore);

  res.json(enriched);
});

// ===== ECONOMY STATS =====

router.get('/economy/stats', async (req, res) => {
  try {
    const allAgentsList = agents.getAllAgents();
    const totalXyz = allAgentsList.reduce((sum, a) => sum + (a.xyzBalance || 0), 0);
    const totalDeposited = allAgentsList.reduce((sum, a) => sum + (a.totalDeposited || 0), 0);
    const totalBurned = allAgentsList.reduce((sum, a) => sum + (a.totalSpent || 0), 0);
    const totalEarned = allAgentsList.reduce((sum, a) => sum + (a.totalEarned || 0), 0);
    const activeCount = agents.getActiveAgents().length;
    const idleCount = allAgentsList.filter(a => a.alive && a.idle).length;

    res.json({
      totalCirculating: totalXyz,
      totalDeposited,
      totalBurned,
      totalEarned,
      activeAgents: activeCount,
      idleAgents: idleCount,
      totalAgents: allAgentsList.length,
      aliveAgents: allAgentsList.filter(a => a.alive).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
