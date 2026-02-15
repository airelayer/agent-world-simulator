const mysql = require('mysql2/promise');
const config = require('./config');

let pool;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.DB_HOST,
      port: config.DB_PORT,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      database: config.DB_NAME,
      waitForConnections: true,
      connectionLimit: 20,
      queueLimit: 0,
    });
  }
  return pool;
}

async function init() {
  // Create database if not exists
  const tempConn = await mysql.createConnection({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
  });
  await tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${config.DB_NAME}\``);
  await tempConn.end();

  const db = await getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS tiles (
      x INT NOT NULL,
      y INT NOT NULL,
      biome VARCHAR(32) NOT NULL,
      elevation FLOAT NOT NULL DEFAULT 0,
      moisture FLOAT NOT NULL DEFAULT 0,
      resource VARCHAR(16) DEFAULT NULL,
      resource_amount INT NOT NULL DEFAULT 0,
      owner_id VARCHAR(64) DEFAULT NULL,
      building VARCHAR(16) DEFAULT NULL,
      PRIMARY KEY (x, y),
      INDEX idx_owner (owner_id)
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      emoji VARCHAR(8) NOT NULL DEFAULT '🤖',
      color VARCHAR(16) NOT NULL DEFAULT '#836EF9',
      strategy VARCHAR(32) NOT NULL DEFAULT 'Explorer',
      x INT NOT NULL DEFAULT 0,
      y INT NOT NULL DEFAULT 0,
      health INT NOT NULL DEFAULT 100,
      max_health INT NOT NULL DEFAULT 100,
      wealth FLOAT NOT NULL DEFAULT 0,
      xyz_balance FLOAT NOT NULL DEFAULT 0,
      total_deposited FLOAT NOT NULL DEFAULT 0,
      total_earned FLOAT NOT NULL DEFAULT 0,
      total_spent FLOAT NOT NULL DEFAULT 0,
      alive TINYINT(1) NOT NULL DEFAULT 1,
      idle TINYINT(1) NOT NULL DEFAULT 0,
      territory INT NOT NULL DEFAULT 0,
      buildings_count INT NOT NULL DEFAULT 0,
      trades_count INT NOT NULL DEFAULT 0,
      kills INT NOT NULL DEFAULT 0,
      deaths INT NOT NULL DEFAULT 0,
      alliance_id VARCHAR(64) DEFAULT NULL,
      wallet_address VARCHAR(64) DEFAULT NULL,
      wallet_private_key VARCHAR(128) DEFAULT NULL,
      api_key VARCHAR(128) DEFAULT NULL,
      webhook_url VARCHAR(512) DEFAULT NULL,
      is_builtin TINYINT(1) NOT NULL DEFAULT 0,
      owner_address VARCHAR(64) DEFAULT NULL,
      custom_prompt TEXT DEFAULT NULL,
      llm_mode VARCHAR(16) NOT NULL DEFAULT 'platform',
      llm_keys JSON DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_alive (alive),
      INDEX idx_wallet (wallet_address),
      INDEX idx_owner (owner_address)
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_inventory (
      agent_id VARCHAR(64) NOT NULL,
      resource VARCHAR(16) NOT NULL,
      amount INT NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, resource),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS alliances (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      color VARCHAR(16) NOT NULL DEFAULT '#836EF9',
      treasury FLOAT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS alliance_members (
      alliance_id VARCHAR(64) NOT NULL,
      agent_id VARCHAR(64) NOT NULL,
      PRIMARY KEY (alliance_id, agent_id),
      FOREIGN KEY (alliance_id) REFERENCES alliances(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS market_prices (
      resource VARCHAR(16) NOT NULL PRIMARY KEY,
      price FLOAT NOT NULL DEFAULT 1.0,
      price_change FLOAT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS activities (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(32) NOT NULL,
      message TEXT NOT NULL,
      agent_id VARCHAR(64) DEFAULT NULL,
      epoch INT NOT NULL DEFAULT 1,
      tick INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created (created_at DESC)
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tx_hash VARCHAR(128) DEFAULT NULL,
      tx_type VARCHAR(32) NOT NULL,
      from_agent VARCHAR(64) DEFAULT NULL,
      to_agent VARCHAR(64) DEFAULT NULL,
      data JSON DEFAULT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      block_number BIGINT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_type (tx_type),
      INDEX idx_status (status)
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS world_state (
      \`key\` VARCHAR(64) NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    ) ENGINE=InnoDB
  `);

  // ===== NEW TABLES FOR ECONOMY SYSTEM =====

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      wallet_address VARCHAR(64) NOT NULL UNIQUE,
      nonce VARCHAR(64) NOT NULL,
      session_token VARCHAR(128) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_session (session_token)
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS alliance_proposals (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      from_agent_id VARCHAR(64) NOT NULL,
      to_agent_id VARCHAR(64) NOT NULL,
      alliance_id VARCHAR(64) DEFAULT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_tick INT NOT NULL DEFAULT 0,
      resolved_tick INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_to_agent (to_agent_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS balance_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      agent_id VARCHAR(64) NOT NULL,
      change_amount FLOAT NOT NULL,
      reason VARCHAR(64) NOT NULL,
      balance_after FLOAT NOT NULL,
      tick INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_agent (agent_id),
      INDEX idx_tick (tick)
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS earnings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      agent_id VARCHAR(64) NOT NULL,
      category VARCHAR(32) NOT NULL,
      amount FLOAT NOT NULL,
      tick INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_agent_cat (agent_id, category)
    ) ENGINE=InnoDB
  `);

  console.log('[DB] MySQL database initialized');
  return db;
}

async function query(sql, params = []) {
  const db = await getPool();
  const [rows] = await db.query(sql, params);
  return rows;
}

async function execute(sql, params = []) {
  const db = await getPool();
  const [result] = await db.execute(sql, params);
  return result;
}

async function getState(key, defaultVal = null) {
  const rows = await query('SELECT value FROM world_state WHERE `key` = ?', [key]);
  if (rows.length === 0) return defaultVal;
  try { return JSON.parse(rows[0].value); } catch { return rows[0].value; }
}

async function setState(key, value) {
  const val = typeof value === 'string' ? value : JSON.stringify(value);
  await execute(
    'INSERT INTO world_state (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?',
    [key, val, val]
  );
}

module.exports = { init, query, execute, getState, setState, getPool };
