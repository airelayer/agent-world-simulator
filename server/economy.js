const config = require('./config');
const db = require('./db');

const ECO = config.ECONOMY;

// ===== $REAI BALANCE OPERATIONS (all off-chain, tracked in MySQL) =====

async function getBalance(agentId) {
  const rows = await db.query('SELECT xyz_balance FROM agents WHERE id = ?', [agentId]);
  return rows.length > 0 ? rows[0].xyz_balance : 0;
}

async function modifyBalance(agentId, amount, reason, tick = 0) {
  // Update agent balance
  await db.execute(
    'UPDATE agents SET xyz_balance = xyz_balance + ?, total_earned = total_earned + ?, total_spent = total_spent + ? WHERE id = ?',
    [amount, amount > 0 ? amount : 0, amount < 0 ? Math.abs(amount) : 0, agentId]
  );

  // Get new balance
  const rows = await db.query('SELECT xyz_balance FROM agents WHERE id = ?', [agentId]);
  const newBalance = rows.length > 0 ? rows[0].xyz_balance : 0;

  // Record in history
  await db.execute(
    'INSERT INTO balance_history (agent_id, change_amount, reason, balance_after, tick) VALUES (?, ?, ?, ?, ?)',
    [agentId, amount, reason, newBalance, tick]
  );

  // Record earnings for breakdown
  if (amount > 0) {
    await db.execute(
      'INSERT INTO earnings (agent_id, category, amount, tick) VALUES (?, ?, ?, ?)',
      [agentId, reason, amount, tick]
    );
  }

  return newBalance;
}

// ===== DEPOSIT $REAI (simulated — real on-chain deposit would verify tx) =====
async function deposit(agentId, amount) {
  await db.execute(
    'UPDATE agents SET xyz_balance = xyz_balance + ?, total_deposited = total_deposited + ? WHERE id = ?',
    [amount, amount, agentId]
  );
  const rows = await db.query('SELECT xyz_balance FROM agents WHERE id = ?', [agentId]);
  const newBalance = rows[0]?.xyz_balance || 0;

  await db.execute(
    'INSERT INTO balance_history (agent_id, change_amount, reason, balance_after, tick) VALUES (?, ?, ?, ?, ?)',
    [agentId, amount, 'deposit', newBalance, 0]
  );

  return newBalance;
}

// ===== BRAIN FEE — deducted each tick for platform AI agents =====
async function chargeBrainFee(agentId, tick) {
  const balance = await getBalance(agentId);
  if (balance < ECO.BRAIN_FEE_PER_TICK) {
    // Agent goes idle — not enough $REAI
    await db.execute('UPDATE agents SET idle = 1 WHERE id = ?', [agentId]);
    return { success: false, idle: true, balance };
  }

  const newBalance = await modifyBalance(agentId, -ECO.BRAIN_FEE_PER_TICK, 'brain_fee', tick);
  return { success: true, charged: ECO.BRAIN_FEE_PER_TICK, balance: newBalance };
}

// ===== LAND CLAIM COST (scales with biome desirability) =====
function getLandClaimCost(biome) {
  const desirability = ECO.BIOME_DESIRABILITY[biome] || 1.0;
  return Math.round(ECO.LAND_CLAIM_BASE_COST * desirability);
}

async function chargeLandClaim(agentId, biome, tick) {
  const cost = getLandClaimCost(biome);
  const balance = await getBalance(agentId);
  if (balance < cost) {
    return { success: false, reason: `Need ${cost} $REAI to claim this land (have ${balance.toFixed(1)})` };
  }
  const newBalance = await modifyBalance(agentId, -cost, 'land_claim', tick);
  return { success: true, cost, balance: newBalance, burned: cost }; // land claims are fully burned
}

