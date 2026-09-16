---
description: "Import EXNIHILO contract ABIs from the @exnihilio/abis workspace package — typed as const for viem and wagmi."
---

# ABIs

Every contract ABI is exported from the `@exnihilio/abis` workspace package as an `as const` array,
so viem and wagmi infer argument and return types.

```ts
import { exnihiloPoolAbi, positionNFTAbi } from "@exnihilio/abis";
```

| Export | Contract |
|---|---|
| `exnihiloPoolAbi` | EXNIHILOPool |
| `exnihiloFactoryAbi` | EXNIHILOFactory |
| `exnihiloRouterAbi` | EXNIHILORouter |
| `positionNFTAbi` | PositionNFT |
| `lpNFTAbi` | LpNFT |
| `preMarketAbi` / `preMarketFactoryAbi` | PreMarket / PreMarketFactory |
| `lockedLpVaultAbi` | LockedLpVault |
| `erc20Abi` | Minimal ERC-20 |

```ts
// viem
const spot = await publicClient.readContract({
  address: pool, abi: exnihiloPoolAbi, functionName: "spotPrice",
});

// wagmi
const { data } = useReadContract({
  address: pool, abi: exnihiloPoolAbi, functionName: "liveAmountsOf", args: [tokenId],
});
```

The files are generated from `packages/blockchain/artifacts` and must be regenerated whenever a
contract's interface changes. For a typed client with pre-flight checks, use the
[SDK](/developers/sdk).
