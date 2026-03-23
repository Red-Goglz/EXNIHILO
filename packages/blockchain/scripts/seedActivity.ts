/**
 * Seed activity on all Fuji pools — performs swaps, longs, and shorts on every pool.
 * Mints USDC + underlying tokens as needed (MockERC20 has open mint).
 *
 * Usage:
 *   npx hardhat run scripts/seedActivity.ts --network avalancheFujiTestnet
 */
import { ethers } from "hardhat";
import fuji from "../../site/src/contracts/fujiAddresses.json";

const ROUTER = fuji.router;
const USDC_ADDR = fuji.usdc;
const FACTORY_ADDR = fuji.factory;

// How much USDC to use per trade (6 decimals)
const SWAP_USDC = 5n * 1_000_000n; // 5 USDC per swap
const POSITION_USDC = 2n * 1_000_000n; // 2 USDC per long/short

// How many tokens to use for token→USDC swaps (18 decimals default)
const SWAP_TOKEN_AMOUNT = (decimals: number) => 10n * 10n ** BigInt(decimals);

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`Signer: ${signer.address}`);

  const factory = await ethers.getContractAt("EXNIHILOFactory", FACTORY_ADDR);
  const usdc = await ethers.getContractAt("MockERC20", USDC_ADDR);
  const router = await ethers.getContractAt("EXNIHILORouter", ROUTER);

  const poolCount = Number(await factory.allPoolsLength());
  console.log(`Found ${poolCount} pools\n`);

  // Collect pool info
  const pools: {
    symbol: string;
    address: string;
    tokenAddress: string;
    tokenDecimals: number;
  }[] = [];

  for (const [symbol, addr] of Object.entries(fuji.pools)) {
    const pool = await ethers.getContractAt("EXNIHILOPool", addr);
    const tokenAddr = await pool.underlyingToken();
    const token = await ethers.getContractAt("MockERC20", tokenAddr);
    const decimals = Number(await token.decimals());
    pools.push({ symbol, address: addr, tokenAddress: tokenAddr, tokenDecimals: decimals });
    console.log(`  ${symbol} pool=${addr} token=${tokenAddr} (${decimals} dec)`);
  }

  // Mint USDC for all trades: per pool we need SWAP_USDC + POSITION_USDC*2
  const usdcPerPool = SWAP_USDC + POSITION_USDC * 2n;
  const totalUsdc = usdcPerPool * BigInt(pools.length);
  console.log(`\nMinting ${ethers.formatUnits(totalUsdc, 6)} USDC...`);
  await (await usdc.mint(signer.address, totalUsdc)).wait();

  // Approve USDC to router for all trades
  console.log("Approving USDC to router...");
  await (await usdc.approve(ROUTER, totalUsdc)).wait();

  for (const p of pools) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`${p.symbol} — ${p.address}`);
    console.log("=".repeat(60));

    const pool = await ethers.getContractAt("EXNIHILOPool", p.address);
    const token = await ethers.getContractAt("MockERC20", p.tokenAddress);

    // ── 1. Swap: USDC → Token (via router) ──────────────────────────────────
    try {
      console.log(`  [swap] USDC → ${p.symbol}: ${ethers.formatUnits(SWAP_USDC, 6)} USDC`);
      const tx1 = await router.swap(p.address, SWAP_USDC, 0n, false); // tokenToUsdc=false
      const r1 = await tx1.wait();
      console.log(`    ✓ tx ${r1!.hash}`);
    } catch (e: any) {
      console.log(`    ✗ ${e.reason || e.message}`);
    }

    // ── 2. Swap: Token → USDC (via router) ──────────────────────────────────
    try {
      const swapTokenAmt = SWAP_TOKEN_AMOUNT(p.tokenDecimals);
      // Mint some tokens for the reverse swap
      await (await token.mint(signer.address, swapTokenAmt)).wait();
      await (await token.approve(ROUTER, swapTokenAmt)).wait();

      console.log(`  [swap] ${p.symbol} → USDC: ${ethers.formatUnits(swapTokenAmt, p.tokenDecimals)} ${p.symbol}`);
      const tx2 = await router.swap(p.address, swapTokenAmt, 0n, true); // tokenToUsdc=true
      const r2 = await tx2.wait();
      console.log(`    ✓ tx ${r2!.hash}`);
    } catch (e: any) {
      console.log(`    ✗ ${e.reason || e.message}`);
    }

    // ── 3. Open Long (via router) ───────────────────────────────────────────
    try {
      console.log(`  [long] ${ethers.formatUnits(POSITION_USDC, 6)} USDC notional`);
      const tx3 = await router.openLong(p.address, POSITION_USDC, 0n);
      const r3 = await tx3.wait();
      console.log(`    ✓ tx ${r3!.hash}`);
    } catch (e: any) {
      console.log(`    ✗ ${e.reason || e.message}`);
    }

    // ── 4. Open Short (via router) ──────────────────────────────────────────
    try {
      console.log(`  [short] ${ethers.formatUnits(POSITION_USDC, 6)} USDC notional`);
      const tx4 = await router.openShort(p.address, POSITION_USDC, 0n);
      const r4 = await tx4.wait();
      console.log(`    ✓ tx ${r4!.hash}`);
    } catch (e: any) {
      console.log(`    ✗ ${e.reason || e.message}`);
    }

    // ── Print prices after activity ─────────────────────────────────────────
    try {
      const spot = await pool.spotPrice();
      const long = await pool.longPrice();
      const short = await pool.shortPrice();
      console.log(`  prices — spot: ${ethers.formatUnits(spot, 6)}  long: ${ethers.formatUnits(long, 6)}  short: ${ethers.formatUnits(short, 6)}`);
    } catch { /* skip */ }
  }

  console.log("\n✓ Done — activity seeded on all pools.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