// ===== BUILD COST in $REAI =====
async function chargeBuildCost(agentId, buildingType, tick) {
  const cost = ECO.BUILDING_XYZ_COST[buildingType] || 10;
  const balance = await getBalance(agentId);
  if (balance < cost) {
    return { success: false, reason: `Need ${cost} $REAI to build ${buildingType} (have ${balance.toFixed(1)})` };
  }
  const burned = Math.floor(cost * ECO.BUILDING_BURN_PCT);
  const newBalance = await modifyBalance(agentId, -cost, 'build_cost', tick);
  return { success: true, cost, balance: newBalance, burned, treasury: cost - burned };
}

// ===== ATTACK STAKING =====
async function stakeAttack(agentId, tick) {
  const balance = await getBalance(agentId);
  if (balance < ECO.ATTACK_STAKE) {
    return { success: false, reason: `Need ${ECO.ATTACK_STAKE} $REAI to attack (have ${balance.toFixed(1)})` };
  }
  await modifyBalance(agentId, -ECO.ATTACK_STAKE, 'attack_stake', tick);
  return { success: true, staked: ECO.ATTACK_STAKE };
}

async function resolveAttackWin(attackerId, defenderId, tick) {
  // Attacker wins: gets back stake + loot from defender
  const defenderRows = await db.query('SELECT xyz_balance FROM agents WHERE id = ?', [defenderId]);
  const defenderBalance = defenderRows[0]?.xyz_balance || 0;
  const loot = Math.floor(defenderBalance * ECO.KILL_LOOT_PCT);

  if (loot > 0) {
    await modifyBalance(defenderId, -loot, 'pvp_loss', tick);
    await modifyBalance(attackerId, loot, 'pvp_loot', tick);
  }

  // Return the stake
  await modifyBalance(attackerId, ECO.ATTACK_STAKE, 'attack_stake_return', tick);

  return { loot, stakeReturned: ECO.ATTACK_STAKE };
}

async function resolveAttackLoss(attackerId, defenderId, tick) {
  // Attacker loses: defender keeps the stake as compensation
  await modifyBalance(defenderId, ECO.ATTACK_STAKE, 'defense_reward', tick);
  return { stakeForfeited: ECO.ATTACK_STAKE };
}

// ===== TERRITORY TAX — when mining on someone else's land =====
async function chargeTerritoriyTax(minerId, landOwnerId, resourceValue, tick) {
  const tax = Math.floor(resourceValue * ECO.TERRITORY_TAX_PCT);
  if (tax <= 0) return { taxed: 0 };

  await modifyBalance(landOwnerId, tax, 'territory_tax', tick);
  // Alliance tax on territory income
  await chargeAllianceTax(landOwnerId, tax, tick);
  return { taxed: tax };
}

// ===== BUILDING INCOME PROCESSING (called each tick) =====
async function processBuildingIncome(tick) {
  // Get all tiles with buildings
  const buildingTiles = await db.query(
    'SELECT x, y, building, owner_id FROM tiles WHERE building IS NOT NULL AND owner_id IS NOT NULL'
  );

  const incomeByAgent = new Map();

  for (const tile of buildingTiles) {
    const incomeConfig = ECO.BUILDING_INCOME[tile.building];
    if (!incomeConfig) continue;

    switch (incomeConfig.type) {
      case 'passive_xyz':
        // Temple: generates $REAI per tick
        addIncome(incomeByAgent, tile.owner_id, incomeConfig.amount, `building_${tile.building}`);
        break;

      case 'protection':
        // Tower: collects fee from non-allied agents nearby (handled in tick processing)
        break;

      case 'fee':
        // Market: takes fee from trades nearby (handled in trade execution)
        break;

      case 'resource':
        // Farm/Mine: generates resources (handled in agents.js tick processing)
        break;
    }
  }

  // Apply all passive $REAI income (with alliance tax deduction)
  for (const [agentId, entries] of incomeByAgent) {
    let total = 0;
    for (const { amount } of entries) total += amount;
    if (total > 0) {
      await modifyBalance(agentId, total, 'building_income', tick);
      // Alliance tax: 5% of income goes to alliance treasury
      await chargeAllianceTax(agentId, total, tick);
    }
  }

  return incomeByAgent;
}

