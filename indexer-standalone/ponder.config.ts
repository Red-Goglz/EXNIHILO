import { createConfig, factory } from "ponder";
import { http, parseAbiItem } from "viem";
import { exnihiloPoolAbi } from "./EXNIHILOPool.js";

const FACTORY_ADDRESS = "0xff1A130a559EF125a7cab3665951adFA288D87Fd" as const;
const START_BLOCK = 53_076_564;

export default createConfig({
  networks: {
    avalancheFuji: {
      chainId: 43113,
      transport: http(process.env.PONDER_RPC_URL_43113),
    },
  },
  contracts: {
    EXNIHILOPool: {
      network: "avalancheFuji",
      abi: exnihiloPoolAbi,
      address: factory({
        address: FACTORY_ADDRESS,
        event: parseAbiItem(
          "event MarketCreated(address indexed pool, address indexed tokenAddress, uint256 usdcAmount, uint256 tokenAmount, uint256 lpNftId, address indexed creator, uint256 maxPositionUsd, uint256 maxPositionBps)"
        ),
        parameter: "pool",
      }),
      startBlock: START_BLOCK,
    },
  },
});
