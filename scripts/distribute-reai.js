/**
 * Distribute $REAI tokens from master wallet to all agent wallets
 * Usage: node scripts/distribute-reai.js [amount_per_agent]
 * Default: 100 REAI per agent
 */
require('dotenv').config();
const { ethers } = require('ethers');
const mysql = require('mysql2/promise');

const REAI_TOKEN = '0x31BbbB9205d6F354833B80cdCd788182b7037777';
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

async function main() {
  const amountPerAgent = parseFloat(process.argv[2] || '100');

  const provider = new ethers.JsonRpcProvider(process.env.MONAD_RPC_URL, { chainId: 143, name: 'monad' });
  const wallet = new ethers.Wallet(process.env.MASTER_PRIVATE_KEY, provider);
  const token = new ethers.Contract(REAI_TOKEN, ERC20_ABI, wallet);

  const decimals = await token.decimals();
  const symbol = await token.symbol();
  const masterBal = await token.balanceOf(wallet.address);

  console.log(`Master wallet: ${wallet.address}`);
  console.log(`$${symbol} balance: ${ethers.formatUnits(masterBal, decimals)}`);
  console.log(`Distributing ${amountPerAgent} $${symbol} per agent\n`);

  // Get all agent wallets from DB
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'agent_world',
  });

  const [agents] = await db.execute('SELECT id, name, wallet_address FROM agents WHERE alive = 1');
  console.log(`Found ${agents.length} alive agents\n`);

  const amount = ethers.parseUnits(String(amountPerAgent), decimals);
  const totalNeeded = amount * BigInt(agents.length);

  if (masterBal < totalNeeded) {
    console.error(`Not enough $${symbol}! Need ${ethers.formatUnits(totalNeeded, decimals)} but have ${ethers.formatUnits(masterBal, decimals)}`);
    await db.end();
    process.exit(1);
  }

  for (const agent of agents) {
    try {
      const currentBal = await token.balanceOf(agent.wallet_address);
      console.log(`${agent.name} (${agent.wallet_address.slice(0, 10)}...) current: ${ethers.formatUnits(currentBal, decimals)} $${symbol}`);

      const tx = await token.transfer(agent.wallet_address, amount);
      const receipt = await tx.wait();
      console.log(`  -> Sent ${amountPerAgent} $${symbol} | tx: ${receipt.hash}`);

      // Update DB balance to match
      const newBal = await token.balanceOf(agent.wallet_address);
      const balNum = parseFloat(ethers.formatUnits(newBal, decimals));
      await db.execute('UPDATE agents SET xyz_balance = ? WHERE id = ?', [balNum, agent.id]);
      console.log(`  -> DB synced: ${balNum} $${symbol}\n`);

      // Small delay to avoid nonce issues
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`  -> FAILED for ${agent.name}: ${err.message}\n`);
    }
  }

  const finalBal = await token.balanceOf(wallet.address);
  console.log(`\nDone! Master wallet remaining: ${ethers.formatUnits(finalBal, decimals)} $${symbol}`);
  await db.end();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
