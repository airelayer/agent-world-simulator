const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { ethers } = require('ethers');
const db = require('./db');

// ===== NONCE MANAGEMENT =====
// Each user gets a random nonce to sign, proving wallet ownership

function generateNonce() {
  return crypto.randomBytes(32).toString('hex');
}

function generateSessionToken() {
  return 'session_' + crypto.randomBytes(32).toString('hex');
}

// ===== GET OR CREATE USER =====
async function getOrCreateUser(walletAddress) {
  const addr = walletAddress.toLowerCase();
  const rows = await db.query('SELECT * FROM users WHERE wallet_address = ?', [addr]);

  if (rows.length > 0) {
    // Rotate nonce each time
    const nonce = generateNonce();
    await db.execute('UPDATE users SET nonce = ? WHERE id = ?', [nonce, rows[0].id]);
    return { id: rows[0].id, walletAddress: addr, nonce, isNew: false };
  }

  // New user
  const id = uuidv4();
  const nonce = generateNonce();
  await db.execute(
    'INSERT INTO users (id, wallet_address, nonce) VALUES (?, ?, ?)',
    [id, addr, nonce]
  );

  return { id, walletAddress: addr, nonce, isNew: true };
}

// ===== VERIFY SIGNATURE =====
// User signs the nonce with their wallet to prove ownership
async function verifySignature(walletAddress, signature) {
  const addr = walletAddress.toLowerCase();
  const rows = await db.query('SELECT * FROM users WHERE wallet_address = ?', [addr]);
  if (rows.length === 0) {
    return { success: false, reason: 'User not found. Call /api/auth/nonce first.' };
  }

  const user = rows[0];
  const message = `Sign this message to authenticate with Agent World.\n\nNonce: ${user.nonce}`;

  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);
    if (recoveredAddress.toLowerCase() !== addr) {
      return { success: false, reason: 'Signature does not match wallet address' };
    }
  } catch (err) {
    return { success: false, reason: 'Invalid signature format' };
  }

  // Generate session token
  const sessionToken = generateSessionToken();
  const newNonce = generateNonce(); // Rotate nonce after use
  await db.execute(
    'UPDATE users SET session_token = ?, nonce = ? WHERE id = ?',
    [sessionToken, newNonce, user.id]
  );

  return {
    success: true,
    userId: user.id,
    walletAddress: addr,
    sessionToken,
  };
}

// ===== VERIFY SESSION =====
async function verifySession(sessionToken) {
  if (!sessionToken) return null;
  const rows = await db.query('SELECT * FROM users WHERE session_token = ?', [sessionToken]);
  if (rows.length === 0) return null;
  return { userId: rows[0].id, walletAddress: rows[0].wallet_address };
}

// ===== GET MESSAGE TO SIGN =====
function getSignMessage(nonce) {
  return `Sign this message to authenticate with Agent World.\n\nNonce: ${nonce}`;
}

// ===== GET USER'S AGENTS =====
async function getUserAgents(walletAddress) {
  const addr = walletAddress.toLowerCase();
  return db.query('SELECT * FROM agents WHERE owner_address = ?', [addr]);
}

// ===== MIDDLEWARE: require auth =====
function requireAuth(req, res, next) {
  const session = req.headers['x-session-token'];
  if (!session) {
    return res.status(401).json({ error: 'Authentication required. Include X-Session-Token header.' });
  }

  verifySession(session).then(user => {
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired session token' });
    }
    req.user = user;
    next();
  }).catch(err => {
    res.status(500).json({ error: 'Auth verification failed' });
  });
}

module.exports = {
  getOrCreateUser,
  verifySignature,
  verifySession,
  getSignMessage,
  getUserAgents,
  requireAuth,
  generateNonce,
};
