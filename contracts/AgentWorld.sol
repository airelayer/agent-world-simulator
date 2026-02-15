// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgentWorld
 * @notice On-chain registry for Agent World — autonomous AI agents on Monad
 * @dev Moltiverse Hackathon. All writes go through the server (owner).
 */
contract AgentWorld {
    address public owner;

    struct Agent {
        string name;
        address wallet;
        uint16 x;
        uint16 y;
        bool alive;
        uint256 registeredAt;
    }

    struct LandTile {
        address claimedBy;
        string building;
        uint256 claimedAt;
    }

    // Agent registry by wallet address
    mapping(address => Agent) public agents;
    address[] public agentAddresses;
    uint256 public agentCount;

    // Land ownership: keccak256(x, y) => LandTile
    mapping(bytes32 => LandTile) public land;
    uint256 public totalClaims;
    uint256 public tradeCount;
    uint256 public buildCount;

    // Events — these are indexed on-chain and visible on explorers
    event AgentRegistered(address indexed wallet, string name, uint16 x, uint16 y);
    event LandClaimed(address indexed wallet, uint16 x, uint16 y);
    event TradeExecuted(address indexed from, address indexed to, string resourceFrom, string resourceTo, uint256 amount);
    event StructureBuilt(address indexed wallet, uint16 x, uint16 y, string buildingType);
    event AgentDied(address indexed wallet, string name);
    event AgentMoved(address indexed wallet, uint16 x, uint16 y);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function _tileKey(uint16 x, uint16 y) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(x, y));
    }

    // Server registers agents on their behalf (agents don't need MON for gas)
    function registerAgent(address wallet, string calldata name, uint16 x, uint16 y) external onlyOwner {
        require(bytes(agents[wallet].name).length == 0, "Already registered");
        require(bytes(name).length > 0, "Empty name");

        agents[wallet] = Agent({
            name: name,
            wallet: wallet,
            x: x,
            y: y,
            alive: true,
            registeredAt: block.timestamp
        });
        agentAddresses.push(wallet);
        agentCount++;

        // Auto-claim spawn tile
        bytes32 key = _tileKey(x, y);
        land[key] = LandTile({ claimedBy: wallet, building: "", claimedAt: block.timestamp });
        totalClaims++;

        emit AgentRegistered(wallet, name, x, y);
        emit LandClaimed(wallet, x, y);
    }

    function claimLand(address wallet, uint16 x, uint16 y) external onlyOwner {
        require(agents[wallet].alive, "Not alive");
        bytes32 key = _tileKey(x, y);
        land[key] = LandTile({
            claimedBy: wallet,
            building: land[key].claimedBy != address(0) ? land[key].building : "",
            claimedAt: block.timestamp
        });
        totalClaims++;
        agents[wallet].x = x;
        agents[wallet].y = y;
        emit LandClaimed(wallet, x, y);
    }

    function recordTrade(
        address from, address to,
        string calldata resourceFrom, string calldata resourceTo,
        uint256 amount
    ) external onlyOwner {
        tradeCount++;
        emit TradeExecuted(from, to, resourceFrom, resourceTo, amount);
    }

    function buildStructure(address wallet, uint16 x, uint16 y, string calldata buildingType) external onlyOwner {
        require(agents[wallet].alive, "Not alive");
        bytes32 key = _tileKey(x, y);
        land[key].building = buildingType;
        buildCount++;
        emit StructureBuilt(wallet, x, y, buildingType);
    }

    function moveAgent(address wallet, uint16 x, uint16 y) external onlyOwner {
        require(agents[wallet].alive, "Not alive");
        agents[wallet].x = x;
        agents[wallet].y = y;
        emit AgentMoved(wallet, x, y);
    }

    function markDead(address wallet) external onlyOwner {
        require(agents[wallet].alive, "Already dead");
        agents[wallet].alive = false;
        emit AgentDied(wallet, agents[wallet].name);
    }

    // ===== VIEW FUNCTIONS =====
    function getAgent(address wallet) external view returns (
        string memory name, uint16 x, uint16 y, bool alive, uint256 registeredAt
    ) {
        Agent memory a = agents[wallet];
        return (a.name, a.x, a.y, a.alive, a.registeredAt);
    }

    function getLandOwner(uint16 x, uint16 y) external view returns (address) {
        return land[_tileKey(x, y)].claimedBy;
    }

    function getStats() external view returns (
        uint256 _agentCount, uint256 _totalClaims, uint256 _tradeCount, uint256 _buildCount
    ) {
        return (agentCount, totalClaims, tradeCount, buildCount);
    }

    function getAgentAddresses(uint256 offset, uint256 limit) external view returns (address[] memory) {
        uint256 end = offset + limit;
        if (end > agentAddresses.length) end = agentAddresses.length;
        if (offset >= end) return new address[](0);
        address[] memory result = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = agentAddresses[i];
        }
        return result;
    }

    receive() external payable {}

    function withdraw() external onlyOwner {
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok);
    }
}
