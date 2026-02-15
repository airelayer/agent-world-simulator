/**
 * Deploy AgentWorld contract to Monad mainnet
 * Run: node scripts/deploy.js
 */
require('dotenv').config();
const solc = require('solc');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
const PRIVATE_KEY = process.env.MASTER_PRIVATE_KEY;
const CHAIN_ID = 143;

async function main() {
  if (!PRIVATE_KEY) {
    console.error('ERROR: Set MASTER_PRIVATE_KEY in .env');
    process.exit(1);
  }

  // 1. Compile contract
  console.log('[1/4] Compiling AgentWorld.sol...');
  const contractSource = fs.readFileSync(
    path.join(__dirname, '..', 'contracts', 'AgentWorld.sol'),
    'utf8'
  );

  const input = {
    language: 'Solidity',
    sources: { 'AgentWorld.sol': { content: contractSource } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const errs = output.errors.filter(e => e.severity === 'error');
    if (errs.length > 0) {
      console.error('Compilation errors:');
      errs.forEach(e => console.error(e.formattedMessage));
      process.exit(1);
    }
    // Print warnings
    output.errors.filter(e => e.severity === 'warning').forEach(e => console.warn('[WARN]', e.message));
  }

  const compiled = output.contracts['AgentWorld.sol']['AgentWorld'];
  const abi = compiled.abi;
  const bytecode = '0x' + compiled.evm.bytecode.object;

  console.log(`   Compiled! ABI: ${abi.length} functions, Bytecode: ${bytecode.length} bytes`);

  // Save ABI for server use
  const abiPath = path.join(__dirname, '..', 'contracts', 'AgentWorld.abi.json');
  fs.writeFileSync(abiPath, JSON.stringify(abi, null, 2));
  console.log(`   ABI saved to ${abiPath}`);

  // 2. Connect to Monad
  console.log('[2/4] Connecting to Monad...');
  const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: 'monad' });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`   Wallet: ${wallet.address}`);
  console.log(`   Balance: ${ethers.formatEther(balance)} MON`);

  if (balance < ethers.parseEther('0.1')) {
    console.error('ERROR: Not enough MON for deployment (need at least 0.1 MON)');
    process.exit(1);
  }

  // 3. Deploy
  console.log('[3/4] Deploying AgentWorld to Monad...');
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);

  const contract = await factory.deploy();
  console.log(`   TX hash: ${contract.deploymentTransaction().hash}`);
  console.log('   Waiting for confirmation...');

  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  console.log(`   CONTRACT DEPLOYED: ${contractAddress}`);
  console.log(`   Explorer: https://monadscan.com/address/${contractAddress}`);

  // 4. Update .env
  console.log('[4/4] Updating .env...');
  const envPath = path.join(__dirname, '..', '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  envContent = envContent.replace(
    /CONTRACT_ADDRESS=.*/,
    `CONTRACT_ADDRESS=${contractAddress}`
  );
  fs.writeFileSync(envPath, envContent);
  console.log(`   .env updated with CONTRACT_ADDRESS=${contractAddress}`);

  // Final balance
  const newBalance = await provider.getBalance(wallet.address);
  console.log(`\n   Gas used: ${ethers.formatEther(balance - newBalance)} MON`);
  console.log(`   Remaining: ${ethers.formatEther(newBalance)} MON`);

  console.log('\n========================================');
  console.log('  DEPLOYMENT COMPLETE');
  console.log(`  Contract: ${contractAddress}`);
  console.log('  Now restart the server: npm start');
  console.log('========================================');
}

main().catch(err => {
  console.error('DEPLOY FAILED:', err);
  process.exit(1);
});
