# packages/blockchain

EXNIHILO's Solidity contracts (0.8.24, viaIR, `cancun`) and their Hardhat tests and scripts.

```bash
npx hardhat test                                   # full suite
REPORT_GAS=true npx hardhat test
npx hardhat coverage

npx hardhat node                                   # local chain, then:
npx hardhat run scripts/deployLocal.ts --network localhost

FORK_AVALANCHE=1 DRY_RUN=1 npx hardhat run scripts/deployMainnet.ts   # rehearse on a fork
```

What each contract does: [Architecture](../docs/protocol/architecture.md). Deployments and the
redeploy checklist: [Contract Addresses](../docs/protocol/addresses.md).
