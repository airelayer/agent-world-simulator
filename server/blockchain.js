const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');

let provider = null;
let masterWallet = null;
let contract = null;

// Load compiled ABI
let CONTRACT_ABI;
try {
  CONTRACT_ABI = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'contracts', 'AgentWorld.abi.json'), 'utf8')
  );
} catch {
  console.warn('[CHAIN] No compiled ABI found — run node scripts/deploy.js first');
  CONTRACT_ABI = [];
}

// Tx queue — batch on-chain calls to avoid nonce collisions
let txQueue = [];
let txProcessing = false;
let nonce = null;

// Gas tracking
let totalGasUsed = BigInt(0);
let txCount = 0;
let initialBalance = null;

function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(config.MONAD_RPC_URL, {
      chainId: config.MONAD_CHAIN_ID,
      name: 'monad',
    });
  }
  return provider;
}

function getMasterWallet() {
  if (!masterWallet && config.MASTER_PRIVATE_KEY) {
    masterWallet = new ethers.Wallet(config.MASTER_PRIVATE_KEY, getProvider());
  }
  return masterWallet;
}

function getContract() {
  if (contract) return contract;
  if (!config.CONTRACT_ADDRESS || CONTRACT_ABI.length === 0) return null;
  const wallet = getMasterWallet();
  if (!wallet) return null;
  contract = new ethers.Contract(config.CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
  return contract;
}

function createAgentWallet() {
  const wallet = ethers.Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey };
}

async function getBalance(address) {
  try {
    return ethers.formatEther(await getProvider().getBalance(address));
  } catch (err) {
    console.error('[CHAIN] Balance check failed:', err.message);
    return '0';
  }
}

// Record tx in MySQL
async function recordTransaction(type, fromAgent, toAgent, data, txHash = null, blockNumber = null) {
  await db.execute(
    'INSERT INTO transactions (tx_hash, tx_type, from_agent, to_agent, data, status, block_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [txHash, type, fromAgent, toAgent, JSON.stringify(data), txHash ? 'confirmed' : 'local', blockNumber]
  );
}

// ===== TX QUEUE — serialize on-chain calls to avoid nonce issues =====
function queueTx(fn) {
  return new Promise((resolve, reject) => {
    txQueue.push({ fn, resolve, reject });
    processTxQueue();
  });
}

async function processTxQueue() {
  if (txProcessing || txQueue.length === 0) return;
  txProcessing = true;

  while (txQueue.length > 0) {
    const { fn, resolve, reject } = txQueue.shift();
    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    }
    // Small delay between txs to let nonce propagate
    await new Promise(r => setTimeout(r, 200));
  }

  txProcessing = false;
}

// ===== REAL ON-CHAIN OPERATIONS =====

async function onChainRegisterAgent(name, x, y, agentWalletAddress) {
  const c = getContract();
  if (!c) {
    await recordTransaction('register', agentWalletAddress, null, { name, x, y });
    return null;
  }

  return queueTx(async () => {
    try {
      const tx = await c.registerAgent(agentWalletAddress, name, x, y);
      const receipt = await tx.wait();
      txCount++;
      if (receipt.gasUsed) totalGasUsed += receipt.gasUsed;
      await recordTransaction('register', agentWalletAddress, null, { name, x, y }, receipt.hash, Number(receipt.blockNumber));
      console.log(`[CHAIN] Agent registered: ${name} | tx=${receipt.hash} | block=${receipt.blockNumber}`);
      return receipt.hash;
    } catch (err) {
      console.error(`[CHAIN] Register failed: ${err.message}`);
      await recordTransaction('register', agentWalletAddress, null, { name, x, y });
      return null;
    }
  });
}

async function onChainClaimLand(x, y, agentWalletAddress) {
  const c = getContract();
  if (!c) {
    await recordTransaction('claim', agentWalletAddress, null, { x, y });
    return null;
  }

  return queueTx(async () => {
    try {
      const tx = await c.claimLand(agentWalletAddress, x, y);
      const receipt = await tx.wait();
      txCount++;
      if (receipt.gasUsed) totalGasUsed += receipt.gasUsed;
      await recordTransaction('claim', agentWalletAddress, null, { x, y }, receipt.hash, Number(receipt.blockNumber));
      console.log(`[CHAIN] Land claimed: (${x},${y}) by ${agentWalletAddress.slice(0,10)}... | tx=${receipt.hash}`);
      return receipt.hash;
    } catch (err) {
      console.error(`[CHAIN] Claim failed: ${err.message}`);
      await recordTransaction('claim', agentWalletAddress, null, { x, y });
      return null;
    }
  });
}

