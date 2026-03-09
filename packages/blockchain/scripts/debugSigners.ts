import { ethers } from "hardhat";

async function main() {
  const signers = await ethers.getSigners();

  console.log("All signers:");
  for (let i = 0; i < signers.length; i++) {
    const balance = await ethers.provider.getBalance(signers[i].address);
    const nonce = await ethers.provider.getTransactionCount(signers[i].address);
    console.log(`  [${i}] ${signers[i].address}  balance=${ethers.formatEther(balance)} ETH  nonce=${nonce}`);
  }

  // Try deploying a simple contract (DeployHelper) from each signer
  const SimpleF = await ethers.getContractFactory("DeployHelper");

  for (let i = 8; i <= 11; i++) {
    try {
      const c = await SimpleF.connect(signers[i]).deploy();
      await c.waitForDeployment();
      console.log(`\nSigner ${i} CAN deploy contracts.`);
    } catch (e: any) {
      console.log(`\nSigner ${i} CANNOT deploy: ${e.message.substring(0, 100)}`);
    }
  }
}

main().catch(console.error);
