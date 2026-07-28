import { ethers } from "hardhat";
async function main() {
  const [d] = await ethers.getSigners();
  const fee = await ethers.provider.getFeeData();
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice!;
  console.log("gasPrice(maxFee):", ethers.formatUnits(gasPrice, "gwei"), "gwei");

  const USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
  const dummy = d.address;
  const est = async (name: string, args: any[]) => {
    const F = await ethers.getContractFactory(name);
    const tx = await F.getDeployTransaction(...args);
    const g = await ethers.provider.estimateGas({ ...tx, from: d.address });
    console.log(`${name.padEnd(16)} gas=${g.toString().padStart(9)}  cost=${ethers.formatEther(g * gasPrice)} AVAX`);
    return g;
  };
  let total = 0n;
  total += await est("PositionNFT", []);
  total += await est("PoolDeployer", []);
  total += await est("LpNFT", [dummy]);
  total += await est("EXNIHILOFactory", [dummy, dummy, USDC, dummy, 100n, dummy]);
  total += await est("EXNIHILORouter", [dummy, USDC]);
  total += 100_000n; // initFactory tx
  console.log("─".repeat(60));
  console.log("TOTAL gas:", total.toString());
  console.log("TOTAL cost:", ethers.formatEther(total * gasPrice), "AVAX");
  const bal = await ethers.provider.getBalance(d.address);
  console.log("Balance:   ", ethers.formatEther(bal), "AVAX");
  console.log("Headroom:  ", ethers.formatEther(bal - total * gasPrice), "AVAX");
}
main().catch(e=>{console.error(e);process.exit(1);});