async function onChainTrade(fromAddress, toAddress, resourceFrom, resourceTo, amount) {
  const c = getContract();
  if (!c) {
    await recordTransaction('trade', fromAddress, toAddress, { resourceFrom, resourceTo, amount });
    return null;
  }

  return queueTx(async () => {
    try {
      const tx = await c.recordTrade(fromAddress, toAddress, resourceFrom, resourceTo, amount);
      const receipt = await tx.wait();
      txCount++;
      if (receipt.gasUsed) totalGasUsed += receipt.gasUsed;
      await recordTransaction('trade', fromAddress, toAddress, { resourceFrom, resourceTo, amount }, receipt.hash, Number(receipt.blockNumber));
      console.log(`[CHAIN] Trade: ${resourceFrom}->${resourceTo} x${amount} | tx=${receipt.hash}`);
      return receipt.hash;
    } catch (err) {
      console.error(`[CHAIN] Trade failed: ${err.message}`);
      await recordTransaction('trade', fromAddress, toAddress, { resourceFrom, resourceTo, amount });
      return null;
    }
  });
}

async function onChainBuild(x, y, buildingType, agentWalletAddress) {
  const c = getContract();
  if (!c) {
    await recordTransaction('build', agentWalletAddress, null, { x, y, buildingType });
    return null;
  }

  return queueTx(async () => {
    try {
      const tx = await c.buildStructure(agentWalletAddress, x, y, buildingType);
      const receipt = await tx.wait();
      txCount++;
      if (receipt.gasUsed) totalGasUsed += receipt.gasUsed;
      await recordTransaction('build', agentWalletAddress, null, { x, y, buildingType }, receipt.hash, Number(receipt.blockNumber));
      console.log(`[CHAIN] Built ${buildingType} at (${x},${y}) | tx=${receipt.hash}`);
      return receipt.hash;
    } catch (err) {
      console.error(`[CHAIN] Build failed: ${err.message}`);
      await recordTransaction('build', agentWalletAddress, null, { x, y, buildingType });
      return null;
    }
  });
}

// Read on-chain stats from contract
async function getOnChainStats() {
  const c = getContract();
  if (!c) return null;
  try {
    const [agentCount, totalClaims, tradeCount, buildCount] = await c.getStats();
    const wallet = getMasterWallet();
    const balance = wallet ? await getBalance(wallet.address) : '0';

    // Track initial balance on first call
    if (initialBalance === null) initialBalance = balance;

    const gasSpent = initialBalance !== null
      ? (parseFloat(initialBalance) - parseFloat(balance)).toFixed(4)
      : '0';

    return {
      agentCount: Number(agentCount),
      totalClaims: Number(totalClaims),
      tradeCount: Number(tradeCount),
      buildCount: Number(buildCount),
      contractAddress: config.CONTRACT_ADDRESS,
      masterBalance: balance,
      gasSpent,
      onChainTxCount: txCount,
    };
  } catch (err) {
    console.error('[CHAIN] Stats read failed:', err.message);
    return null;
  }
}

async function getRecentTransactions(limit = 50) {
  return db.query('SELECT * FROM transactions ORDER BY id DESC LIMIT ?', [limit]);
}

async function getTransactionStats() {
  return db.query(
    'SELECT tx_type, COUNT(*) as count, SUM(CASE WHEN tx_hash IS NOT NULL THEN 1 ELSE 0 END) as on_chain FROM transactions GROUP BY tx_type'
  );
}

// ===== WITHDRAW FROM AGENT WALLET =====
async function withdrawFromAgent(agentPrivateKey, toAddress, amount) {
  try {
    const agentWallet = new ethers.Wallet(agentPrivateKey, getProvider());
    const balance = await getProvider().getBalance(agentWallet.address);
    const balanceEth = parseFloat(ethers.formatEther(balance));

    if (balanceEth <= 0) {
      return { success: false, error: 'Agent wallet has 0 MON balance' };
    }

    // If no amount specified, send max (balance minus gas estimate)
    let value;
    if (!amount || amount === 'max') {
      const gasPrice = (await getProvider().getFeeData()).gasPrice || ethers.parseUnits('50', 'gwei');
      const gasLimit = 21000n;
      const gasCost = gasPrice * gasLimit;
      value = balance - gasCost;
      if (value <= 0n) return { success: false, error: 'Insufficient balance to cover gas' };
    } else {
      value = ethers.parseEther(String(amount));
      if (value > balance) return { success: false, error: `Insufficient balance. Have ${balanceEth} MON` };
    }

    const tx = await agentWallet.sendTransaction({
      to: toAddress,
      value,
    });
    const receipt = await tx.wait();

    console.log(`[CHAIN] Withdraw: ${ethers.formatEther(value)} MON from ${agentWallet.address} to ${toAddress} | tx=${tx.hash}`);

    return {
      success: true,
      txHash: tx.hash,
      amount: ethers.formatEther(value),
      from: agentWallet.address,
      to: toAddress,
      blockNumber: receipt.blockNumber,
    };
  } catch (err) {
    console.error('[CHAIN] Withdraw failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  getProvider, getMasterWallet, getContract,
  createAgentWallet, getBalance, withdrawFromAgent,
  recordTransaction, getRecentTransactions, getTransactionStats,
  onChainRegisterAgent, onChainClaimLand, onChainTrade, onChainBuild,
  getOnChainStats,
  CONTRACT_ABI,
};
