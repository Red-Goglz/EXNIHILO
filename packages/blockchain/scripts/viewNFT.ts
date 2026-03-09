/**
 * Opens a test long position and saves the NFT SVG to /tmp/position-nft.svg
 * Run: npx hardhat run scripts/viewNFT.ts --network localhost
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import addresses from "../../site/src/contracts/localAddresses.json";

async function main() {
  const [deployer] = await ethers.getSigners();
  const factory    = await ethers.getContractAt("EXNIHILOFactory", addresses.factory);
  const usdc       = await ethers.getContractAt("MockERC20", addresses.usdc);
  const nft        = await ethers.getContractAt("PositionNFT", addresses.positionNFT);

  // Find the NOCHILL pool by scanning all pools for matching symbol
  const TARGET_SYMBOL = "NOCHILL";
  let poolAddr: string = "";
  const poolCount = await factory.allPoolsLength();
  for (let i = 0n; i < poolCount; i++) {
    const addr = await factory.allPools(i);
    const pool = await ethers.getContractAt("EXNIHILOPool", addr);
    const memeAddr = await pool.underlyingMeme();
    const meme = await ethers.getContractAt("MockERC20", memeAddr);
    const sym = await meme.symbol();
    if (sym === TARGET_SYMBOL) { poolAddr = addr; break; }
  }
  if (!poolAddr) throw new Error(`No pool found for ${TARGET_SYMBOL}`);
  console.log(`Using ${TARGET_SYMBOL} pool:`, poolAddr);

  const pool = await ethers.getContractAt("EXNIHILOPool", poolAddr!);

  await usdc.approve(poolAddr!, ethers.MaxUint256);
  const memeAddr = await pool.underlyingMeme();
  const meme = await ethers.getContractAt("MockERC20", memeAddr);
  await meme.approve(poolAddr!, ethers.MaxUint256);

  // Open long FIRST at current price
  await pool.openLong(ethers.parseUnits("100", 6), 0n);
  console.log("Opened long position");

  // Then pump price: big USDC→meme swap raises backedAirUsd → long is now in profit
  await pool.swap(ethers.parseUnits("5000", 6), 0n, false);
  console.log("Price pumped → long now in profit");

  // Grab the latest token for this wallet
  const balance = await nft.balanceOf(deployer.address);
  const tokenId = await nft.tokenOfOwnerByIndex(deployer.address, balance - 1n);
  console.log("Token ID:", tokenId.toString());

  // Decode tokenURI → JSON → SVG
  const uri     = await nft.tokenURI(tokenId);
  const json    = JSON.parse(Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString());
  const svg     = Buffer.from(json.image.replace("data:image/svg+xml;base64,", ""), "base64").toString();

  // Write SVG to file
  const outPath = path.resolve(__dirname, "../../../position-nft.svg");
  fs.writeFileSync(outPath, svg);
  console.log("\n✓ SVG saved to:", outPath);
  console.log("  Open it in any browser or VS Code SVG preview.");

  // Also write the full data URI so you can paste it in a browser address bar
  const htmlPath = path.resolve(__dirname, "../../../position-nft.html");
  fs.writeFileSync(htmlPath, `<!DOCTYPE html>
<html><body style="background:#111;display:flex;justify-content:center;padding:40px">
<img src="${json.image}" style="border-radius:8px;box-shadow:0 0 40px #00e5ff33">
</body></html>`);
  console.log("  Or open:", htmlPath, "(styled preview with background)");
}

main().catch(console.error);