function addIncome(map, agentId, amount, source) {
  if (!map.has(agentId)) map.set(agentId, []);
  map.get(agentId).push({ amount, source });
}

// ===== TOWER PROTECTION FEE =====
async function chargeTowerFees(agents, tick) {
  const towers = await db.query(
    "SELECT x, y, owner_id FROM tiles WHERE building = 'TOWER' AND owner_id IS NOT NULL"
  );

  for (const tower of towers) {
    const fee = ECO.BUILDING_INCOME.TOWER.fee;
    const radius = ECO.BUILDING_INCOME.TOWER.radius;

    for (const agent of agents) {
      if (!agent.alive || agent.id === tower.owner_id) continue;
      if (agent.allianceId && agent.allianceId === (await getAllianceForAgent(tower.owner_id))) continue;

      const dist = Math.abs(agent.x - tower.x) + Math.abs(agent.y - tower.y);
      if (dist <= radius) {
        const balance = await getBalance(agent.id);
        if (balance >= fee) {
          await modifyBalance(agent.id, -fee, 'tower_fee', tick);
          await modifyBalance(tower.owner_id, fee, 'tower_income', tick);
          // Alliance tax on tower income
          await chargeAllianceTax(tower.owner_id, fee, tick);
        }
      }
    }
  }
}

async function getAllianceForAgent(agentId) {
  const rows = await db.query('SELECT alliance_id FROM agents WHERE id = ?', [agentId]);
  return rows[0]?.alliance_id || null;
}

// ===== MARKET FEE ON TRADES =====
async function chargeMarketFee(traderAgentX, traderAgentY, tradeValue, tick) {
  const markets = await db.query(
    "SELECT x, y, owner_id FROM tiles WHERE building = 'MARKET' AND owner_id IS NOT NULL"
  );

  for (const market of markets) {
    const radius = ECO.BUILDING_INCOME.MARKET.radius;
    const dist = Math.abs(traderAgentX - market.x) + Math.abs(traderAgentY - market.y);
    if (dist <= radius) {
      const fee = Math.floor(tradeValue * ECO.BUILDING_INCOME.MARKET.feePct);
      if (fee > 0) {
        await modifyBalance(market.owner_id, fee, 'market_fee', tick);
        return { fee, marketOwner: market.owner_id };
      }
    }
  }
  return { fee: 0 };
}

// ===== ALLIANCE TREASURY =====
async function contributeToAlliance(agentId, allianceId, amount, tick) {
  const balance = await getBalance(agentId);
  if (balance < amount) {
    return { success: false, reason: `Not enough $REAI (have ${balance.toFixed(1)}, need ${amount})` };
  }
  await modifyBalance(agentId, -amount, 'alliance_contribution', tick);
  await db.execute('UPDATE alliances SET treasury = treasury + ? WHERE id = ?', [amount, allianceId]);
  return { success: true, contributed: amount };
}

async function chargeAllianceTax(agentId, incomeAmount, tick) {
  const rows = await db.query('SELECT alliance_id FROM agents WHERE id = ?', [agentId]);
  const allianceId = rows[0]?.alliance_id;
  if (!allianceId) return { taxed: 0 };

  const tax = Math.floor(incomeAmount * ECO.ALLIANCE_TAX_PCT);
  if (tax <= 0) return { taxed: 0 };

  await modifyBalance(agentId, -tax, 'alliance_tax', tick);
  await db.execute('UPDATE alliances SET treasury = treasury + ? WHERE id = ?', [tax, allianceId]);
  return { taxed: tax };
}

