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
  etherscan: {
    apiKey: {
      avalanche: process.env.SNOWTRACE_API_KEY ?? "",
      avalancheFujiTestnet: process.env.SNOWTRACE_API_KEY ?? "",
    },
  },
};

export default config;
