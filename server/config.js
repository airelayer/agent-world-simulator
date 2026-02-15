require('dotenv').config();

module.exports = {
  // Server
  PORT: parseInt(process.env.PORT || '3000'),
  HOST: process.env.HOST || '0.0.0.0',

  // MySQL
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: parseInt(process.env.DB_PORT || '3306'),
  DB_USER: process.env.DB_USER || 'root',
  DB_PASSWORD: process.env.DB_PASSWORD || '',
  DB_NAME: process.env.DB_NAME || 'agent_world',

  // Monad
  MONAD_RPC_URL: process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz',
  MASTER_PRIVATE_KEY: process.env.MASTER_PRIVATE_KEY || '',
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS || '',       // $REAI token on nad.fun
  GAME_CONTRACT_ADDRESS: process.env.GAME_CONTRACT_ADDRESS || '', // AgentWorld game contract
  MONAD_CHAIN_ID: 143,

  // World
  GRID_W: parseInt(process.env.GRID_WIDTH || '80'),
  GRID_H: parseInt(process.env.GRID_HEIGHT || '55'),
  TICK_INTERVAL: parseInt(process.env.TICK_INTERVAL_MS || '5000'),
  WORLD_SEED: parseInt(process.env.WORLD_SEED || '42'),

  // LLM
  LLM_PROVIDER: process.env.LLM_PROVIDER || 'openai', // "openai" | "groq"
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  LLM_MODEL: process.env.LLM_MODEL || '', // auto-selected per provider if empty
  LLM_MAX_TOKENS: parseInt(process.env.LLM_MAX_TOKENS || '200'),

  // Game constants
  RESOURCES: {
    WOOD:    { name: 'Wood',    icon: '🪵', biomes: ['forest', 'denseForest'] },
    STONE:   { name: 'Stone',   icon: '🪨', biomes: ['mountain', 'tundra'] },
    GOLD:    { name: 'Gold',    icon: '✨', biomes: ['desert', 'mountain'] },
    FOOD:    { name: 'Food',    icon: '🌾', biomes: ['plains', 'grassland'] },
    IRON:    { name: 'Iron',    icon: '⛏️', biomes: ['mountain', 'snow'] },
    CRYSTAL: { name: 'Crystal', icon: '💎', biomes: ['snow', 'tundra'] },
  },

  BUILDINGS: {
    HOUSE:  { name: 'House',  icon: '🏠', cost: { WOOD: 5, STONE: 3 } },
    FARM:   { name: 'Farm',   icon: '🌿', cost: { WOOD: 3, FOOD: 2 } },
    MINE:   { name: 'Mine',   icon: '⛏️', cost: { WOOD: 4, IRON: 2 } },
    TOWER:  { name: 'Tower',  icon: '🏰', cost: { STONE: 8, IRON: 4 } },
    MARKET: { name: 'Market', icon: '🏪', cost: { WOOD: 6, GOLD: 3 } },
    TEMPLE: { name: 'Temple', icon: '🏛️', cost: { STONE: 10, CRYSTAL: 5, GOLD: 5 } },
  },

  BIOMES: {
    deepWater:    { name: 'Deep Ocean',   walkable: false },
    water:        { name: 'Ocean',        walkable: false },
    shallowWater: { name: 'Shallows',     walkable: false },
    beach:        { name: 'Beach',        walkable: true },
    desert:       { name: 'Desert',       walkable: true },
    plains:       { name: 'Plains',       walkable: true },
    grassland:    { name: 'Grassland',    walkable: true },
    forest:       { name: 'Forest',       walkable: true },
    denseForest:  { name: 'Dense Forest', walkable: true },
    tundra:       { name: 'Tundra',       walkable: true },
    mountain:     { name: 'Mountain',     walkable: true },
    snow:         { name: 'Snow Peaks',   walkable: true },
  },

  STRATEGIES: [
    'Expansionist', 'Trader', 'Builder', 'Warrior', 'Hoarder',
    'Explorer', 'Diplomat', 'Miner', 'Farmer', 'Raider',
    'Scholar', 'Merchant', 'Conqueror', 'Nomad', 'Architect',
    'Alchemist', 'Warlord', 'Sage', 'Pirate', 'Oracle',
  ],

  // ===== ECONOMY CONSTANTS ($REAI token) =====
  ECONOMY: {
    DEPLOY_DEPOSIT: 100,          // $REAI to deploy an agent
    BRAIN_FEE_PER_TICK: 1,        // $REAI per LLM decision (platform AI only)
    LAND_CLAIM_BASE_COST: 5,      // $REAI base cost to claim land
    LAND_CLAIM_MAX_COST: 50,      // $REAI max cost (scales with desirability)
    ATTACK_STAKE: 20,             // $REAI staked to attack
    KILL_LOOT_PCT: 0.5,           // 50% of target's $REAI balance on kill
    KILL_INVENTORY_PCT: 0.5,      // 50% of target's inventory on kill
    TERRITORY_TAX_PCT: 0.2,       // 20% tax when mining on someone else's land
    MARKET_FEE_PCT: 0.05,         // 5% fee on trades near a Market building
    ALLIANCE_TAX_PCT: 0.05,       // 5% of member income goes to alliance treasury
    BETRAYAL_PENALTY: 50,         // $REAI lost for attacking an alliance member
    EPOCH_TICKS: 100,             // Ticks per epoch for leaderboard rewards
    LEADERBOARD_REWARDS: [50, 30, 15], // $REAI for 1st, 2nd, 3rd per epoch
    PLATFORM_AGENT_BALANCE: 500,  // Starting $REAI for built-in agents
    MIN_BALANCE_TO_ACT: 0,        // Agent goes idle below this (brain fee can't be paid)

    // Building costs in $REAI (in addition to resource costs)
    BUILDING_XYZ_COST: {
      HOUSE: 10, FARM: 15, MINE: 20, TOWER: 30, MARKET: 40, TEMPLE: 100,
    },
    // Building burn split: burnPct goes to burn, rest to treasury
    BUILDING_BURN_PCT: 0.5,

    // Building passive income per tick
    BUILDING_INCOME: {
      FARM: { type: 'resource', resource: 'FOOD', amount: 2 },
      MINE: { type: 'resource', resource: 'random', amount: 1 },
      MARKET: { type: 'fee', radius: 3, feePct: 0.05 },
      TOWER: { type: 'protection', radius: 2, fee: 1 },
      TEMPLE: { type: 'passive_xyz', amount: 1 },
    },

    // Land claim cost scaling by biome desirability
    BIOME_DESIRABILITY: {
      beach: 1.0, desert: 0.8, plains: 1.5, grassland: 1.2,
      forest: 1.3, denseForest: 1.1, tundra: 0.7, mountain: 1.8, snow: 0.6,
    },
  },

  // ===== ALLIANCE CONSTANTS =====
  ALLIANCE: {
    MAX_MEMBERS: 5,
    PROPOSAL_EXPIRY_TICKS: 10,    // Alliance proposals expire after 10 ticks
    SHARED_VISION_BONUS: 3,       // Extra observation radius for allies
    TRADE_DISCOUNT: 0.10,         // 10% trade discount with alliance members
    COUNTER_ATTACK_RADIUS: 3,     // Allies within 3 tiles auto-counter next tick
  },

  // ===== SCORE FORMULA =====
  SCORE: {
    WEALTH_MULT: 1,
    TERRITORY_MULT: 5,
    BUILDINGS_MULT: 10,
    KILLS_MULT: 15,
    ROI_MULT: 2,
  },
};
