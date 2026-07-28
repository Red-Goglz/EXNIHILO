/**
 * Avalanche C-Chain **mainnet** deployment — protocol only, no markets.
 *
 * Deploys PositionNFT + PoolDeployer + LpNFT + EXNIHILOFactory + EXNIHILORouter
 * and wires PositionNFT → Factory. It deliberately does NOT deploy:
 *   - MockUSDC      — mainnet uses Circle's native USDC
 *   - mock tokens   — markets are permissionless; anyone creates them
 *   - Faucet        — testnet-only convenience
 *   - any markets   — `createMarket` is left to users
 *
 * Everything in the factory constructor is **immutable**: the factory has no
 * owner and no admin functions, so `usdc`, `protocolTreasury` and
 * `defaultSwapFeeBps` can never be changed. A mistake here means redeploying
 * the entire protocol, which is why this script refuses to guess any of them.
 *
 * LpNFT ↔ Factory is a constructor cycle, resolved by CREATE address
 * prediction: LpNFT is deployed at nonce N and the factory at N+1, so the
 * factory's address is computable before it exists. Any failed transaction in
 * between shifts the nonce and breaks the prediction — the script asserts the
 * prediction held rather than leaving a silently mis-wired deployment.
 *
 * Usage:
 *   MAINNET_PROTOCOL_TREASURY=0x... \
 *     npx hardhat run scripts/deployMainnet.ts --network avalanche
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const AVALANCHE_CHAIN_ID = 43114n;

/** Circle-issued native USDC on Avalanche C-Chain (6 decimals). */
const NATIVE_USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";

