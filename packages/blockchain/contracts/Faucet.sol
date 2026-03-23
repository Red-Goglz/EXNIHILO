// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
}

/**
 * @title Faucet
 * @notice Testnet faucet — dispenses MockUSDC (via mint) and AVAX (from balance).
 *         One claim per address per cooldown period.
 */
contract Faucet {
    IMintableERC20 public immutable usdc;
    uint256 public usdcAmount  = 10_000 * 1e6;   // 10 000 MockUSDC
    uint256 public avaxAmount  = 0.1 ether;       // ~10 txs on Fuji
    uint256 public cooldown    = 24 hours;

    address public owner;
    mapping(address => uint256) public lastClaim;

    event Claimed(address indexed user, uint256 usdcAmount, uint256 avaxAmount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address usdc_) {
        usdc  = IMintableERC20(usdc_);
        owner = msg.sender;
    }

    /// @notice Claim testnet USDC + AVAX. Once per cooldown.
    function claim() external {
        require(
            block.timestamp >= lastClaim[msg.sender] + cooldown,
            "cooldown active"
        );
        lastClaim[msg.sender] = block.timestamp;

        usdc.mint(msg.sender, usdcAmount);

        uint256 avaxToSend = avaxAmount;
        if (avaxToSend > address(this).balance) {
            avaxToSend = address(this).balance;
        }
        if (avaxToSend > 0) {
            (bool ok, ) = msg.sender.call{value: avaxToSend}("");
            require(ok, "AVAX transfer failed");
        }

        emit Claimed(msg.sender, usdcAmount, avaxToSend);
    }

    // ── Owner config ────────────────────────────────────────────────────────

    function setAmounts(uint256 usdcAmount_, uint256 avaxAmount_) external onlyOwner {
        usdcAmount = usdcAmount_;
        avaxAmount = avaxAmount_;
    }

    function setCooldown(uint256 cooldown_) external onlyOwner {
        cooldown = cooldown_;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    /// @notice Withdraw AVAX from faucet.
    function withdraw() external onlyOwner {
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }

    receive() external payable {}
}
