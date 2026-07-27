import { createConfig, factory } from "ponder";
import { http, parseAbiItem, type Transport } from "viem";
// ABIs come from the shared workspace package so contract changes only need
// to be synced in packages/abis.
import {
  exnihiloPoolAbi,
  exnihiloFactoryAbi,
  positionNFTAbi,
  lpNFTAbi,
} from "@exnihilio/abis";
import {
  INDEXED_CHAIN_ID,
  FACTORY_ADDRESS,
  POSITION_NFT_ADDRESS,
  LP_NFT_ADDRESS,
  START_BLOCK,
} from "./src/chain.js";

// The public Avalanche RPC rejects eth_getLogs ranges above 2048 blocks with
// an error Ponder doesn't recognize as retryable-with-smaller-range, so it
// fails fatally. This transport splits oversized getLogs calls into chunks.
const MAX_BLOCK_RANGE = 2000n;

function chunkedHttp(url: string | undefined): Transport {
  const base = http(url);
  return (config) => {
    const inner = base(config);
    return {
      ...inner,
      async request(args: any): Promise<any> {
        if (args.method === "eth_getLogs") {
          const param = args.params?.[0];
          const from = param?.fromBlock;
          const to = param?.toBlock;
          if (
            typeof from === "string" && from.startsWith("0x") &&
            typeof to === "string" && to.startsWith("0x") &&
            BigInt(to) - BigInt(from) > MAX_BLOCK_RANGE
          ) {
            const toB = BigInt(to);
            const logs: any[] = [];
            for (let start = BigInt(from); start <= toB; start += MAX_BLOCK_RANGE + 1n) {
              const end = start + MAX_BLOCK_RANGE > toB ? toB : start + MAX_BLOCK_RANGE;
              const chunk = await inner.request({
                ...args,
                params: [{
                  ...param,
                  fromBlock: `0x${start.toString(16)}`,
                  toBlock: `0x${end.toString(16)}`,
                }],
              });
              logs.push(...(chunk as any[]));
            }
            return logs;
          }
        }
        return inner.request(args);
      },
    } as ReturnType<Transport>;
  };
}

export default createConfig({
  networks: {
    indexedChain: {
      chainId: INDEXED_CHAIN_ID,
      transport: chunkedHttp(process.env[`PONDER_RPC_URL_${INDEXED_CHAIN_ID}`]),
    },
  },
  contracts: {
    EXNIHILOFactory: {
      network: "indexedChain",
      abi: exnihiloFactoryAbi,
      address: FACTORY_ADDRESS,
      startBlock: START_BLOCK,
    },
    EXNIHILOPool: {
      network: "indexedChain",
      abi: exnihiloPoolAbi,
      address: factory({
        address: FACTORY_ADDRESS,
        event: parseAbiItem(
          "event MarketCreated(address indexed pool, address indexed tokenAddress, address indexed creator, uint256 lpNftId)"
        ),
        parameter: "pool",
      }),
      startBlock: START_BLOCK,
    },
    PositionNFT: {
      network: "indexedChain",
      abi: positionNFTAbi,
      address: POSITION_NFT_ADDRESS,
      startBlock: START_BLOCK,
    },
    LpNFT: {
      network: "indexedChain",
      abi: lpNFTAbi,
      address: LP_NFT_ADDRESS,
      startBlock: START_BLOCK,
    },
  },
});
