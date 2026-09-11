import type { Address, PublicClient, WalletClient } from "viem";

/**
 * Deployed protocol addresses for one chain.
 *
 * `preMarketFactory` is optional: it is periphery and may not be deployed on
 * every chain. The launchpad helpers throw a clear error rather than a decode
 * failure when it is missing.
 */
export interface ExnihiloAddresses {
  factory: Address;
  router: Address;
  positionNFT: Address;
  lpNFT: Address;
  usdc: Address;
  preMarketFactory?: Address;
}

export interface ExnihiloConfig {
  /** Required. Every read goes through this. */
  publicClient: PublicClient;
  /** Optional. Required only for the functions that send transactions. */
  walletClient?: WalletClient;
  addresses: ExnihiloAddresses;
}

export class MissingWalletError extends Error {
  constructor(fn: string) {
    super(
      `${fn} sends a transaction and needs a walletClient. ` +
        `Pass one to createExnihilo({ walletClient }).`
    );
    this.name = "MissingWalletError";
  }
}

export class MissingAddressError extends Error {
  constructor(key: keyof ExnihiloAddresses) {
    super(
      `No \`${key}\` address configured for this chain. ` +
        `Add it to createExnihilo({ addresses }).`
    );
    this.name = "MissingAddressError";
  }
}

/**
 * Internal handle passed to every module. Not exported from the package root —
 * consumers hold the object returned by `createExnihilo` instead.
 */
export interface Ctx {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  addresses: ExnihiloAddresses;
}

export function requireWallet(ctx: Ctx, fn: string): WalletClient {
  if (!ctx.walletClient) throw new MissingWalletError(fn);
  return ctx.walletClient;
}

export function requireAddress(ctx: Ctx, key: keyof ExnihiloAddresses): Address {
  const value = ctx.addresses[key];
  if (!value) throw new MissingAddressError(key);
  return value;
}

/**
 * The account transactions are sent from. viem wallet clients may or may not
 * carry one depending on how they were constructed.
 */
export function requireAccount(ctx: Ctx, fn: string): Address {
  const wallet = requireWallet(ctx, fn);
  const account = wallet.account?.address;
  if (!account) {
    throw new MissingWalletError(`${fn} (walletClient has no account attached)`);
  }
  return account;
}