// ===== LEADERBOARD REWARDS (called each epoch) =====
async function distributeLeaderboardRewards(agents, tick) {
  const alive = agents.filter(a => a.alive);
  const scored = alive.map(a => ({
    id: a.id,
    name: a.name,
    score: a.wealth + a.territory * config.SCORE.TERRITORY_MULT + a.buildingsCount * config.SCORE.BUILDINGS_MULT + a.kills * config.SCORE.KILLS_MULT,
  }));
  scored.sort((a, b) => b.score - a.score);

  const rewards = [];
  for (let i = 0; i < Math.min(scored.length, ECO.LEADERBOARD_REWARDS.length); i++) {
    const reward = ECO.LEADERBOARD_REWARDS[i];
    await modifyBalance(scored[i].id, reward, 'leaderboard_reward', tick);
    rewards.push({ rank: i + 1, agentId: scored[i].id, name: scored[i].name, reward });
  }

  return rewards;
}

// ===== RESOURCE SELL (agent sells resource for $REAI at market price) =====
async function sellResource(agentId, resource, amount, marketPrices, tick) {
  const price = marketPrices[resource]?.price || 1;
  const totalValue = Math.floor(price * amount);

  await modifyBalance(agentId, totalValue, 'resource_sale', tick);
  // Alliance tax on sale income
  await chargeAllianceTax(agentId, totalValue, tick);
  return { success: true, resource, amount, pricePerUnit: price, totalValue };
}

// ===== GET AGENT FINANCIAL SUMMARY =====
async function getAgentFinancials(agentId) {
  const agent = await db.query(
    'SELECT xyz_balance, total_deposited, total_earned, total_spent FROM agents WHERE id = ?',
    [agentId]
  );
  if (agent.length === 0) return null;

  const earningRows = await db.query(
    'SELECT category, SUM(amount) as total FROM earnings WHERE agent_id = ? GROUP BY category',
    [agentId]
  );
  const earnings = {};
  for (const r of earningRows) earnings[r.category] = r.total;

  const recentHistory = await db.query(
    'SELECT * FROM balance_history WHERE agent_id = ? ORDER BY id DESC LIMIT 20',
    [agentId]
  );

  return {
    balance: agent[0].xyz_balance,
    totalDeposited: agent[0].total_deposited,
    totalEarned: agent[0].total_earned,
    totalSpent: agent[0].total_spent,
    roi: agent[0].total_earned - agent[0].total_spent,
    roiPct: agent[0].total_deposited > 0
      ? ((agent[0].total_earned - agent[0].total_spent) / agent[0].total_deposited * 100).toFixed(1)
      : '0',
    earningsByCategory: earnings,
    recentHistory,
  };
}

// ===== BETRAYAL PENALTY =====
async function penalizeBetrayal(attackerId, allianceId, tick) {
  const penalty = ECO.BETRAYAL_PENALTY;
  const balance = await getBalance(attackerId);
  const actual = Math.min(penalty, balance);

  if (actual > 0) {
    await modifyBalance(attackerId, -actual, 'betrayal_penalty', tick);
    await db.execute('UPDATE alliances SET treasury = treasury + ? WHERE id = ?', [actual, allianceId]);
  }

  // Remove from alliance
  await db.execute('DELETE FROM alliance_members WHERE agent_id = ?', [attackerId]);
  await db.execute('UPDATE agents SET alliance_id = NULL WHERE id = ?', [attackerId]);

  return { penalty: actual };
}

module.exports = {
  getBalance, modifyBalance, deposit,
  chargeBrainFee,
  getLandClaimCost, chargeLandClaim,
  chargeBuildCost,
  stakeAttack, resolveAttackWin, resolveAttackLoss,
  chargeTerritoriyTax,
  processBuildingIncome, chargeTowerFees, chargeMarketFee,
  contributeToAlliance, chargeAllianceTax,
  distributeLeaderboardRewards,
  sellResource,
  getAgentFinancials,
  penalizeBetrayal,
};
