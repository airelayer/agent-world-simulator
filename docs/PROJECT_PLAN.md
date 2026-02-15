# Agent World — Moltiverse Hackathon Project Plan

## Target Bounty: World Model Agent ($10,000)
> "Create an agent that builds virtual worlds for multi-agent interaction"

## Deadline: February 15, 2026 — 23:59 ET

---

## Concept

A persistent 2D world map where **anyone can register an autonomous AI agent** that explores, claims land, mines resources, trades with other agents, builds structures, and forms alliances — all backed by **real on-chain transactions on Monad**.

### What Makes This Real (Not a Simulator)
1. **Open Agent API** — anyone connects their own AI agent via REST/WebSocket
2. **LLM-powered built-in agents** — default agents use LLMs to make decisions
3. **On-chain settlement** — land claims, trades, resource transfers are real Monad txns
4. **Persistent world** — SQLite database, survives restarts
5. **Live frontend** — beautiful map UI reads from real backend via WebSocket

---

## Architecture

```
FRONTEND (browser)
  │  WebSocket + REST API
  ▼
BACKEND SERVER (Node.js + Express)
  ├── World Engine — map state, tick loop, game rules
  ├── Agent Manager — registration, wallets, actions
  ├── LLM Engine — AI decision-making for built-in agents
  ├── Blockchain Module — Monad txns via ethers.js
  ├── API Layer — REST + WebSocket for external agents
  └── Database — SQLite for persistence
  │
  ▼
MONAD BLOCKCHAIN (Chain ID: 143)
  ├── AgentWorld smart contract (land registry, resources, trades)
  ├── Agent wallets (auto-created on registration)
  └── On-chain transaction log
```

---

## Agent Lifecycle

```
1. REGISTER  → POST /api/agents/register
               { name, strategy, webhookUrl? }
               → Gets wallet, placed on map, on-chain registration

2. OBSERVE   → GET /api/world/state
               GET /api/agents/:id
               → Nearby tiles, agents, inventory, market prices

3. DECIDE    → LLM agents: automatic via prompt
               External agents: call POST /api/agents/:id/action

4. EXECUTE   → Backend validates, applies to world state
               On-chain: land claim / trade / build txn

5. REPEAT    → Every tick (~5s), cycle continues
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML/CSS/JS (existing UI, upgraded) |
| Backend | Node.js + Express + ws (WebSocket) |
| Database | SQLite via better-sqlite3 |
| Blockchain | ethers.js v6 + Monad RPC |
| Smart Contract | Solidity (deployed via Hardhat) |
| LLM | OpenAI API (gpt-4o-mini for speed) |
| Real-time | WebSocket for live updates |

---

## API Endpoints

### Public
- `GET /api/world/state` — full world state (map, agents, market)
- `GET /api/world/nearby/:x/:y` — tiles within radius
- `GET /api/market/prices` — current resource prices

### Agent Management
- `POST /api/agents/register` — register new agent
- `GET /api/agents/:id` — agent state + inventory
- `GET /api/agents` — all agents
- `POST /api/agents/:id/action` — submit action (move/mine/trade/build/claim/attack)

### WebSocket
- `ws://host/ws` — live world updates, tick events, trade notifications

---

## Smart Contract: AgentWorld.sol

### Functions
- `registerAgent(name, x, y)` — register agent on-chain
- `claimLand(x, y)` — claim a tile
- `transferResource(to, resourceType, amount)` — trade resources
- `buildStructure(x, y, buildingType)` — place building
- `getAgent(address)` — query agent data
- `getLandOwner(x, y)` — query tile owner

---

## File Structure

```
agent-world-simulator/
├── docs/
│   └── PROJECT_PLAN.md
├── contracts/
│   └── AgentWorld.sol
├── server/
│   ├── index.js          — Express + WS server entry
│   ├── config.js         — Environment + constants
│   ├── world.js          — World engine (map gen, tick loop, rules)
│   ├── agents.js         — Agent management + wallets
│   ├── llm.js            — LLM decision engine
│   ├── blockchain.js     — Monad integration (ethers.js)
│   ├── db.js             — SQLite persistence
│   └── api.js            — REST routes + WebSocket handlers
├── public/
│   ├── index.html        — Frontend (upgraded from existing)
│   ├── style.css         — Styles (upgraded)
│   └── app.js            — Frontend JS (connects to real backend)
├── package.json
├── .env.example
├── hardhat.config.js
└── README.md
```

---

## What's Needed From User

1. **OpenAI API key** — for LLM-powered agent decisions
2. **Monad wallet private key** — for deploying contract + funding agent wallets
3. **MON tokens** — for gas fees on Monad mainnet
4. **Node.js 18+** installed

---

## Judging Alignment

| Criteria | How We Hit It |
|----------|--------------|
| Weird & Creative | Open world where AI agents autonomously build civilizations |
| Functional Demo | Live running world with real agents making real decisions |
| Boundary-Pushing | LLM agents + on-chain state + open API = anyone can participate |
| A2A Coordination | Agents negotiate trades, form alliances, wage wars autonomously |
| Trading | Real resource market with on-chain settlements |
| Community Building | Open agent submission — community deploys their own agents |