async function main() {
  // DRY_RUN is for the forked rehearsal (see hardhat.config.ts). It only
  // relaxes the chain-id guard — every other check still runs against real
  // forked mainnet state, so the rehearsal exercises the production path.
  const dryRun = !!process.env.DRY_RUN;
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== AVALANCHE_CHAIN_ID && !dryRun) {
    throw new Error(
      `Refusing to run: expected Avalanche mainnet (${AVALANCHE_CHAIN_ID}), got ${net.chainId}. ` +
        `Use --network avalanche.`,
    );
  }
  if (dryRun) {
    console.log("*** DRY RUN — forked state, nothing is spent ***\n");
    // Mine one local block so subsequent calls execute on a hardhat-owned block
    // instead of the forked head. EDR refuses to execute at the fork block for
    // a chain it has no hardfork history for (Avalanche), and the `chains`
    // config alone does not satisfy it.
    await network.provider.send("evm_mine");
  }

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  // The treasury is immutable and receives all protocol fees. Falling back to
  // the deployer (as the testnet script does) would silently hand fee custody
  // to the same hot key that signs deployments, so require it explicitly.
  const treasury = process.env.MAINNET_PROTOCOL_TREASURY?.trim();
  if (!treasury || !ethers.isAddress(treasury)) {
    throw new Error(
      "MAINNET_PROTOCOL_TREASURY must be set to a valid address. It is immutable " +
        "on the factory and receives all protocol fees — this script will not guess it.",
    );
  }
  if (treasury === ethers.ZeroAddress) {
    throw new Error("MAINNET_PROTOCOL_TREASURY must not be the zero address.");
  }

  const usdc = (process.env.MAINNET_USDC?.trim() || NATIVE_USDC) as string;
  const defaultSwapFeeBps = BigInt(process.env.DEFAULT_SWAP_FEE_BPS?.trim() || "100");

  // A wrong USDC address bricks every market that will ever be created, and the
  // pool maths assumes 6 decimals throughout. Verify against the live chain.
  const usdcCode = await ethers.provider.getCode(usdc);
  if (usdcCode === "0x") throw new Error(`USDC address ${usdc} has no contract code.`);
  const erc20 = new ethers.Contract(
    usdc,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
    ],
    ethers.provider,
  );
  const usdcSymbol = await erc20.symbol();
  const usdcDecimals = await erc20.decimals();
  if (Number(usdcDecimals) !== 6) {
    throw new Error(`USDC at ${usdc} reports ${usdcDecimals} decimals; the protocol assumes 6.`);
  }

  console.log("─".repeat(70));
  console.log("EXNIHILO — Avalanche mainnet deployment (protocol only)");
  console.log("─".repeat(70));
  console.log("  chainId:   ", net.chainId.toString());
  console.log("  deployer:  ", deployer.address);
  console.log("  balance:   ", ethers.formatEther(balance), "AVAX");
  console.log("  treasury:  ", treasury);
  console.log("  USDC:      ", usdc, `(${usdcSymbol}, ${usdcDecimals} dec)`);
  console.log("  swap fee:  ", defaultSwapFeeBps.toString(), "bps");
  console.log("─".repeat(70));

  if (balance < ethers.parseEther("0.05")) {
    throw new Error(`Deployer balance ${ethers.formatEther(balance)} AVAX is too low.`);
  }

  // ── 1. PositionNFT ────────────────────────────────────────────────────────
  const positionNFT = await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer)
    .deploy();
  await positionNFT.waitForDeployment();
  const positionNFTAddress = await positionNFT.getAddress();
  console.log("PositionNFT: ", positionNFTAddress);

  // ── 2. PoolDeployer ───────────────────────────────────────────────────────
  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
    .connect(deployer)
    .deploy();
  await poolDeployer.waitForDeployment();
  const poolDeployerAddress = await poolDeployer.getAddress();
  console.log("PoolDeployer:", poolDeployerAddress);

  // ── 3. LpNFT + Factory (nonce prediction) ─────────────────────────────────
  const nonceBeforeLpNFT = await deployer.getNonce();
  const predictedFactoryAddress = ethers.getCreateAddress({
    from: deployer.address,
    nonce: nonceBeforeLpNFT + 1,
  });

  const lpNFT = await (await ethers.getContractFactory("LpNFT"))
    .connect(deployer)
    .deploy(predictedFactoryAddress);
  await lpNFT.waitForDeployment();
  const lpNFTAddress = await lpNFT.getAddress();
  console.log("LpNFT:       ", lpNFTAddress);

  const factory = await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(deployer)
    .deploy(
      positionNFTAddress,
      lpNFTAddress,
      usdc,
      treasury,
      defaultSwapFeeBps,
      poolDeployerAddress,
    );
  const factoryReceipt = await factory.deploymentTransaction()!.wait();
  const factoryAddress = await factory.getAddress();
  const factoryBlock = factoryReceipt!.blockNumber;

  if (factoryAddress.toLowerCase() !== predictedFactoryAddress.toLowerCase()) {
    throw new Error(
      `Factory address mismatch — LpNFT points at the wrong factory.\n` +
        `  predicted: ${predictedFactoryAddress}\n  actual:    ${factoryAddress}`,
    );
  }
  const lpNftFactory = await lpNFT.factory();
  if (lpNftFactory.toLowerCase() !== factoryAddress.toLowerCase()) {
    throw new Error(`LpNFT.factory mismatch: ${lpNftFactory} != ${factoryAddress}`);
  }
  console.log("Factory:     ", factoryAddress, `(block ${factoryBlock}, LpNFT.factory ✓)`);

  // ── 4. Wire PositionNFT → Factory ─────────────────────────────────────────
  await (await positionNFT.connect(deployer).initFactory(factoryAddress)).wait();
  console.log("PositionNFT.initFactory ✓");

  // ── 5. Router ─────────────────────────────────────────────────────────────
  const router = await (await ethers.getContractFactory("EXNIHILORouter"))
    .connect(deployer)
    .deploy(factoryAddress, usdc);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  console.log("Router:      ", routerAddress);

  // ── 6. Post-deploy assertions against the live chain ──────────────────────
  const onchain = {
    usdc: await factory.usdc(),
    treasury: await factory.protocolTreasury(),
    fee: await factory.defaultSwapFeeBps(),
    positionNFT: await factory.positionNFT(),
    admin: await factory.deployer(),
  };
  if (onchain.usdc.toLowerCase() !== usdc.toLowerCase())
    throw new Error(`factory.usdc mismatch: ${onchain.usdc}`);
  if (onchain.treasury.toLowerCase() !== treasury.toLowerCase())
    throw new Error(`factory.protocolTreasury mismatch: ${onchain.treasury}`);
  if (onchain.fee !== defaultSwapFeeBps)
    throw new Error(`factory.defaultSwapFeeBps mismatch: ${onchain.fee}`);
  console.log("On-chain immutables verified ✓");
  console.log("Emergency admin (factory.deployer):", onchain.admin);

  // ── 7. Write addresses ────────────────────────────────────────────────────
  const addresses = {
    chainId: 43114,
    factory: factoryAddress,
    poolDeployer: poolDeployerAddress,
    positionNFT: positionNFTAddress,
    lpNFT: lpNFTAddress,
    usdc,
    router: routerAddress,
    treasury,
    deployer: deployer.address,
    startBlock: factoryBlock,
    pools: {},
  };
  console.log(JSON.stringify(addresses, null, 2));
  if (dryRun) {
    // Never let a rehearsal overwrite the real address book — fork addresses
    // would point the live site at contracts that do not exist on mainnet.
    console.log("\n(dry run — mainnetAddresses.json NOT written)");
  } else {
    const outPath = path.resolve(__dirname, "../../site/src/contracts/mainnetAddresses.json");
    fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2) + "\n");
    console.log("\n✓ Addresses written to", outPath);
  }

  console.log("\nIndexer: set PONDER_CHAIN_ID=43114 and PONDER_START_BLOCK=" + factoryBlock);
  console.log("\nVerify on Snowtrace:");
  console.log(`  npx hardhat verify --network avalanche ${positionNFTAddress}`);
  console.log(`  npx hardhat verify --network avalanche ${poolDeployerAddress}`);
  console.log(`  npx hardhat verify --network avalanche ${lpNFTAddress} "${factoryAddress}"`);
  console.log(
    `  npx hardhat verify --network avalanche ${factoryAddress} "${positionNFTAddress}" "${lpNFTAddress}" "${usdc}" "${treasury}" ${defaultSwapFeeBps} "${poolDeployerAddress}"`,
  );
  console.log(`  npx hardhat verify --network avalanche ${routerAddress} "${factoryAddress}" "${usdc}"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
