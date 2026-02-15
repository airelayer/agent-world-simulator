/**
 * Launch $REAI token on Nad.fun — Moltiverse Agent Track
 *
 * Uses /agent/ REST endpoints (NOT standard /metadata/ endpoints)
 * so the token appears in the Moltiverse tab, not the normal trade tab.
 *
 * Flow:
 *   1. Upload token image   → POST /agent/token/image
 *   2. Upload metadata       → POST /agent/token/metadata
 *   3. Mine salt (vanity)    → POST /agent/salt
 *   4. On-chain create       → BondingCurveRouter.create()
 *
 * Prerequisites:
 *   - Master wallet must have ~10 MON for deploy fee
 *   - Token image file (PNG/JPG) in project root or specify path
 *   - .env must have MASTER_PRIVATE_KEY
 *
 * Usage:
 *   node scripts/launch-token.js
 *   node scripts/launch-token.js --dry-run   (skip on-chain tx)
 */

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// ===== CONFIG =====
const NADFUN_API = 'https://api.nadapp.net';
const MONAD_RPC = process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
const PRIVATE_KEY = process.env.MASTER_PRIVATE_KEY;
const CHAIN_ID = 143;

// Token details — customize these
const TOKEN_CONFIG = {
  name: 'Agent World XYZ',
  symbol: 'XYZ',
  description: 'The blood of Agent World — an autonomous AI agent world simulator on Monad. Agents mine, trade, build, fight, and form alliances. $REAI fuels every action: deploying agents, claiming land, building structures, and brain fees for AI decisions. Burned on every action = deflationary. Built for Moltiverse Hackathon.',
  website: '', // fill before launch
  twitter: '', // fill before launch
  telegram: '',
};

// Nad.fun contract addresses (Monad Mainnet)
const CONTRACTS = {
  BondingCurveRouter: '0x6F6B8F1a20703309951a5127c45B49b1CD981A22',
  Curve: '0xA7283d07812a02AFB7C09B60f8896bCEA3F90aCE',
  Lens: '0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea',
};

// BondingCurveRouter ABI (only the create function we need)
const ROUTER_ABI = [
  'function create(address token, string name, string symbol, string tokenURI, uint256 actionId) payable returns (address)',
];

// Curve ABI (to read deploy fee)
const CURVE_ABI = [
  'function feeConfig() view returns (uint256 deployFee, uint256 tradeFeePercent, uint256 listThreshold)',
];

const isDryRun = process.argv.includes('--dry-run');

// ===== HELPERS =====

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
  console.log(`[LAUNCH] ${msg}`);
}

function logError(msg) {
  console.error(`[LAUNCH ERROR] ${msg}`);
}

