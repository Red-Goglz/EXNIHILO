import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const accounts = process.env.ACCOUNT_PRIVATE_KEY
  ? [process.env.ACCOUNT_PRIVATE_KEY]
  : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      // OpenZeppelin 5.6 uses `mcopy` (via Strings.sol → Bytes.sol), which is a
      // Cancun opcode. 0.8.24 still defaults to shanghai, so it must be opted
      // into or compilation fails with "Function \"mcopy\" not found".
      // Avalanche C-Chain and Fuji both support Cancun.
      evmVersion: "cancun",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 1,
      },
      metadata: {
        bytecodeHash: "none",
      },
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      // Opt-in mainnet fork, so an irreversible mainnet script can be dry-run
      // end to end against real state without spending AVAX:
      //   FORK_AVALANCHE=1 DRY_RUN=1 npx hardhat run scripts/deployMainnet.ts
      // The fork keeps hardhat's own chain id rather than spoofing 43114 —
      // spoofing makes every call fail with "No known hardfork for execution on
      // historical block", since hardhat ships no hardfork history for 43114.
      // deployMainnet.ts therefore takes DRY_RUN to relax its chain-id guard.
      // Gated behind the env var so normal `hardhat test` stays offline and fast.
      ...(process.env.FORK_AVALANCHE
        ? {
            forking: {
              url: process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc",
              // Pin the fork block: forking at "latest" makes EDR treat calls as
              // executing at a historical block and ignore the hardforkHistory
              // below, so every call fails regardless of the chains config.
              ...(process.env.FORK_BLOCK
                ? { blockNumber: Number(process.env.FORK_BLOCK) }
                : {}),
            },
            // Executing against forked state uses the *remote* chain id (43114),
            // and hardhat ships no hardfork activation history for Avalanche —
            // without this every call fails with "No known hardfork for
            // execution on historical block".
            chains: {
              43114: { hardforkHistory: { cancun: 0 } },
            },
          }
        : {}),
    },
    // ── Avalanche C-Chain mainnet ──────────────────────────────────────────
    avalanche: {
      url: process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc",
      chainId: 43114,
      accounts,
    },
    // ── Avalanche Fuji testnet ─────────────────────────────────────────────
    avalancheFujiTestnet: {
      url: process.env.FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc",
      chainId: 43113,
      accounts,
    },
  },
  // Snowtrace is operated by Routescan, not Etherscan. hardhat-verify's built-in
  // "avalanche" entry targets Etherscan's v2 multichain API, which only accepts
  // an etherscan.io key — a Routescan key (rs_...) there fails with the opaque
  // "Cannot read properties of null (reading 'startsWith')".
  //
  // Pointing at Routescan's Etherscan-compatible endpoint instead makes
  // verification work with the key you already have. Routescan does not require
  // a key for verification, so the value is only a placeholder when unset.
  etherscan: {
    apiKey: {
      // Must stay an OBJECT, not a string: hardhat-verify treats a plain string
      // as "this is an etherscan.io key" and then routes to the Etherscan v2
      // endpoint, silently ignoring the customChains apiURL below (see
      // Etherscan.fromChainConfig). The object form is what keeps us on Routescan.
      //
      // The value is a deliberate placeholder, NOT SNOWTRACE_API_KEY. Routescan
      // needs no key to verify, and passing the `rs_...` key from .env makes it
      // answer with `result: null`, which surfaces as the useless
      // "Cannot read properties of null (reading 'startsWith')".
      avalanche: "verifyContract",
      avalancheFujiTestnet: "verifyContract",
    },
    customChains: [
      {
        network: "avalanche",
        chainId: 43114,
        urls: {
          apiURL: "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan",
          browserURL: "https://snowtrace.io",
        },
      },
      {
        network: "avalancheFujiTestnet",
        chainId: 43113,
        urls: {
          apiURL: "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan",
          browserURL: "https://testnet.snowtrace.io",
        },
      },
    ],
  },
};

export default config;
