# ABIs

Contract ABIs are exported from the `@exnihilio/abis` workspace package.

## Installation

If building within the monorepo, the ABIs are available as a workspace dependency:

```json
{
  "dependencies": {
    "@exnihilio/abis": "*"
  }
}
```

## Usage

```typescript
import { EXNIHILOPoolAbi } from "@exnihilio/abis/EXNIHILOPool";
import { EXNIHILOFactoryAbi } from "@exnihilio/abis/EXNIHILOFactory";
```

ABIs are exported as `as const` objects, giving you full type safety with Viem and Wagmi.

## Available ABIs

| Import | Contract |
|---|---|
| `EXNIHILOPoolAbi` | Pool AMM + trading |
| `EXNIHILOFactoryAbi` | Factory |
| `PositionNFTAbi` | Position NFTs |
| `LpNFTAbi` | LP NFTs |
| `erc20Abi` | Minimal ERC-20 (balanceOf, approve, allowance, decimals, symbol) |

## With Viem

```typescript
import { readContract } from "viem";
import { EXNIHILOPoolAbi } from "@exnihilio/abis/EXNIHILOPool";

const spotPrice = await readContract(client, {
  address: poolAddress,
  abi: EXNIHILOPoolAbi,
  functionName: "spotPrice",
});
```

## With Wagmi

```typescript
import { useReadContract } from "wagmi";
import { EXNIHILOPoolAbi } from "@exnihilio/abis/EXNIHILOPool";

const { data: spotPrice } = useReadContract({
  address: poolAddress,
  abi: EXNIHILOPoolAbi,
  functionName: "spotPrice",
});
```