// ===== STEP 1: Upload Image =====
async function uploadImage(imagePath) {
  log(`Uploading image: ${imagePath}`);

  const imageBuffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

  const formData = new FormData();
  formData.append('file', new Blob([imageBuffer], { type: contentType }), path.basename(imagePath));

  const res = await fetch(`${NADFUN_API}/agent/token/image`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Image upload failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  log(`Image uploaded: ${data.image_uri || data.url || JSON.stringify(data)}`);
  return data.image_uri || data.url || data;
}

// ===== STEP 2: Upload Metadata =====
async function uploadMetadata(imageUri) {
  log('Uploading metadata...');

  const metadata = {
    name: TOKEN_CONFIG.name,
    symbol: TOKEN_CONFIG.symbol,
    description: TOKEN_CONFIG.description,
    image_uri: imageUri,
  };

  // Add optional fields if provided
  if (TOKEN_CONFIG.website) metadata.website = TOKEN_CONFIG.website;
  if (TOKEN_CONFIG.twitter) metadata.twitter = TOKEN_CONFIG.twitter;
  if (TOKEN_CONFIG.telegram) metadata.telegram = TOKEN_CONFIG.telegram;

  const res = await fetch(`${NADFUN_API}/agent/token/metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Metadata upload failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  log(`Metadata uploaded: ${data.metadata_uri || data.token_uri || JSON.stringify(data)}`);
  return data.metadata_uri || data.token_uri || data;
}

// ===== STEP 3: Mine Salt (vanity address ending in 7777) =====
async function mineSalt(deployerAddress) {
  log(`Mining salt for deployer ${deployerAddress}...`);

  const res = await fetch(`${NADFUN_API}/agent/salt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deployer: deployerAddress,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salt mining failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  log(`Salt mined: ${JSON.stringify(data)}`);
  return data;
}

// ===== STEP 4: On-chain Create =====
async function onChainCreate(wallet, provider, tokenAddress, metadataUri, deployFee) {
  log(`Creating token on-chain...`);
  log(`  Token address: ${tokenAddress}`);
  log(`  Metadata URI: ${metadataUri}`);
  log(`  Deploy fee: ${ethers.formatEther(deployFee)} MON`);

  const router = new ethers.Contract(CONTRACTS.BondingCurveRouter, ROUTER_ABI, wallet);

  // actionId = 1 for Capricorn DEX graduation
  const tx = await router.create(
    tokenAddress,
    TOKEN_CONFIG.name,
    TOKEN_CONFIG.symbol,
    metadataUri,
    1, // actionId: CapricornActor
    { value: deployFee }
  );

  log(`Transaction sent: ${tx.hash}`);
  log('Waiting for confirmation...');

  const receipt = await tx.wait();
  log(`Confirmed in block ${receipt.blockNumber}`);
  log(`Gas used: ${receipt.gasUsed.toString()}`);

  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
}

// ===== GET DEPLOY FEE =====
async function getDeployFee(provider) {
  const curve = new ethers.Contract(CONTRACTS.Curve, CURVE_ABI, provider);
  const [deployFee] = await curve.feeConfig();
  return deployFee;
}

// ===== CHECK IF TOKEN ALREADY CREATED =====
async function checkExistingToken(walletAddress) {
  try {
    const res = await fetch(`${NADFUN_API}/agent/token/created/${walletAddress}`);
    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch {}
  return null;
}

// ===== MAIN =====
async function main() {
  console.log('==========================================');
  console.log('  $REAI Token Launch — Nad.fun Moltiverse');
  console.log('==========================================');
  console.log();

  if (!PRIVATE_KEY) {
    logError('MASTER_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  // Setup provider and wallet
  const provider = new ethers.JsonRpcProvider(MONAD_RPC, { chainId: CHAIN_ID, name: 'monad' });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  log(`Deployer wallet: ${wallet.address}`);

  // Check balance
  const balance = await provider.getBalance(wallet.address);
  const balanceEth = ethers.formatEther(balance);
  log(`Wallet balance: ${balanceEth} MON`);

  // Check deploy fee
  let deployFee;
  try {
    deployFee = await getDeployFee(provider);
    log(`Deploy fee: ${ethers.formatEther(deployFee)} MON`);
  } catch (err) {
    log(`Could not read deploy fee from contract: ${err.message}`);
    log('Using default estimate of 10 MON');
    deployFee = ethers.parseEther('10');
  }

  if (balance < deployFee) {
    logError(`Insufficient balance! Need ${ethers.formatEther(deployFee)} MON but have ${balanceEth} MON`);
    logError(`Send more MON to ${wallet.address} before launching`);
    process.exit(1);
  }

  // Check if already created
  const existing = await checkExistingToken(wallet.address);
  if (existing && existing.token) {
    log(`Token already created by this wallet: ${JSON.stringify(existing)}`);
    log('Exiting. Use a different wallet or check nad.fun.');
    process.exit(0);
  }

  // Find token image
  const imageCandidates = [
    path.join(__dirname, '..', 'token-image.png'),
    path.join(__dirname, '..', 'token-image.jpg'),
    path.join(__dirname, '..', 'public', 'token-image.png'),
    path.join(__dirname, '..', 'logo.png'),
  ];

  let imagePath = imageCandidates.find(p => fs.existsSync(p));
  if (!imagePath) {
    logError('No token image found! Place a token-image.png in the project root.');
    logError(`Checked: ${imageCandidates.join(', ')}`);
    process.exit(1);
  }

  log(`Using image: ${imagePath}`);
  console.log();
  log('Token config:');
  log(`  Name: ${TOKEN_CONFIG.name}`);
  log(`  Symbol: ${TOKEN_CONFIG.symbol}`);
  log(`  Description: ${TOKEN_CONFIG.description.slice(0, 80)}...`);
  console.log();

  if (isDryRun) {
    log('=== DRY RUN MODE — skipping actual transactions ===');
    console.log();
  }

  // STEP 1: Upload image
  let imageUri;
  try {
    imageUri = await uploadImage(imagePath);
  } catch (err) {
    logError(`Step 1 failed: ${err.message}`);
    process.exit(1);
  }
  await sleep(1000);

  // STEP 2: Upload metadata
  let metadataUri;
  try {
    metadataUri = await uploadMetadata(imageUri);
  } catch (err) {
    logError(`Step 2 failed: ${err.message}`);
    process.exit(1);
  }
  await sleep(1000);

  // STEP 3: Mine salt
  let saltData;
  try {
    saltData = await mineSalt(wallet.address);
  } catch (err) {
    logError(`Step 3 failed: ${err.message}`);
    process.exit(1);
  }
  await sleep(1000);

  const tokenAddress = saltData.token || saltData.address || saltData.tokenAddress;
  if (!tokenAddress) {
    logError(`Salt response missing token address: ${JSON.stringify(saltData)}`);
    process.exit(1);
  }

  // STEP 4: On-chain create
  if (isDryRun) {
    log('DRY RUN: Would create token on-chain with:');
    log(`  Token: ${tokenAddress}`);
    log(`  MetadataURI: ${metadataUri}`);
    log(`  Deploy fee: ${ethers.formatEther(deployFee)} MON`);
    log(`  ActionId: 1 (Capricorn)`);
  } else {
    try {
      const result = await onChainCreate(wallet, provider, tokenAddress, metadataUri, deployFee);
      console.log();
      console.log('==========================================');
      console.log('  TOKEN LAUNCHED SUCCESSFULLY!');
      console.log('==========================================');
      console.log(`  Token: ${tokenAddress}`);
      console.log(`  TX: ${result.txHash}`);
      console.log(`  Block: ${result.blockNumber}`);
      console.log(`  View: https://nad.fun/token/${tokenAddress}`);
      console.log(`  Explorer: https://monadscan.com/tx/${result.txHash}`);
      console.log('==========================================');

      // Save token info to .env
      const envPath = path.join(__dirname, '..', '.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      if (!envContent.includes('XYZ_TOKEN_ADDRESS')) {
        fs.appendFileSync(envPath, `\nXYZ_TOKEN_ADDRESS=${tokenAddress}\nXYZ_LAUNCH_TX=${result.txHash}\n`);
        log('Token address saved to .env');
      }
    } catch (err) {
      logError(`Step 4 failed: ${err.message}`);
      if (err.data) logError(`Revert data: ${err.data}`);
      process.exit(1);
    }
  }

  console.log();
  log('Done!');
}

main().catch(err => {
  logError(err.message);
  console.error(err);
  process.exit(1);
});
