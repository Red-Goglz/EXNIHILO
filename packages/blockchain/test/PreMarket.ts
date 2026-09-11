import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type {
  EXNIHILOFactory,
  EXNIHILOPool,
  LpNFT,
  MockERC20,
  PositionNFT,
  PreMarket,
  PreMarketFactory,
} from "../typechain-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SWAP_FEE_BPS = 100n; // EXNIHILOPool swap fee — a contract constant (1 %)
const PM_FEE_BPS   = 100n; // PreMarket AMM fee — likewise constant (1 %)
const BPS_DENOM    = 10_000n;

/** PreMarket.MIN_SEED_USDC — minimum USDC value of the seeded quote reserve. */
const MIN_SEED_USDC = 100_000_000n; // $100 — minimum seeded quote value

const SEED_TOKEN = ethers.parseEther("1000000"); // 1,000,000 token (18 dec)
const SEED_QUOTE = ethers.parseEther("500");     // 500 quote    (18 dec)
/** Seed for a USDC-quoted premarket, which launches directly with no auction. */
const SEED_USDC  = ethers.parseUnits("50000", 6); // 50,000 USDC (6 dec)

// Auction: an honest spot quote of ~59.40 marked up 1 %, decaying at 2 %/min.
const START_PRICE   = ethers.parseUnits("60", 6);
const DECAY_BPS_MIN = 200n; // 2 % of startPrice per minute
/** Seconds until the price bottoms out at 1 unit, at the configured rate. */
// Most the auction may discount startPrice before it stops decaying.
const MAX_DISCOUNT_BPS = 1000n; // 10 %
const PRICE_FLOOR      = (START_PRICE * (BPS_DENOM - MAX_DISCOUNT_BPS)) / BPS_DENOM;
// Seconds until the price reaches that floor: 10 % at 2 %/min = 5 minutes.
const PRICE_FLOOR_AT   = (MAX_DISCOUNT_BPS * 60n) / DECAY_BPS_MIN; // 300s
// Retained as a convenient "long past the floor" marker.
const FLOOR_AT = (BPS_DENOM * 60n) / DECAY_BPS_MIN; // 3000s = 50 min


// ─────────────────────────────────────────────────────────────────────────────
// Helpers mirroring the contract math
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors PreMarket.getAmountOut (Uniswap-V2 style, fee off the input). */
function amountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint = PM_FEE_BPS
): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  const inWithFee = amountIn * (BPS_DENOM - feeBps);
  return (inWithFee * reserveOut) / (reserveIn * BPS_DENOM + inWithFee);
}

/** Mirrors PreMarket.currentPrice (linear decay at a bps-per-minute rate). */
function priceAt(
  elapsed: bigint,
  start: bigint = START_PRICE,
  bpsPerMinute: bigint = DECAY_BPS_MIN
): bigint {
  const floor = (start * (BPS_DENOM - MAX_DISCOUNT_BPS)) / BPS_DENOM;
  const elapsedMax = (MAX_DISCOUNT_BPS * 60n) / bpsPerMinute + 1n;
  const e = elapsed > elapsedMax ? elapsedMax : elapsed;
  const drop = (start * bpsPerMinute * e) / (BPS_DENOM * 60n);
  const p = drop >= start ? 0n : start - drop;
  return p < floor ? floor : p;
}

/** Price the auction at `elapsed` seconds using the premarket's own parameters. */
async function priceOfAt(pm: PreMarket, elapsed: bigint): Promise<bigint> {
  return priceAt(elapsed, await pm.startPrice(), await pm.decayBpsPerMinute());
}

/**
 * The price a view call sees right now. View calls execute against the latest
 * block, and the auction decays every second, so expectations have to be
 * derived from the chain clock rather than assumed to be the start price.
 */
async function livePrice(pm: PreMarket): Promise<bigint> {
  return priceOfAt(pm, BigInt(await time.latest()) - (await pm.startTime()));
}

/**
 * Pin the *next* transaction to `startTime + elapsed` and return the auction
 * price that will apply to it. Without this, the price quoted by a view differs
 * from the price the following transaction executes at.
 */
async function pinAt(pm: PreMarket, elapsed: bigint): Promise<bigint> {
  await time.setNextBlockTimestamp((await pm.startTime()) + elapsed);
  return priceOfAt(pm, elapsed);
}

/** USDC a buyout will cost at `elapsed`, with the next block pinned there. */
async function pinBuyoutCost(
  pm: PreMarket,
  elapsed: bigint,
  quoteUnit: bigint = 10n ** 18n
): Promise<{ price: bigint; cost: bigint }> {
  const price = await pinAt(pm, elapsed);
  return { price, cost: ((await pm.quoteReserve()) * price) / quoteUnit };
}

/**
 * Patch an address immutable baked into deployed EVM bytecode.
 *
 * Immutables are stored as 32-byte zero-left-padded values directly in the
 * deployed bytecode, so LpNFT.factory can be repointed at the real factory
 * after the fact. See test/EXNIHILOFactory.ts for the full rationale.
 */
async function patchImmutableAddress(
  contractAddress: string,
  fromAddress: string,
  toAddress: string
): Promise<void> {
  const bytecode = await ethers.provider.getCode(contractAddress);
  const raw = bytecode.slice(2).toLowerCase();
  const fromPadded = "000000000000000000000000" + fromAddress.toLowerCase().slice(2);
  const toPadded = "000000000000000000000000" + toAddress.toLowerCase().slice(2);

  if (!raw.includes(fromPadded)) {
    throw new Error(`patchImmutableAddress: ${fromAddress} not found in ${contractAddress}`);
  }
  await ethers.provider.send("hardhat_setCode", [
    contractAddress,
    "0x" + raw.split(fromPadded).join(toPadded),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Full EXNIHILO protocol plus a PreMarketFactory wired to it. */
async function deployFixture() {
  // [0]=deployer [1]=treasury [2]=launchpad [3]=trader [4]=buyer [5]=lpRecipient
  // [7]=throwaway (LpNFT deployer)  [8]=sysDeployer (EXNIHILOFactory deployer)
  const signers = await ethers.getSigners();
  const [deployer, treasury, launchpad, trader, buyer, lpRecipient, other] = signers;
  const throwaway = signers[7];
  const sysDeployer = signers[8];

  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const token = (await MockERC20F.connect(deployer).deploy("PEPE", "PEPE", 18)) as unknown as MockERC20;
  const quote = (await MockERC20F.connect(deployer).deploy("Wrapped AVAX", "WAVAX", 18)) as unknown as MockERC20;
  const usdc  = (await MockERC20F.connect(deployer).deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;

  const positionNFT = (await (await ethers.getContractFactory("PositionNFT"))
    .connect(deployer)
    .deploy()) as unknown as PositionNFT;

  const lpNft = (await (await ethers.getContractFactory("LpNFT"))
    .connect(throwaway)
    .deploy(throwaway.address)) as unknown as LpNFT;

  const poolDeployer = await (await ethers.getContractFactory("PoolDeployer"))
    .connect(sysDeployer)
    .deploy();

  const marketFactory = (await (await ethers.getContractFactory("EXNIHILOFactory"))
    .connect(sysDeployer)
    .deploy(
      await positionNFT.getAddress(),
      await lpNft.getAddress(),
      await usdc.getAddress(),
      treasury.address,
      await poolDeployer.getAddress()
    )) as unknown as EXNIHILOFactory;

  const marketFactoryAddr = await marketFactory.getAddress();
  await patchImmutableAddress(await lpNft.getAddress(), throwaway.address, marketFactoryAddr);
  await positionNFT.connect(deployer).initFactory(marketFactoryAddr);

  const pmFactory = (await (await ethers.getContractFactory("PreMarketFactory"))
    .connect(deployer)
    .deploy(marketFactoryAddr)) as unknown as PreMarketFactory;

  const pmFactoryAddr = await pmFactory.getAddress();

  // Fund and approve the launchpad (seeds premarkets).
  await token.mint(launchpad.address, SEED_TOKEN * 10n);
  await quote.mint(launchpad.address, SEED_QUOTE * 10n);
  await token.connect(launchpad).approve(pmFactoryAddr, ethers.MaxUint256);
  await quote.connect(launchpad).approve(pmFactoryAddr, ethers.MaxUint256);

  // Fund traders and the buyout bidder.
  await token.mint(trader.address, SEED_TOKEN);
  await quote.mint(trader.address, SEED_QUOTE);
  await usdc.mint(buyer.address, ethers.parseUnits("1000000", 6));

  return {
    deployer, treasury, launchpad, trader, buyer, lpRecipient, other,
    token, quote, usdc, positionNFT, lpNft, marketFactory, pmFactory,
    marketFactoryAddr, pmFactoryAddr,
  };
}

type Overrides = Partial<{
  token: string; tokenAmount: bigint;
  quote: string; quoteAmount: bigint;
  startPrice: bigint; decayBpsPerMinute: bigint;
  lpOwner: string; integrator: string;
}>;

async function buildParams(
  base: Awaited<ReturnType<typeof deployFixture>>,
  o: Overrides = {}
) {
  const now = BigInt(await time.latest());
  return {
    token:            o.token ?? (await base.token.getAddress()),
    tokenAmount:      o.tokenAmount ?? SEED_TOKEN,
    quote:            o.quote ?? (await base.quote.getAddress()),
    quoteAmount:      o.quoteAmount ?? SEED_QUOTE,
    startPrice:        o.startPrice ?? START_PRICE,
    decayBpsPerMinute: o.decayBpsPerMinute ?? DECAY_BPS_MIN,
    lpOwner:          o.lpOwner ?? base.lpRecipient.address,
    integrator:       o.integrator ?? base.other.address,
  };
}

/** Fixture plus one live premarket seeded by the launchpad. */
async function withPreMarketFixture() {
  const base = await deployFixture();
  const params = await buildParams(base);
  const tx = await base.pmFactory.connect(base.launchpad).createPreMarket(params);
  await tx.wait();

  const pmAddr = await base.pmFactory.allPreMarkets(0);
  const preMarket = (await ethers.getContractAt("PreMarket", pmAddr)) as unknown as PreMarket;

  // Traders and the buyer approve the premarket.
  await base.token.connect(base.trader).approve(pmAddr, ethers.MaxUint256);
  await base.quote.connect(base.trader).approve(pmAddr, ethers.MaxUint256);
  await base.usdc.connect(base.buyer).approve(pmAddr, ethers.MaxUint256);

  return { ...base, preMarket, pmAddr, startTime: await preMarket.startTime() };
}

/**
 * Fixture plus one premarket seeded with USDC as the quote asset. There is no
 * auction on that path, so this comes back already launched — `createPreMarket`
 * opened the real market before it returned.
 */
async function withUsdcPreMarketFixture() {
  const base = await deployFixture();

  await base.usdc.mint(base.launchpad.address, SEED_USDC * 10n);
  await base.usdc.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);

  const params = await buildParams(base, {
    quote: await base.usdc.getAddress(),
    quoteAmount: SEED_USDC,
  });
  await base.pmFactory.connect(base.launchpad).createPreMarket(params);

  const pmAddr = await base.pmFactory.allPreMarkets(0);
  const preMarket = (await ethers.getContractAt("PreMarket", pmAddr)) as unknown as PreMarket;

  return { ...base, preMarket, pmAddr };
}

// ═════════════════════════════════════════════════════════════════════════════

describe("PreMarketFactory", () => {
  describe("Deployment", () => {
    it("stores the market factory and reads USDC from it", async () => {
      const { pmFactory, marketFactoryAddr, usdc } = await loadFixture(deployFixture);
      expect(await pmFactory.marketFactory()).to.equal(marketFactoryAddr);
      expect(await pmFactory.usdc()).to.equal(await usdc.getAddress());
    });

    it("reverts when the market factory is the zero address", async () => {
      const F = await ethers.getContractFactory("PreMarketFactory");
      await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("starts with an empty registry", async () => {
      const { pmFactory } = await loadFixture(deployFixture);
      expect(await pmFactory.allPreMarketsLength()).to.equal(0n);
    });
  });

  describe("createPreMarket", () => {
    it("deploys, seeds, and registers a premarket", async () => {
      const base = await loadFixture(deployFixture);
      const params = await buildParams(base);

      await expect(base.pmFactory.connect(base.launchpad).createPreMarket(params))
        .to.emit(base.pmFactory, "PreMarketCreated");

      expect(await base.pmFactory.allPreMarketsLength()).to.equal(1n);

      const pmAddr = await base.pmFactory.allPreMarkets(0);
      expect(await base.pmFactory.isPreMarket(pmAddr)).to.equal(true);

      // Reserves recorded in the constructor match the real balances.
      const pm = (await ethers.getContractAt("PreMarket", pmAddr)) as unknown as PreMarket;
      expect(await pm.tokenReserve()).to.equal(SEED_TOKEN);
      expect(await pm.quoteReserve()).to.equal(SEED_QUOTE);
      expect(await base.token.balanceOf(pmAddr)).to.equal(SEED_TOKEN);
      expect(await base.quote.balanceOf(pmAddr)).to.equal(SEED_QUOTE);
    });

    it("records the caller as creator and forwards every parameter", async () => {
      const base = await loadFixture(deployFixture);
      const params = await buildParams(base);
      await base.pmFactory.connect(base.launchpad).createPreMarket(params);

      const pm = (await ethers.getContractAt(
        "PreMarket",
        await base.pmFactory.allPreMarkets(0)
      )) as unknown as PreMarket;

      expect(await pm.creator()).to.equal(base.launchpad.address);
      expect(await pm.lpOwner()).to.equal(base.lpRecipient.address);
      expect(await pm.startPrice()).to.equal(START_PRICE);
      expect(await pm.decayBpsPerMinute()).to.equal(DECAY_BPS_MIN);
      expect(await pm.swapFeeBps()).to.equal(PM_FEE_BPS);
      expect(await pm.quoteUnit()).to.equal(10n ** 18n);
      expect(await pm.launched()).to.equal(false);
    });

    it("supports several premarkets from the same factory", async () => {
      const base = await loadFixture(deployFixture);
      await base.pmFactory.connect(base.launchpad).createPreMarket(await buildParams(base));
      await base.pmFactory.connect(base.launchpad).createPreMarket(await buildParams(base));
      expect(await base.pmFactory.allPreMarketsLength()).to.equal(2n);
      expect(await base.pmFactory.allPreMarkets(0)).to.not.equal(
        await base.pmFactory.allPreMarkets(1)
      );
    });

    it("reverts when the token is the zero address", async () => {
      const base = await loadFixture(deployFixture);
      const params = await buildParams(base, { token: ethers.ZeroAddress });
      await expect(
        base.pmFactory.connect(base.launchpad).createPreMarket(params)
      ).to.be.revertedWithCustomError(base.pmFactory, "ZeroAddress");
    });

    it("reverts when the quote is the zero address", async () => {
      const base = await loadFixture(deployFixture);
      const params = await buildParams(base, { quote: ethers.ZeroAddress });
      await expect(
        base.pmFactory.connect(base.launchpad).createPreMarket(params)
      ).to.be.revertedWithCustomError(base.pmFactory, "ZeroAddress");
    });

    it("reverts on a zero token amount", async () => {
      const base = await loadFixture(deployFixture);
      const params = await buildParams(base, { tokenAmount: 0n });
      await expect(
        base.pmFactory.connect(base.launchpad).createPreMarket(params)
      ).to.be.revertedWithCustomError(base.pmFactory, "ZeroAmount");
    });

    it("reverts on a zero quote amount", async () => {
      const base = await loadFixture(deployFixture);
      const params = await buildParams(base, { quoteAmount: 0n });
      await expect(
        base.pmFactory.connect(base.launchpad).createPreMarket(params)
      ).to.be.revertedWithCustomError(base.pmFactory, "ZeroAmount");
    });

    // EXNIHILOFactory.createMarket rejects both of these, but only at buyout —
    // by which point the seed is in custody and no path returns it. Seeding used
    // to sail through and brick the buyout forever.
    it("reverts when the token is USDC", async () => {
      const base = await loadFixture(deployFixture);
      const params = await buildParams(base, { token: await base.usdc.getAddress() });
      await expect(
        base.pmFactory.connect(base.launchpad).createPreMarket(params)
      ).to.be.revertedWithCustomError(base.pmFactory, "TokenIsUsdc");
    });

    it("reverts when the token and the quote are the same asset", async () => {
      const base = await loadFixture(deployFixture);
      const params = await buildParams(base, { quote: await base.token.getAddress() });
      await expect(
        base.pmFactory.connect(base.launchpad).createPreMarket(params)
      ).to.be.revertedWithCustomError(base.pmFactory, "TokenIsQuote");
    });

    it("refuses a quote asset whose decimals() cannot be read", async () => {
      // This used to assume 18 (audit IA-R2-5). Unlike EXNIHILOFactory's
      // fallback, the value is not cosmetic here: quoteUnit divides the buyout
      // price and the seed-value check, so assuming 18 for a 6-decimal quote is
      // a 1e12 error in what the bonded reserve is believed to be worth. A
      // quote this contract cannot price is refused instead of guessed at.
      const base = await loadFixture(deployFixture);
      const noMeta = await (await ethers.getContractFactory("NoMetaERC20"))
        .connect(base.deployer)
        .deploy();
      const noMetaAddr = await noMeta.getAddress();

      await noMeta.mint(base.launchpad.address, SEED_QUOTE);
      await noMeta.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);

      const params = await buildParams(base, { quote: noMetaAddr });
      await expect(
        base.pmFactory.connect(base.launchpad).createPreMarket(params)
      ).to.be.revertedWithCustomError(base.pmFactory, "QuoteDecimalsUnavailable");

      // Refused outright: nothing was deployed and nothing was pulled.
      expect(await base.pmFactory.allPreMarketsLength()).to.equal(0n);
      expect(await noMeta.balanceOf(base.launchpad.address)).to.equal(SEED_QUOTE);
    });

    it("reads non-18 decimals from the quote asset", async () => {
      const base = await loadFixture(deployFixture);
      const sixDec = (await (await ethers.getContractFactory("MockERC20"))
        .connect(base.deployer)
        .deploy("Six", "SIX", 6)) as unknown as MockERC20;

      await sixDec.mint(base.launchpad.address, ethers.parseUnits("500", 6));
      await sixDec.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);

      const params = await buildParams(base, {
        quote: await sixDec.getAddress(),
        quoteAmount: ethers.parseUnits("500", 6),
      });
      await base.pmFactory.connect(base.launchpad).createPreMarket(params);

      const pm = (await ethers.getContractAt(
        "PreMarket",
        await base.pmFactory.allPreMarkets(0)
      )) as unknown as PreMarket;
      expect(await pm.quoteUnit()).to.equal(10n ** 6n);
    });

    it("rejects a fee-on-transfer project token", async () => {
      const base = await loadFixture(deployFixture);
      const fot = await (await ethers.getContractFactory("FeeOnTransferToken"))
        .connect(base.deployer)
        .deploy("Fee", "FEE", 18);

      await fot.mint(base.launchpad.address, SEED_TOKEN);
      await fot.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);
      await fot.enableFee();

      const params = await buildParams(base, { token: await fot.getAddress() });
      await expect(
        base.pmFactory.connect(base.launchpad).createPreMarket(params)
      ).to.be.revertedWithCustomError(base.pmFactory, "FeeOnTransferNotSupported");
    });

    it("rejects a fee-on-transfer quote asset", async () => {
      const base = await loadFixture(deployFixture);
      const fot = await (await ethers.getContractFactory("FeeOnTransferToken"))
        .connect(base.deployer)
        .deploy("Fee", "FEE", 18);

      await fot.mint(base.launchpad.address, SEED_QUOTE);
      await fot.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);
      await fot.enableFee();

      const params = await buildParams(base, { quote: await fot.getAddress() });
      await expect(
        base.pmFactory.connect(base.launchpad).createPreMarket(params)
      ).to.be.revertedWithCustomError(base.pmFactory, "FeeOnTransferNotSupported");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe("PreMarket", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // Constructor validation — exercised by deploying PreMarket directly, since
  // the factory catches some of these earlier.
  // ───────────────────────────────────────────────────────────────────────────

  describe("Constructor validation", () => {
    async function baseConfig(base: Awaited<ReturnType<typeof deployFixture>>) {
      const now = BigInt(await time.latest());
      return {
        token:            await base.token.getAddress(),
        quote:            await base.quote.getAddress(),
        usdc:             await base.usdc.getAddress(),
        factory:          base.marketFactoryAddr,
        creator:          base.launchpad.address,
        lpOwner:          base.lpRecipient.address,
        integrator:       base.other.address,
        quoteDecimals:     18,
        startPrice:        START_PRICE,
        decayBpsPerMinute: DECAY_BPS_MIN,
      };
    }

    async function deployDirect(
      base: Awaited<ReturnType<typeof deployFixture>>,
      patch: Record<string, unknown> = {},
      tokenAmount: bigint = SEED_TOKEN,
      quoteAmount: bigint = SEED_QUOTE
    ) {
      const F = await ethers.getContractFactory("PreMarket");
      const cfg = { ...(await baseConfig(base)), ...patch };
      return { F, promise: F.deploy(cfg, tokenAmount, quoteAmount) };
    }

    it("deploys with valid configuration", async () => {
      const base = await loadFixture(deployFixture);
      const { promise } = await deployDirect(base);
      await expect(promise).to.not.be.reverted;
    });

    it("reverts on a zero token address", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, { token: ethers.ZeroAddress });
      await expect(promise).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on a zero quote address", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, { quote: ethers.ZeroAddress });
      await expect(promise).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on a zero usdc address", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, { usdc: ethers.ZeroAddress });
      await expect(promise).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on a zero factory address", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, { factory: ethers.ZeroAddress });
      await expect(promise).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on a zero creator address", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, { creator: ethers.ZeroAddress });
      await expect(promise).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on a zero lpOwner address", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, { lpOwner: ethers.ZeroAddress });
      await expect(promise).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on a zero token amount", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, {}, 0n, SEED_QUOTE);
      await expect(promise).to.be.revertedWithCustomError(F, "ZeroAmount");
    });

    it("reverts on a zero quote amount", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, {}, SEED_TOKEN, 0n);
      await expect(promise).to.be.revertedWithCustomError(F, "ZeroAmount");
    });

    it("reverts when usdc does not match the market factory's usdc", async () => {
      const base = await loadFixture(deployFixture);
      const wrong = (await (await ethers.getContractFactory("MockERC20"))
        .connect(base.deployer)
        .deploy("Wrong", "WRG", 6)) as unknown as MockERC20;
      const { F, promise } = await deployDirect(base, { usdc: await wrong.getAddress() });
      await expect(promise).to.be.revertedWithCustomError(F, "UsdcMismatch");
    });

    // Mirrored from EXNIHILOFactory.createMarket. The constructor is the last
    // place either can be caught: after it, the only exit is a buyout that would
    // revert inside createMarket on every call, forever.
    it("reverts when the token is USDC", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, { token: await base.usdc.getAddress() });
      await expect(promise).to.be.revertedWithCustomError(F, "TokenIsUsdc");
    });

    it("reverts when the token and the quote are the same asset", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, { quote: await base.token.getAddress() });
      await expect(promise).to.be.revertedWithCustomError(F, "TokenIsQuote");
    });

    it("reverts on a zero start price", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, { startPrice: 0n });
      await expect(promise).to.be.revertedWithCustomError(F, "InvalidPriceRange");
    });

    it("reverts on a zero decay rate", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, { decayBpsPerMinute: 0n });
      await expect(promise).to.be.revertedWithCustomError(F, "InvalidDecayRate");
    });

    it("reverts on a decay rate above 100 %/minute", async () => {
      const base = await loadFixture(deployFixture);
      const { F, promise } = await deployDirect(base, { decayBpsPerMinute: 10_001n });
      await expect(promise).to.be.revertedWithCustomError(F, "InvalidDecayRate");
    });

    it("accepts a decay rate of exactly 100 %/minute", async () => {
      const base = await loadFixture(deployFixture);
      const { promise } = await deployDirect(base, { decayBpsPerMinute: 10_000n });
      await expect(promise).to.not.be.reverted;
    });

    /**
     * The fee was a caller-supplied Config field bounded only above, so on a
     * permissionless factory anyone could seed a premarket at 0 % and trade its
     * curve for free — removing the friction that makes a manipulate → extract
     * round trip lossy. It is now a constant matching EXNIHILOPool's own fee.
     */
    it("fixes the swap fee at 1 %, with nothing in Config that can move it", async () => {
      const base = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("PreMarket");
      const pm = await F.deploy(await baseConfig(base), SEED_TOKEN, SEED_QUOTE);

      expect(await pm.swapFeeBps()).to.equal(100n);

      const configFields = (F.interface.deploy.inputs[0] as any).components
        .map((c: { name: string }) => c.name);
      expect(configFields).to.not.include("swapFeeBps");
    });

    it("emits Seeded with the initial reserves", async () => {
      const base = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("PreMarket");
      const pm = await F.deploy(await baseConfig(base), SEED_TOKEN, SEED_QUOTE);
      await expect(pm.deploymentTransaction())
        .to.emit(pm, "Seeded")
        .withArgs(SEED_TOKEN, SEED_QUOTE, START_PRICE);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Auction pricing
  // ───────────────────────────────────────────────────────────────────────────

  describe("currentPrice", () => {
    it("starts at the start price", async () => {
      // Read in the same block the premarket was created in, before the auction
      // has had a chance to tick.
      const base = await loadFixture(deployFixture);
      await base.pmFactory.connect(base.launchpad).createPreMarket(await buildParams(base));
      const pm = (await ethers.getContractAt(
        "PreMarket",
        await base.pmFactory.allPreMarkets(0)
      )) as unknown as PreMarket;

      expect(await pm.currentPrice()).to.equal(START_PRICE);
    });

    it("decays linearly through the auction", async () => {
      const { preMarket, startTime } = await loadFixture(withPreMarketFixture);

      for (const elapsed of [30n, 60n, 300n, 1500n]) {
        await time.increaseTo(startTime + elapsed);
        expect(await preMarket.currentPrice()).to.equal(priceAt(elapsed));
      }
    });

    it("drops exactly 2 % of the start price each minute", async () => {
      const { preMarket, startTime } = await loadFixture(withPreMarketFixture);
      const perMinute = (START_PRICE * DECAY_BPS_MIN) / BPS_DENOM;

      // Minute 5 is exactly the 10 % floor; beyond it the price holds.
      for (const minute of [1n, 2n, 4n]) {
        await time.increaseTo(startTime + minute * 60n);
        expect(await preMarket.currentPrice()).to.equal(START_PRICE - perMinute * minute);
      }
      await time.increaseTo(startTime + 10n * 60n);
      expect(await preMarket.currentPrice()).to.equal(PRICE_FLOOR);
    });

    it("crosses breakeven about 30s in and 1 % below within a minute", async () => {
      // startPrice is a spot quote marked up 1 %, so spot = startPrice / 1.01.
      const { preMarket, startTime } = await loadFixture(withPreMarketFixture);
      const spot = (START_PRICE * 10_000n) / 10_100n;

      await time.increaseTo(startTime + 29n);
      expect(await preMarket.currentPrice()).to.be.greaterThan(spot);

      await time.increaseTo(startTime + 31n);
      expect(await preMarket.currentPrice()).to.be.lessThan(spot);

      await time.increaseTo(startTime + 60n);
      expect(await preMarket.currentPrice()).to.be.lessThan((spot * 99n) / 100n);
    });

    it("moves every second, not in jumps", async () => {
      const { preMarket, startTime } = await loadFixture(withPreMarketFixture);
      // Start beyond the seeding block; the fixture's approvals already ticked.
      await time.increaseTo(startTime + 100n);
      let previous = await preMarket.currentPrice();

      for (let i = 101n; i <= 105n; i++) {
        await time.increaseTo(startTime + i);
        const now = await preMarket.currentPrice();
        expect(now).to.be.lessThan(previous);
        previous = now;
      }
    });

    it("bottoms out 10 % below the start price and holds there", async () => {
      // It used to decay to 1 unit, effectively giving the reserve away, which
      // is what made C-2 pay. The floor is now a reserve price.
      const { preMarket, startTime } = await loadFixture(withPreMarketFixture);

      await time.increaseTo(startTime + PRICE_FLOOR_AT - 1n);
      expect(await preMarket.currentPrice()).to.be.greaterThan(PRICE_FLOOR);

      await time.increaseTo(startTime + PRICE_FLOOR_AT);
      expect(await preMarket.currentPrice()).to.equal(PRICE_FLOOR);

      // Holds however long it sits, and never overflows getting there.
      for (const mult of [10n, 1000n, 100000n]) {
        await time.increaseTo(startTime + PRICE_FLOOR_AT * mult);
        expect(await preMarket.currentPrice()).to.equal(PRICE_FLOOR);
      }
    });

    it("decays faster at a higher rate", async () => {
      const base = await loadFixture(deployFixture);
      const params = await buildParams(base, { decayBpsPerMinute: 1000n }); // 10 %/min
      await base.pmFactory.connect(base.launchpad).createPreMarket(params);
      const pm = (await ethers.getContractAt(
        "PreMarket",
        await base.pmFactory.allPreMarkets(0)
      )) as unknown as PreMarket;

      await time.increaseTo((await pm.startTime()) + 60n);
      expect(await pm.currentPrice()).to.equal((START_PRICE * 9000n) / BPS_DENOM);
    });
  });

  describe("buyoutCost", () => {
    it("prices the whole quote reserve at the current price", async () => {
      const { preMarket } = await loadFixture(withPreMarketFixture);
      const [usdcCost, quoteOut] = await preMarket.buyoutCost();

      expect(quoteOut).to.equal(SEED_QUOTE);
      expect(usdcCost).to.equal((SEED_QUOTE * (await livePrice(preMarket))) / 10n ** 18n);
    });

    it("falls as the auction decays", async () => {
      const { preMarket, startTime } = await loadFixture(withPreMarketFixture);
      const [before] = await preMarket.buyoutCost();

      await time.increaseTo(startTime + 300n);
      const [after] = await preMarket.buyoutCost();

      expect(after).to.be.lessThan(before);
    });

    it("tracks the quote reserve after a swap", async () => {
      const { preMarket, trader } = await loadFixture(withPreMarketFixture);
      await preMarket
        .connect(trader)
        .swap(ethers.parseEther("10"), 0n, false, trader.address); // quote in

      const [, quoteOut] = await preMarket.buyoutCost();
      expect(quoteOut).to.equal(await preMarket.quoteReserve());
      expect(quoteOut).to.be.greaterThan(SEED_QUOTE);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AMM
  // ───────────────────────────────────────────────────────────────────────────

  describe("getAmountOut", () => {
    it("returns zero for a zero input", async () => {
      const { preMarket } = await loadFixture(withPreMarketFixture);
      expect(await preMarket.getAmountOut(0n, SEED_TOKEN, SEED_QUOTE)).to.equal(0n);
    });

    it("returns zero for a zero input reserve", async () => {
      const { preMarket } = await loadFixture(withPreMarketFixture);
      expect(await preMarket.getAmountOut(1000n, 0n, SEED_QUOTE)).to.equal(0n);
    });

    it("returns zero for a zero output reserve", async () => {
      const { preMarket } = await loadFixture(withPreMarketFixture);
      expect(await preMarket.getAmountOut(1000n, SEED_TOKEN, 0n)).to.equal(0n);
    });

    it("matches the constant-product formula with the fee off the input", async () => {
      const { preMarket } = await loadFixture(withPreMarketFixture);
      const amountIn = ethers.parseEther("1000");
      expect(await preMarket.getAmountOut(amountIn, SEED_TOKEN, SEED_QUOTE)).to.equal(
        amountOut(amountIn, SEED_TOKEN, SEED_QUOTE)
      );
    });

    it("charges the fixed fee, and it is strictly more than nothing", async () => {
      const base = await loadFixture(deployFixture);
      const params = await buildParams(base);
      await base.pmFactory.connect(base.launchpad).createPreMarket(params);
      const pm = (await ethers.getContractAt(
        "PreMarket",
        await base.pmFactory.allPreMarkets(0)
      )) as unknown as PreMarket;

      const amountIn = ethers.parseEther("1000");
      const quoted = await pm.getAmountOut(amountIn, SEED_TOKEN, SEED_QUOTE);
      expect(quoted).to.equal(amountOut(amountIn, SEED_TOKEN, SEED_QUOTE, PM_FEE_BPS));
      // No premarket can be seeded fee-free, so this gap can never close.
      expect(quoted).to.be.lessThan(amountOut(amountIn, SEED_TOKEN, SEED_QUOTE, 0n));
    });
  });

  describe("swap", () => {
    it("swaps token for quote and updates reserves", async () => {
      const { preMarket, trader, quote } = await loadFixture(withPreMarketFixture);
      const amountIn = ethers.parseEther("1000");
      const expected = amountOut(amountIn, SEED_TOKEN, SEED_QUOTE);

      const before = await quote.balanceOf(trader.address);
      await preMarket.connect(trader).swap(amountIn, 0n, true, trader.address);

      expect(await quote.balanceOf(trader.address)).to.equal(before + expected);
      expect(await preMarket.tokenReserve()).to.equal(SEED_TOKEN + amountIn);
      expect(await preMarket.quoteReserve()).to.equal(SEED_QUOTE - expected);
    });

    it("swaps quote for token and updates reserves", async () => {
      const { preMarket, trader, token } = await loadFixture(withPreMarketFixture);
      const amountIn = ethers.parseEther("10");
      const expected = amountOut(amountIn, SEED_QUOTE, SEED_TOKEN);

      const before = await token.balanceOf(trader.address);
      await preMarket.connect(trader).swap(amountIn, 0n, false, trader.address);

      expect(await token.balanceOf(trader.address)).to.equal(before + expected);
      expect(await preMarket.quoteReserve()).to.equal(SEED_QUOTE + amountIn);
      expect(await preMarket.tokenReserve()).to.equal(SEED_TOKEN - expected);
    });

    it("keeps reserves equal to real balances", async () => {
      const { preMarket, pmAddr, trader, token, quote } = await loadFixture(withPreMarketFixture);
      await preMarket.connect(trader).swap(ethers.parseEther("500"), 0n, true, trader.address);
      await preMarket.connect(trader).swap(ethers.parseEther("5"), 0n, false, trader.address);

      expect(await preMarket.tokenReserve()).to.equal(await token.balanceOf(pmAddr));
      expect(await preMarket.quoteReserve()).to.equal(await quote.balanceOf(pmAddr));
    });

    it("grows the product k by the fee", async () => {
      const { preMarket, trader } = await loadFixture(withPreMarketFixture);
      const kBefore = SEED_TOKEN * SEED_QUOTE;

      await preMarket.connect(trader).swap(ethers.parseEther("1000"), 0n, true, trader.address);

      const kAfter = (await preMarket.tokenReserve()) * (await preMarket.quoteReserve());
      expect(kAfter).to.be.greaterThan(kBefore);
    });

    it("sends output to an arbitrary recipient", async () => {
      const { preMarket, trader, other, quote } = await loadFixture(withPreMarketFixture);
      const amountIn = ethers.parseEther("1000");
      const expected = amountOut(amountIn, SEED_TOKEN, SEED_QUOTE);

      await preMarket.connect(trader).swap(amountIn, 0n, true, other.address);
      expect(await quote.balanceOf(other.address)).to.equal(expected);
    });

    it("emits Swapped with the post-trade reserves", async () => {
      const { preMarket, trader } = await loadFixture(withPreMarketFixture);
      const amountIn = ethers.parseEther("1000");
      const expected = amountOut(amountIn, SEED_TOKEN, SEED_QUOTE);

      await expect(preMarket.connect(trader).swap(amountIn, 0n, true, trader.address))
        .to.emit(preMarket, "Swapped")
        .withArgs(
          trader.address, trader.address, true, amountIn, expected,
          SEED_TOKEN + amountIn, SEED_QUOTE - expected
        );
    });

    it("reverts on a zero input amount", async () => {
      const { preMarket, trader } = await loadFixture(withPreMarketFixture);
      await expect(
        preMarket.connect(trader).swap(0n, 0n, true, trader.address)
      ).to.be.revertedWithCustomError(preMarket, "ZeroAmount");
    });

    it("reverts on a zero recipient", async () => {
      const { preMarket, trader } = await loadFixture(withPreMarketFixture);
      await expect(
        preMarket.connect(trader).swap(ethers.parseEther("1"), 0n, true, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(preMarket, "ZeroAddress");
    });

    it("reverts when the output would round to zero", async () => {
      const { preMarket, trader } = await loadFixture(withPreMarketFixture);
      // 1 wei of an 18-dec token against a 2000:1 reserve ratio rounds to nothing.
      await expect(
        preMarket.connect(trader).swap(1n, 0n, true, trader.address)
      ).to.be.revertedWithCustomError(preMarket, "ZeroOutput");
    });

    it("reverts when the output is below minAmountOut", async () => {
      const { preMarket, trader } = await loadFixture(withPreMarketFixture);
      const amountIn = ethers.parseEther("1000");
      const expected = amountOut(amountIn, SEED_TOKEN, SEED_QUOTE);

      await expect(
        preMarket.connect(trader).swap(amountIn, expected + 1n, true, trader.address)
      ).to.be.revertedWithCustomError(preMarket, "SlippageExceeded");
    });

    it("accepts a minAmountOut exactly equal to the output", async () => {
      const { preMarket, trader } = await loadFixture(withPreMarketFixture);
      const amountIn = ethers.parseEther("1000");
      const expected = amountOut(amountIn, SEED_TOKEN, SEED_QUOTE);

      await expect(preMarket.connect(trader).swap(amountIn, expected, true, trader.address)).to
        .not.be.reverted;
    });

    it("keeps trading long after the price has bottomed out", async () => {
      // There is no deadline: an unsold premarket carries on as a spot AMM.
      const { preMarket, trader, startTime } = await loadFixture(withPreMarketFixture);
      await time.increaseTo(startTime + FLOOR_AT * 10n);

      await expect(
        preMarket.connect(trader).swap(ethers.parseEther("1000"), 0n, true, trader.address)
      ).to.not.be.reverted;
    });

    it("reverts once the market has launched", async () => {
      const { preMarket, trader, buyer } = await loadFixture(withPreMarketFixture);
      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      await expect(
        preMarket.connect(trader).swap(ethers.parseEther("1"), 0n, true, trader.address)
      ).to.be.revertedWithCustomError(preMarket, "AlreadyLaunched");
    });

    it("rejects a fee-on-transfer input asset", async () => {
      const base = await loadFixture(deployFixture);
      const fot = await (await ethers.getContractFactory("FeeOnTransferToken"))
        .connect(base.deployer)
        .deploy("Fee", "FEE", 18);

      // Seed while the fee is off so the premarket can be created at all.
      await fot.mint(base.launchpad.address, SEED_QUOTE * 2n);
      await fot.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);

      const params = await buildParams(base, { quote: await fot.getAddress() });
      await base.pmFactory.connect(base.launchpad).createPreMarket(params);

      const pm = (await ethers.getContractAt(
        "PreMarket",
        await base.pmFactory.allPreMarkets(0)
      )) as unknown as PreMarket;

      await fot.mint(base.trader.address, SEED_QUOTE);
      await fot.connect(base.trader).approve(await pm.getAddress(), ethers.MaxUint256);
      await fot.enableFee();

      await expect(
        pm.connect(base.trader).swap(ethers.parseEther("10"), 0n, false, base.trader.address)
      ).to.be.revertedWithCustomError(pm, "FeeOnTransferNotSupported");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Buyout / launch
  // ───────────────────────────────────────────────────────────────────────────

  describe("buyout", () => {
    it("creates the real market with the premarket's reserves", async () => {
      const { preMarket, buyer, marketFactory, token, usdc } =
        await loadFixture(withPreMarketFixture);

      const { cost } = await pinBuyoutCost(preMarket, 60n);
      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      const poolAddr = await preMarket.launchedPool();
      expect(poolAddr).to.not.equal(ethers.ZeroAddress);
      expect(await marketFactory.isPool(poolAddr)).to.equal(true);

      const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddr)) as unknown as EXNIHILOPool;
      expect(await pool.backedAirToken()).to.equal(SEED_TOKEN);
      expect(await pool.backedAirUsd()).to.equal(cost);

      // The pool actually holds the assets.
      expect(await token.balanceOf(poolAddr)).to.equal(SEED_TOKEN);
      expect(await usdc.balanceOf(poolAddr)).to.equal(cost);
    });

    it("pays the buyer the entire quote reserve", async () => {
      const { preMarket, buyer, quote, usdc } = await loadFixture(withPreMarketFixture);
      const { cost } = await pinBuyoutCost(preMarket, 60n);

      const quoteBefore = await quote.balanceOf(buyer.address);
      const usdcBefore  = await usdc.balanceOf(buyer.address);

      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      expect(await quote.balanceOf(buyer.address)).to.equal(quoteBefore + SEED_QUOTE);
      expect(await usdc.balanceOf(buyer.address)).to.equal(usdcBefore - cost);
    });

    it("deploys a LockedLpVault and hands it the LP NFT", async () => {
      const { preMarket, buyer, lpNft, pmAddr } = await loadFixture(withPreMarketFixture);

      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      const vaultAddr = await preMarket.lpVault();
      expect(vaultAddr).to.not.equal(ethers.ZeroAddress);
      expect(await lpNft.ownerOf(0n)).to.equal(vaultAddr);
      expect(await lpNft.balanceOf(pmAddr)).to.equal(0n);
      expect(await lpNft.poolOf(0n)).to.equal(await preMarket.launchedPool());
    });

    it("wires the vault to the lpOwner and integrator with a 50/50 split", async () => {
      const { preMarket, buyer, lpRecipient, other } = await loadFixture(withPreMarketFixture);

      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      const vault = await ethers.getContractAt("LockedLpVault", await preMarket.lpVault());
      expect(await vault.lp()).to.equal(lpRecipient.address);
      expect(await vault.integrator()).to.equal(other.address);
      // Half of the pool's 4 % LP stream — 2 % of notional each.
      expect(await vault.integratorBps()).to.equal(5000n);
      expect(await vault.pool()).to.equal(await preMarket.launchedPool());
      expect(await vault.isFunded()).to.equal(true);
    });

    it("gives the lpOwner the whole stream when there is no integrator", async () => {
      const base = await loadFixture(deployFixture);
      const params = await buildParams(base, { integrator: ethers.ZeroAddress });
      await base.pmFactory.connect(base.launchpad).createPreMarket(params);

      const pm = (await ethers.getContractAt(
        "PreMarket",
        await base.pmFactory.allPreMarkets(0)
      )) as unknown as PreMarket;
      await base.usdc.connect(base.buyer).approve(await pm.getAddress(), ethers.MaxUint256);

      await pm.connect(base.buyer).buyout(ethers.MaxUint256, 0n);

      const vault = await ethers.getContractAt("LockedLpVault", await pm.lpVault());
      expect(await vault.integrator()).to.equal(ethers.ZeroAddress);
      expect(await vault.integratorBps()).to.equal(0n);
    });

    it("locks the liquidity immediately — nobody can withdraw it", async () => {
      const { preMarket, buyer, launchpad, lpRecipient, other } =
        await loadFixture(withPreMarketFixture);

      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      const pool = (await ethers.getContractAt(
        "EXNIHILOPool",
        await preMarket.launchedPool()
      )) as unknown as EXNIHILOPool;

      for (const who of [launchpad, lpRecipient, other, buyer]) {
        await expect(
          pool.connect(who).removeLiquidity()
        ).to.be.revertedWithCustomError(pool, "OnlyLpHolder");
      }
    });

    it("marks the premarket launched and zeroes its reserves", async () => {
      const { preMarket, buyer, pmAddr, token, quote } = await loadFixture(withPreMarketFixture);
      const { cost } = await pinBuyoutCost(preMarket, 60n);

      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      expect(await preMarket.launched()).to.equal(true);
      expect(await preMarket.tokenReserve()).to.equal(0n);
      expect(await preMarket.quoteReserve()).to.equal(0n);
      expect(await preMarket.launchUsdc()).to.equal(cost);

      // Nothing is left stranded in the premarket.
      expect(await token.balanceOf(pmAddr)).to.equal(0n);
      expect(await quote.balanceOf(pmAddr)).to.equal(0n);
    });

    it("emits BoughtOut and Launched", async () => {
      const { preMarket, buyer } = await loadFixture(withPreMarketFixture);
      const { price, cost } = await pinBuyoutCost(preMarket, 60n);

      const tx = preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);
      await expect(tx)
        .to.emit(preMarket, "BoughtOut")
        .withArgs(buyer.address, cost, SEED_QUOTE, price);
      await expect(tx)
        .to.emit(preMarket, "Launched")
        .withArgs(
          await preMarket.launchedPool(),
          await preMarket.lpVault(),
          0n,
          SEED_TOKEN,
          cost
        );
    });

    it("forwards the market parameters to the pool", async () => {
      const { preMarket, buyer } = await loadFixture(withPreMarketFixture);
      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      const pool = (await ethers.getContractAt(
        "EXNIHILOPool",
        await preMarket.launchedPool()
      )) as unknown as EXNIHILOPool;

      expect(await pool.currentMaxPositionBps()).to.equal(100n);
    });

    it("costs less the later it is filled", async () => {
      const { preMarket, buyer } = await loadFixture(withPreMarketFixture);

      const { cost } = await pinBuyoutCost(preMarket, 240n); // 4 min, 8 % off
      expect(cost).to.equal((SEED_QUOTE * ((START_PRICE * 9200n) / BPS_DENOM)) / 10n ** 18n);

      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);
      const pool = (await ethers.getContractAt(
        "EXNIHILOPool",
        await preMarket.launchedPool()
      )) as unknown as EXNIHILOPool;
      expect(await pool.backedAirUsd()).to.equal(cost);
    });

    it("opens the market at the premarket ratio times the auction price", async () => {
      const { preMarket, buyer, trader } = await loadFixture(withPreMarketFixture);

      // Move the premarket price with a real trade first.
      await preMarket.connect(trader).swap(ethers.parseEther("50000"), 0n, true, trader.address);

      const tokenReserve = await preMarket.tokenReserve();
      const quoteReserve = await preMarket.quoteReserve();
      const price = await pinAt(preMarket, 120n);

      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      const pool = (await ethers.getContractAt(
        "EXNIHILOPool",
        await preMarket.launchedPool()
      )) as unknown as EXNIHILOPool;

      // usdc / token == price * (quote / token), within integer rounding.
      expect(await pool.backedAirToken()).to.equal(tokenReserve);
      expect(await pool.backedAirUsd()).to.equal((quoteReserve * price) / 10n ** 18n);
    });

    it("uses the reserves as they stand after trading", async () => {
      const { preMarket, buyer, trader } = await loadFixture(withPreMarketFixture);
      await preMarket.connect(trader).swap(ethers.parseEther("20"), 0n, false, trader.address);

      const tokenReserve = await preMarket.tokenReserve();
      const quoteReserve = await preMarket.quoteReserve();
      expect(quoteReserve).to.equal(SEED_QUOTE + ethers.parseEther("20"));

      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      const pool = (await ethers.getContractAt(
        "EXNIHILOPool",
        await preMarket.launchedPool()
      )) as unknown as EXNIHILOPool;
      expect(await pool.backedAirToken()).to.equal(tokenReserve);
    });

    it("reverts when the cost exceeds maxUsdc", async () => {
      const { preMarket, buyer } = await loadFixture(withPreMarketFixture);
      const { cost } = await pinBuyoutCost(preMarket, 60n);

      await expect(
        preMarket.connect(buyer).buyout(cost - 1n, 0n)
      ).to.be.revertedWithCustomError(preMarket, "CostExceedsMax");
    });

    it("accepts maxUsdc exactly equal to the cost", async () => {
      const { preMarket, buyer } = await loadFixture(withPreMarketFixture);
      const { cost } = await pinBuyoutCost(preMarket, 60n);

      await expect(preMarket.connect(buyer).buyout(cost, 0n)).to.not.be.reverted;
    });

    it("reverts when the quote received is below minQuoteOut", async () => {
      const { preMarket, buyer } = await loadFixture(withPreMarketFixture);
      await expect(
        preMarket.connect(buyer).buyout(ethers.MaxUint256, SEED_QUOTE + 1n)
      ).to.be.revertedWithCustomError(preMarket, "QuoteBelowMin");
    });

    it("fills at the reserve price once decay has bottomed out", async () => {
      // This used to assert the opposite: that there was NO reserve price and a
      // late fill got whatever decay had reached. That property WAS C-2 - it let
      // a bidder inflate the reserve with borrowed quote and buy it back at the
      // floor. Discounting now stops at 10 %.
      const { preMarket, buyer } = await loadFixture(withPreMarketFixture);
      const { cost } = await pinBuyoutCost(preMarket, 600n);
      expect(cost).to.equal((SEED_QUOTE * PRICE_FLOOR) / 10n ** 18n);

      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      const pool = (await ethers.getContractAt(
        "EXNIHILOPool",
        await preMarket.launchedPool()
      )) as unknown as EXNIHILOPool;
      expect(await pool.backedAirUsd()).to.equal(cost);
    });

    /**
     * The state that used to be terminal. A quote reserve worth less than one
     * price unit rounded to a zero cost, a zero-cost buyout had to be rejected,
     * and nothing in PreMarket can return the reserves — so the rejection was
     * permanent. The old fix was a flat $1 total, which is what C-2 exploited.
     *
     * The state is now unreachable from the other end: the constructor requires
     * the seeded reserve to be worth materially more than the backstop, and with
     * the price floored at 90 % of startPrice trading cannot drag it down to a
     * rounding boundary. And the state is not terminal in any case — see the
     * drained-reserve suite at the end of this file.
     */
    it("rejects a seed too small for the auction to price", async () => {
      const base = await loadFixture(deployFixture);
      const dust = ethers.parseEther("0.1"); // 0.1 quote at $60 = $6
      // The revert comes from PreMarket's constructor, so the error ABI has to
      // come from there rather than from the factory that called it.
      const F = await ethers.getContractFactory("PreMarket");

      await expect(
        base.pmFactory
          .connect(base.launchpad)
          .createPreMarket(await buildParams(base, { quoteAmount: dust }))
      ).to.be.revertedWithCustomError(F, "InvalidPriceRange");
    });

    it("still prices a fully decayed auction far above the backstop", async () => {
      const { preMarket, startTime } = await loadFixture(withPreMarketFixture);
      await time.increaseTo(startTime + FLOOR_AT * 10n);

      const [cost] = await preMarket.buyoutCost();
      expect(cost).to.equal((SEED_QUOTE * PRICE_FLOOR) / 10n ** 18n);
      expect(cost).to.be.gt(MIN_SEED_USDC * 10n);
    });

    it("rejects a buyout whose maxUsdc sits below the reserve price", async () => {
      const { preMarket, buyer, startTime } = await loadFixture(withPreMarketFixture);
      await time.increaseTo(startTime + FLOOR_AT * 10n);

      // The guard still binds: a bidder who sized maxUsdc off a stale quote
      // gets a revert, not a surprise charge.
      const [cost] = await preMarket.buyoutCost();
      await expect(preMarket.connect(buyer).buyout(cost - 1n, 0n))
        .to.be.revertedWithCustomError(preMarket, "CostExceedsMax");
      await expect(preMarket.connect(buyer).buyout(cost, 0n)).to.not.be.reverted;
    });

    it("is still fillable long after the price bottoms out", async () => {
      const { preMarket, buyer, startTime } = await loadFixture(withPreMarketFixture);
      await time.increaseTo(startTime + FLOOR_AT * 10n);

      await expect(preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n)).to.not.be.reverted;
      expect(await preMarket.launched()).to.equal(true);
    });

    it("cannot be run twice", async () => {
      const { preMarket, buyer } = await loadFixture(withPreMarketFixture);
      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);
      await expect(
        preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n)
      ).to.be.revertedWithCustomError(preMarket, "AlreadyLaunched");
    });

    it("leaves no residual factory approvals", async () => {
      const { preMarket, buyer, pmAddr, token, usdc, marketFactoryAddr } =
        await loadFixture(withPreMarketFixture);

      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      expect(await token.allowance(pmAddr, marketFactoryAddr)).to.equal(0n);
      expect(await usdc.allowance(pmAddr, marketFactoryAddr)).to.equal(0n);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Reentrancy
  // ───────────────────────────────────────────────────────────────────────────

  describe("Reentrancy", () => {
    /**
     * Seed a premarket whose project token re-enters on transfer. Reentrancy is
     * armed only after seeding, so createPreMarket's own pull is unaffected.
     */
    async function withReentrantToken(base: Awaited<ReturnType<typeof deployFixture>>) {
      const evil = await (await ethers.getContractFactory("ReentrantToken"))
        .connect(base.deployer)
        .deploy("Evil", "EVIL", 18);

      await evil.mint(base.launchpad.address, SEED_TOKEN);
      await evil.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);

      const params = await buildParams(base, { token: await evil.getAddress() });
      await base.pmFactory.connect(base.launchpad).createPreMarket(params);

      const pm = (await ethers.getContractAt(
        "PreMarket",
        await base.pmFactory.allPreMarkets(0)
      )) as unknown as PreMarket;

      await base.usdc.connect(base.buyer).approve(await pm.getAddress(), ethers.MaxUint256);
      await evil.mint(base.trader.address, SEED_TOKEN);
      await evil.connect(base.trader).approve(await pm.getAddress(), ethers.MaxUint256);

      return { evil, pm };
    }

    it("blocks re-entering swap from the input token", async () => {
      const base = await loadFixture(deployFixture);
      const { evil, pm } = await withReentrantToken(base);

      await evil.setReentrantCall(
        await pm.getAddress(),
        pm.interface.encodeFunctionData("swap", [1n, 0n, true, base.trader.address])
      );

      await expect(
        pm.connect(base.trader).swap(ethers.parseEther("1000"), 0n, true, base.trader.address)
      ).to.be.revertedWithCustomError(pm, "ReentrancyGuardReentrantCall");
    });

    it("blocks re-entering buyout while the market is being created", async () => {
      const base = await loadFixture(deployFixture);
      const { evil, pm } = await withReentrantToken(base);

      // Fires when EXNIHILOFactory pulls the token leg out of the premarket.
      await evil.setReentrantCall(
        await pm.getAddress(),
        pm.interface.encodeFunctionData("buyout", [ethers.MaxUint256, 0n])
      );

      await expect(
        pm.connect(base.buyer).buyout(ethers.MaxUint256, 0n)
      ).to.be.revertedWithCustomError(pm, "ReentrancyGuardReentrantCall");
    });

    it("blocks re-entering buyout from the quote payout", async () => {
      // A malicious quote asset gets control when buyout pushes the reserve to
      // the buyer — earlier than the token pull covered above.
      const base = await loadFixture(deployFixture);
      const evil = await (await ethers.getContractFactory("ReentrantToken"))
        .connect(base.deployer)
        .deploy("Evil", "EVIL", 18);

      await evil.mint(base.launchpad.address, SEED_QUOTE);
      await evil.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);

      const params = await buildParams(base, { quote: await evil.getAddress() });
      await base.pmFactory.connect(base.launchpad).createPreMarket(params);

      const pm = (await ethers.getContractAt(
        "PreMarket",
        await base.pmFactory.allPreMarkets(0)
      )) as unknown as PreMarket;
      await base.usdc.connect(base.buyer).approve(await pm.getAddress(), ethers.MaxUint256);

      await evil.setReentrantTransferCall(
        await pm.getAddress(),
        pm.interface.encodeFunctionData("swap", [1n, 0n, true, base.buyer.address])
      );

      await expect(
        pm.connect(base.buyer).buyout(ethers.MaxUint256, 0n)
      ).to.be.revertedWithCustomError(pm, "ReentrancyGuardReentrantCall");
    });

    it("blocks re-entering createPreMarket while it is seeding", async () => {
      const base = await loadFixture(deployFixture);
      const evil = await (await ethers.getContractFactory("ReentrantToken"))
        .connect(base.deployer)
        .deploy("Evil", "EVIL", 18);

      await evil.mint(base.launchpad.address, SEED_TOKEN * 2n);
      await evil.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);

      const params = await buildParams(base, { token: await evil.getAddress() });
      await evil.setReentrantCall(
        base.pmFactoryAddr,
        base.pmFactory.interface.encodeFunctionData("createPreMarket", [params])
      );

      await expect(
        base.pmFactory.connect(base.launchpad).createPreMarket(params)
      ).to.be.revertedWithCustomError(base.pmFactory, "ReentrancyGuardReentrantCall");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // End to end
  // ───────────────────────────────────────────────────────────────────────────

  describe("End to end", () => {
    it("bonds, trades, buys out, and opens a leveraged position", async () => {
      const { preMarket, trader, buyer, usdc, marketFactory } =
        await loadFixture(withPreMarketFixture);

      // Trading during the auction keeps the ratio live.
      await preMarket.connect(trader).swap(ethers.parseEther("5000"), 0n, true, trader.address);
      await preMarket.connect(trader).swap(ethers.parseEther("2"), 0n, false, trader.address);

      // Auction decays past breakeven, then fills — about a minute in.
      await time.increase(60n);
      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      const poolAddr = await preMarket.launchedPool();
      expect(await marketFactory.isPool(poolAddr)).to.equal(true);

      const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddr)) as unknown as EXNIHILOPool;

      // The market is immediately usable: open a long against it.
      const notional = ethers.parseUnits("100", 6);
      const fee = await pool.quoteOpenFee(notional, true);
      await usdc.mint(trader.address, notional + fee);
      await usdc.connect(trader).approve(poolAddr, ethers.MaxUint256);

      await expect(pool.connect(trader).openLong(notional, 0n, trader.address)).to.not.be.reverted;
      expect(await pool.openPositionCount()).to.equal(1n);
    });

    it("works with a 6-decimal quote asset", async () => {
      const base = await loadFixture(deployFixture);
      const sixDec = (await (await ethers.getContractFactory("MockERC20"))
        .connect(base.deployer)
        .deploy("Six", "SIX", 6)) as unknown as MockERC20;

      const quoteAmount = ethers.parseUnits("500", 6);
      await sixDec.mint(base.launchpad.address, quoteAmount);
      await sixDec.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);

      const params = await buildParams(base, {
        quote: await sixDec.getAddress(),
        quoteAmount,
      });
      await base.pmFactory.connect(base.launchpad).createPreMarket(params);

      const pm = (await ethers.getContractAt(
        "PreMarket",
        await base.pmFactory.allPreMarkets(0)
      )) as unknown as PreMarket;
      await base.usdc.connect(base.buyer).approve(await pm.getAddress(), ethers.MaxUint256);

      const { price, cost } = await pinBuyoutCost(pm, 60n, 10n ** 6n);
      // 500 whole units priced per whole unit, scaled by the 6-dec quote unit.
      expect(cost).to.equal((quoteAmount * price) / 10n ** 6n);

      await pm.connect(base.buyer).buyout(ethers.MaxUint256, 0n);

      const pool = (await ethers.getContractAt(
        "EXNIHILOPool",
        await pm.launchedPool()
      )) as unknown as EXNIHILOPool;
      expect(await pool.backedAirUsd()).to.equal(cost);
    });

    it("makes a round trip through the premarket strictly lossy", async () => {
      // This is why no TWAP is needed. Pushing the ratio down to make the real
      // market open cheap means buying back along the very same curve — the real
      // market inherits these reserves continuously. The manipulator pays the
      // fee on both legs and ends up with strictly fewer tokens.
      const { preMarket, trader, token } = await loadFixture(withPreMarketFixture);
      const start = await token.balanceOf(trader.address);

      const dump = ethers.parseEther("100000");
      const quoteBack = await preMarket.getAmountOut(
        dump,
        await preMarket.tokenReserve(),
        await preMarket.quoteReserve()
      );

      await preMarket.connect(trader).swap(dump, 0n, true, trader.address);
      await preMarket.connect(trader).swap(quoteBack, 0n, false, trader.address);

      expect(await token.balanceOf(trader.address)).to.be.lessThan(start);
    });

    it("hands the real market exactly the reserves the premarket held", async () => {
      // The continuity that makes manipulation pointless: whatever the ratio is
      // when the buyout lands is precisely what the market opens with.
      const { preMarket, trader, buyer } = await loadFixture(withPreMarketFixture);

      await preMarket.connect(trader).swap(ethers.parseEther("80000"), 0n, true, trader.address);

      const tokenReserve = await preMarket.tokenReserve();
      const quoteReserve = await preMarket.quoteReserve();
      const price = await pinAt(preMarket, 300n);

      await preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n);

      const pool = (await ethers.getContractAt(
        "EXNIHILOPool",
        await preMarket.launchedPool()
      )) as unknown as EXNIHILOPool;

      expect(await pool.backedAirToken()).to.equal(tokenReserve);
      expect(await pool.backedAirUsd()).to.equal((quoteReserve * price) / 10n ** 18n);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C-2 — the buyout floor as a value-extraction lever
//
// The auction floor exists so a buyout is always executable: below it, the
// priced cost rounds toward zero, a zero-cost buyout has to be rejected, and
// with no withdraw/refund/expiry path anywhere in PreMarket that rejection is
// permanent. The flaw is that the cost was then CONSTANT in quoteReserve below
// the floor, so adding quote to the reserve was free — and buyout hands the
// whole reserve, the addition included, straight back to the payer.
//
// The fix floors the PRICE at MIN_PRICE_BPS of startPrice instead of flooring
// the TOTAL at a flat $1. The cost stays strictly increasing in quoteReserve at
// every point of the decay, and rounding-to-zero cannot arise, so the property
// the flat floor was added for survives.
//
// These tests measure the attacker's net USDC across an atomic, flash-funded
// round trip. They are about economics, not reverts: the question is not
// whether the sequence executes but whether it pays.
// ═════════════════════════════════════════════════════════════════════════════

describe("PreMarket — buyout floor (C-2)", () => {
  const MAX_DISCOUNT_BPS = 1000n; // price floors at 90 % of startPrice

  /** Deploy the lender (funded with quote) and the attacker contract. */
  async function withAttacker(borrow: bigint = SEED_QUOTE * 20n) {
    const fix = await loadFixture(withPreMarketFixture);

    const lender = await (await ethers.getContractFactory("MockFlashLender")).deploy();
    if (borrow > 0n) await fix.quote.mint(await lender.getAddress(), borrow);

    const attacker = await (await ethers.getContractFactory("PreMarketFlashAttacker")).deploy(
      await fix.token.getAddress(),
      await fix.quote.getAddress(),
      await fix.usdc.getAddress(),
      fix.pmAddr,
      await lender.getAddress()
    );

    // Working capital for the buyout leg only — deliberately far more than any
    // buyout can cost, so the test measures whether the attack PAYS rather than
    // whether the attacker happens to be able to afford it.
    const seedUsdc = ethers.parseUnits("5000000", 6);
    await fix.usdc.mint(await attacker.getAddress(), seedUsdc);

    return { ...fix, lender, attacker, borrow, seedUsdc };
  }

  /** Run the attack at `elapsed` seconds and return the attacker's net USDC. */
  async function runAttack(
    ctx: Awaited<ReturnType<typeof withAttacker>>,
    elapsed: bigint
  ): Promise<{ pnl: bigint; cost: bigint; tokensTaken: bigint }> {
    const addr = await ctx.attacker.getAddress();
    const usdcBefore  = await ctx.usdc.balanceOf(addr);
    const quoteBefore = await ctx.quote.balanceOf(addr);
    const tokenBefore = await ctx.token.balanceOf(addr);

    // Pin only when the target is still ahead: loadFixture rewinds state but
    // elapsed=0 lands before the deployment transactions already mined.
    const target = (await ctx.preMarket.startTime()) + elapsed;
    if (target > BigInt(await time.latest())) {
      await time.setNextBlockTimestamp(target);
    }

    // A revert is a legitimate outcome, not a broken test: at large borrows the
    // token dump trips the pool's zero-output guard, so the attacker cannot
    // realise the position at all. Treat it as strictly worse than any profit.
    try {
      await ctx.attacker.attack(ctx.borrow, ethers.MaxUint256);
    } catch {
      if (process.env.ATTACK_DIAG) {
        console.log(`        [diag] elapsed=${elapsed} borrow=${ethers.formatEther(ctx.borrow)} REVERTED`);
      }
      return { reverted: true, pnl: 0n, usdcDelta: 0n, quoteValue: 0n,
               tokenDelta: 0n, cost: 0n, tokensTaken: 0n };
    }

    // Value the WHOLE ending position, not just USDC. The borrowed quote is
    // repaid, but the seeder's original quote leg leaves with the attacker and
    // is worth real money — counting USDC alone would miss the actual theft.
    // Quote is marked at startPrice, which the design documents as roughly spot.
    const quoteDelta = (await ctx.quote.balanceOf(addr)) - quoteBefore;
    const tokenDelta = (await ctx.token.balanceOf(addr)) - tokenBefore;
    const usdcDelta  = (await ctx.usdc.balanceOf(addr)) - usdcBefore;
    const quoteValue = (quoteDelta * START_PRICE) / 10n ** 18n;

    if (process.env.ATTACK_DIAG) {
      console.log(
        `        [diag] elapsed=${elapsed} cost=$${ethers.formatUnits(await ctx.attacker.usdcPaid(), 6)}` +
        ` usdc=${ethers.formatUnits(usdcDelta, 6)} quote=${ethers.formatUnits(quoteValue, 6)}` +
        ` tokensLeft=${ethers.formatEther(tokenDelta)}` +
        ` NET=${ethers.formatUnits(usdcDelta + quoteValue, 6)}`
      );
    }
    return {
      reverted: false,
      pnl: usdcDelta + quoteValue,
      usdcDelta,
      quoteValue,
      tokenDelta,
      cost: await ctx.attacker.usdcPaid(),
      tokensTaken: await ctx.attacker.tokensTaken(),
    };
  }

  it("inflating the reserve with a flash loan never beats a plain buyout", async function () {
    // A plain buyout at the floor SHOULD pay — the discount is what makes the
    // auction fill, and that is the design working. C-2 was not that the buyout
    // is profitable; it was that the buyer could inflate the reserve with
    // borrowed quote and have the discount apply to their own deposit too.
    // So the property is relative: borrowing must never improve on the baseline.
    const baseline = await runAttack(await withAttacker(0n), FLOOR_AT + 600n);

    for (const mult of [1n, 5n, 20n, 100n]) {
      const ctx = await withAttacker(SEED_QUOTE * mult);
      const r = await runAttack(ctx, FLOOR_AT + 600n);

      if (r.reverted) continue; // could not be realised at all — strictly worse

      // The lever really was pulled: quote went in, tokens came out, and the
      // loan was repaid (MockFlashLender reverts otherwise).
      expect(r.tokensTaken).to.be.gt(0n);

      expect(
        r.pnl,
        `borrowing ${mult}x the seeded quote beat the plain buyout: ` +
        `${ethers.formatUnits(r.pnl, 6)} vs ${ethers.formatUnits(baseline.pnl, 6)}`
      ).to.be.lt(baseline.pnl);
    }
  });

  it("the buyout cost tracks the reserve the attacker inflated", async function () {
    // The defect in one number: under the flat floor this cost was $1 whether
    // the reserve held its seeded 500 quote or 21x that.
    const ctx = await withAttacker(SEED_QUOTE * 20n);
    const { cost } = await runAttack(ctx, FLOOR_AT + 600n);

    const floorPrice = (START_PRICE * (BPS_DENOM - MAX_DISCOUNT_BPS)) / BPS_DENOM;
    const inflated   = SEED_QUOTE * 21n;
    expect(cost).to.be.gte((inflated * floorPrice * 99n) / (10n ** 18n * 100n));
  });

  it("the price never falls below MAX_DISCOUNT_BPS of startPrice", async function () {
    const fix = await loadFixture(withPreMarketFixture);
    const floor = (START_PRICE * (BPS_DENOM - MAX_DISCOUNT_BPS)) / BPS_DENOM;

    for (const elapsed of [FLOOR_AT, FLOOR_AT * 10n, 365n * 24n * 3600n]) {
      await time.increaseTo((await fix.preMarket.startTime()) + elapsed);
      expect(await fix.preMarket.currentPrice()).to.equal(floor);
    }
  });

  it("buyout cost is strictly increasing in quoteReserve, even fully decayed", async function () {
    const fix = await loadFixture(withPreMarketFixture);
    await time.increaseTo((await fix.preMarket.startTime()) + FLOOR_AT * 2n);

    const [before] = await fix.preMarket.buyoutCost();

    // Push quote in; the reserve grows, so the price of taking it must grow.
    await fix.quote.mint(fix.trader.address, SEED_QUOTE);
    await fix.preMarket.connect(fix.trader).swap(SEED_QUOTE, 0n, false, fix.trader.address);

    const [after] = await fix.preMarket.buyoutCost();
    expect(after).to.be.gt(before);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The drained state is temporary, not terminal
//
// A flat MIN_BUYOUT_USDC floor used to clamp the buyout cost up whenever the
// quote reserve priced to nothing. It was kept on the belief that the state was
// otherwise permanent — with no refund path, a reverting buyout would strand
// both legs forever.
//
// That belief was wrong in both directions. quoteReserve is not frozen: anyone
// can swap quote in, which lifts the price above zero, and a reserve that cheap
// is precisely what arbitrage buys. Meanwhile the clamp made a *permanent* bad
// outcome possible — a buyout during the drained moment locked in a launch over
// a near-empty market, and `launched` is one-way.
//
// So buyout now reverts BuyoutNotPriceable there instead. These tests pin that
// the state is reachable, that it reverts, and that anyone can clear it.
// ═════════════════════════════════════════════════════════════════════════════

describe("PreMarket — a drained reserve is temporary, not terminal", () => {
  /** Drain the quote reserve far enough that the priced cost truncates to 0. */
  async function drainQuote() {
    const fix = await loadFixture(withPreMarketFixture);
    await time.increaseTo(fix.startTime + FLOOR_AT);

    const floorPrice = (START_PRICE * (BPS_DENOM - MAX_DISCOUNT_BPS)) / BPS_DENOM;
    const target = 10n ** 18n / floorPrice;
    // Overshoot: the exact landing point depends on the fee and on integer
    // truncation, and the point is reachability, not the minimum.
    const dump = ((SEED_TOKEN * SEED_QUOTE) / target) * 100n;

    await fix.token.mint(fix.trader.address, dump);
    await fix.token.connect(fix.trader).approve(fix.pmAddr, ethers.MaxUint256);
    await fix.preMarket.connect(fix.trader).swap(dump, 0n, true, fix.trader.address);

    return { ...fix, floorPrice };
  }

  it("a large enough token dump drives the priced cost to zero", async () => {
    const { preMarket } = await drainQuote();

    expect(await preMarket.quoteReserve()).to.be.gt(0n); // asymptotic, never empty
    expect((await preMarket.buyoutCost())[0]).to.equal(0n);
  });

  it("buyout reverts there rather than launching a near-empty market", async () => {
    const { preMarket, buyer } = await drainQuote();

    await expect(preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n))
      .to.be.revertedWithCustomError(preMarket, "BuyoutNotPriceable");

    // Nothing is consumed by the failed attempt: still open, still tradeable.
    expect(await preMarket.launched()).to.equal(false);
  });

  it("anyone can clear it with a quote-in swap, and the buyout then works", async () => {
    const { preMarket, trader, buyer, quote, pmAddr } = await drainQuote();

    // This is the whole argument for reverting instead of clamping: the state
    // is escapable permissionlessly, by any party, for a trivial amount.
    await quote.mint(trader.address, ethers.parseEther("1"));
    await quote.connect(trader).approve(pmAddr, ethers.MaxUint256);
    await preMarket.connect(trader).swap(ethers.parseEther("1"), 0n, false, trader.address);

    expect((await preMarket.buyoutCost())[0]).to.be.gt(0n);
    await expect(preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n)).to.not.be.reverted;
    expect(await preMarket.launched()).to.equal(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A USDC quote launches directly, with no auction
//
// The Dutch auction exists to answer one question: what is the bonded quote leg
// worth in USDC? A launchpad that bonded in USDC has already answered it, so
// PreMarketFactory seeds and launches in the same call and the caller gets a
// live market instead of a live auction.
//
// Running the auction anyway would be a giveaway rather than a discovery. It
// would sell USDC for USDC at a price that decays to 10 % below par, so a bidder
// who waits five minutes takes a tenth of the reserve for nothing and the market
// opens that much thinner. These tests pin both halves: the direct path does the
// right thing, and the auction path is unreachable on a USDC quote.
// ═════════════════════════════════════════════════════════════════════════════

describe("PreMarket — a USDC quote launches directly, with no auction", () => {
  it("opens the real market inside createPreMarket", async () => {
    const { preMarket, marketFactory, token, usdc } =
      await loadFixture(withUsdcPreMarketFixture);

    expect(await preMarket.directLaunch()).to.equal(true);
    expect(await preMarket.launched()).to.equal(true);

    const poolAddr = await preMarket.launchedPool();
    expect(poolAddr).to.not.equal(ethers.ZeroAddress);
    expect(await marketFactory.isPool(poolAddr)).to.equal(true);

    // Seeded straight through — no auction price is applied to either leg, so
    // the market opens at exactly the ratio the launchpad bonded.
    const pool = (await ethers.getContractAt("EXNIHILOPool", poolAddr)) as unknown as EXNIHILOPool;
    expect(await pool.backedAirToken()).to.equal(SEED_TOKEN);
    expect(await pool.backedAirUsd()).to.equal(SEED_USDC);
    expect(await token.balanceOf(poolAddr)).to.equal(SEED_TOKEN);
    expect(await usdc.balanceOf(poolAddr)).to.equal(SEED_USDC);
  });

  it("keeps nothing back — the premarket ends the call empty", async () => {
    const { preMarket, pmAddr, token, usdc } = await loadFixture(withUsdcPreMarketFixture);

    expect(await preMarket.tokenReserve()).to.equal(0n);
    expect(await preMarket.quoteReserve()).to.equal(0n);
    expect(await preMarket.launchUsdc()).to.equal(SEED_USDC);
    expect(await token.balanceOf(pmAddr)).to.equal(0n);
    expect(await usdc.balanceOf(pmAddr)).to.equal(0n);
  });

  it("charges the launchpad exactly its seed, and nobody buys anything", async () => {
    const base = await loadFixture(deployFixture);
    await base.usdc.mint(base.launchpad.address, SEED_USDC);
    await base.usdc.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);

    const usdcBefore = await base.usdc.balanceOf(base.launchpad.address);
    const tokenBefore = await base.token.balanceOf(base.launchpad.address);

    await base.pmFactory.connect(base.launchpad).createPreMarket(
      await buildParams(base, {
        quote: await base.usdc.getAddress(),
        quoteAmount: SEED_USDC,
      })
    );

    expect(await base.usdc.balanceOf(base.launchpad.address)).to.equal(usdcBefore - SEED_USDC);
    expect(await base.token.balanceOf(base.launchpad.address)).to.equal(tokenBefore - SEED_TOKEN);
  });

  it("locks the LP NFT in a vault wired to the lpOwner and integrator", async () => {
    const { preMarket, lpNft, pmAddr, lpRecipient, other } =
      await loadFixture(withUsdcPreMarketFixture);

    const vaultAddr = await preMarket.lpVault();
    expect(vaultAddr).to.not.equal(ethers.ZeroAddress);
    expect(await lpNft.ownerOf(0n)).to.equal(vaultAddr);
    expect(await lpNft.balanceOf(pmAddr)).to.equal(0n);

    const vault = await ethers.getContractAt("LockedLpVault", vaultAddr);
    expect(await vault.lp()).to.equal(lpRecipient.address);
    expect(await vault.integrator()).to.equal(other.address);
    expect(await vault.integratorBps()).to.equal(5000n);
    expect(await vault.pool()).to.equal(await preMarket.launchedPool());
    expect(await vault.isFunded()).to.equal(true);
  });

  it("locks the liquidity immediately — nobody can withdraw it", async () => {
    const { preMarket, launchpad, lpRecipient, other, buyer } =
      await loadFixture(withUsdcPreMarketFixture);

    const pool = (await ethers.getContractAt(
      "EXNIHILOPool",
      await preMarket.launchedPool()
    )) as unknown as EXNIHILOPool;

    for (const who of [launchpad, lpRecipient, other, buyer]) {
      await expect(
        pool.connect(who).removeLiquidity()
      ).to.be.revertedWithCustomError(pool, "OnlyLpHolder");
    }
  });

  it("emits Launched and never BoughtOut", async () => {
    const base = await loadFixture(deployFixture);
    await base.usdc.mint(base.launchpad.address, SEED_USDC);
    await base.usdc.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);

    const tx = await base.pmFactory.connect(base.launchpad).createPreMarket(
      await buildParams(base, {
        quote: await base.usdc.getAddress(),
        quoteAmount: SEED_USDC,
      })
    );
    await tx.wait();

    const pm = (await ethers.getContractAt(
      "PreMarket",
      await base.pmFactory.allPreMarkets(0)
    )) as unknown as PreMarket;

    await expect(tx).to.emit(base.pmFactory, "PreMarketCreated");
    await expect(tx).to.emit(pm, "Launched");
    await expect(tx).to.not.emit(pm, "BoughtOut");
  });

  it("reports no auction at all", async () => {
    const { preMarket } = await loadFixture(withUsdcPreMarketFixture);

    // Recorded as zero rather than carried over, so nothing off-chain reads the
    // ignored parameters as a live auction.
    expect(await preMarket.startPrice()).to.equal(0n);
    expect(await preMarket.decayBpsPerMinute()).to.equal(0n);
    expect(await preMarket.currentPrice()).to.equal(0n);

    const [cost, quoteOut] = await preMarket.buyoutCost();
    expect(cost).to.equal(0n);
    expect(quoteOut).to.equal(0n);
  });

  it("still prices at zero years later, rather than reverting", async () => {
    // currentPrice divides by decayBpsPerMinute, which is zero here. The
    // direct-launch short-circuit is what keeps this a view and not a panic.
    const { preMarket } = await loadFixture(withUsdcPreMarketFixture);
    await time.increase(365 * 24 * 60 * 60);
    expect(await preMarket.currentPrice()).to.equal(0n);
  });

  it("is closed to trading and to buyouts", async () => {
    const { preMarket, trader, buyer } = await loadFixture(withUsdcPreMarketFixture);

    await expect(
      preMarket.connect(trader).swap(1n, 0n, true, trader.address)
    ).to.be.revertedWithCustomError(preMarket, "AlreadyLaunched");

    await expect(
      preMarket.connect(buyer).buyout(ethers.MaxUint256, 0n)
    ).to.be.revertedWithCustomError(preMarket, "AlreadyLaunched");
  });

  it("rejects launchDirect from anyone but the seeder", async () => {
    const { preMarket, other } = await loadFixture(withUsdcPreMarketFixture);
    await expect(
      preMarket.connect(other).launchDirect()
    ).to.be.revertedWithCustomError(preMarket, "OnlySeeder");
  });

  it("cannot be launched twice, even by the seeder", async () => {
    const { preMarket, pmFactoryAddr } = await loadFixture(withUsdcPreMarketFixture);

    await ethers.provider.send("hardhat_setBalance", [pmFactoryAddr, "0x56BC75E2D63100000"]);
    const asFactory = await ethers.getImpersonatedSigner(pmFactoryAddr);

    await expect(
      preMarket.connect(asFactory).launchDirect()
    ).to.be.revertedWithCustomError(preMarket, "AlreadyLaunched");
  });

  it("rejects launchDirect on an auction premarket", async () => {
    const { preMarket, launchpad } = await loadFixture(withPreMarketFixture);
    await expect(
      preMarket.connect(launchpad).launchDirect()
    ).to.be.revertedWithCustomError(preMarket, "NotDirectLaunch");
  });

  it("ignores the auction parameters instead of rejecting them", async () => {
    // A launchpad passing its usual defaults should not have to special-case its
    // own quote asset — values the auction path rejects outright go through
    // here untouched.
    const base = await loadFixture(deployFixture);
    await base.usdc.mint(base.launchpad.address, MIN_SEED_USDC);
    await base.usdc.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);

    await expect(
      base.pmFactory.connect(base.launchpad).createPreMarket(
        await buildParams(base, {
          quote: await base.usdc.getAddress(),
          quoteAmount: MIN_SEED_USDC,
          startPrice: 0n,
          decayBpsPerMinute: 0n,
        })
      )
    ).to.not.be.reverted;
  });

  it("still holds the seeded value to the same minimum", async () => {
    const base = await loadFixture(deployFixture);
    await base.usdc.mint(base.launchpad.address, MIN_SEED_USDC);
    await base.usdc.connect(base.launchpad).approve(base.pmFactoryAddr, ethers.MaxUint256);
    const F = await ethers.getContractFactory("PreMarket");

    await expect(
      base.pmFactory.connect(base.launchpad).createPreMarket(
        await buildParams(base, {
          quote: await base.usdc.getAddress(),
          quoteAmount: MIN_SEED_USDC - 1n,
        })
      )
    ).to.be.revertedWithCustomError(F, "SeedBelowMinimum");
  });

  it("is a launch, not a venue, even when deployed by hand", async () => {
    // Off the factory path nobody calls launchDirect, so a USDC premarket could
    // sit unlaunched. It must still refuse to run the auction there: selling
    // USDC for USDC at a decaying price is the giveaway this path exists to
    // avoid, and `launched` would be one-way once taken.
    const base = await loadFixture(deployFixture);
    const usdcAddr = await base.usdc.getAddress();

    const F = await ethers.getContractFactory("PreMarket");
    const pm = (await F.connect(base.launchpad).deploy(
      {
        token:             await base.token.getAddress(),
        quote:             usdcAddr,
        usdc:              usdcAddr,
        factory:           base.marketFactoryAddr,
        creator:           base.launchpad.address,
        lpOwner:           base.lpRecipient.address,
        integrator:        base.other.address,
        quoteDecimals:     6,
        startPrice:        START_PRICE,
        decayBpsPerMinute: DECAY_BPS_MIN,
      },
      SEED_TOKEN,
      SEED_USDC
    )) as unknown as PreMarket;

    expect(await pm.directLaunch()).to.equal(true);
    expect(await pm.launched()).to.equal(false);
    expect(await pm.currentPrice()).to.equal(0n);

    await expect(
      pm.connect(base.trader).swap(1n, 0n, true, base.trader.address)
    ).to.be.revertedWithCustomError(pm, "NoAuction");

    await expect(
      pm.connect(base.buyer).buyout(ethers.MaxUint256, 0n)
    ).to.be.revertedWithCustomError(pm, "NoAuction");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Audit RE2-1 — the funding window.
//
// The constructor records the reserves, but the assets can only arrive after it
// returns: the address does not exist until then. In between, the contract is a
// live AMM quoting reserves it does not hold, and the transfers that fund it
// hand control to the token and the quote asset.
//
// It was safe only incidentally — every exit pays out before it is paid, so an
// empty contract fails on its own transfer. These assert the guard instead, and
// fail if `funded` or the balance check inside confirmFunded is removed.
// ═════════════════════════════════════════════════════════════════════════════

describe("PreMarket — the funding window is guarded, not merely survivable", () => {
  /** An auction premarket deployed by hand, deliberately left unfunded. */
  async function unfundedFixture() {
    const base = await loadFixture(deployFixture);
    const F = await ethers.getContractFactory("PreMarket");
    const pm = (await F.connect(base.launchpad).deploy(
      {
        token:             await base.token.getAddress(),
        quote:             await base.quote.getAddress(),
        usdc:              await base.usdc.getAddress(),
        factory:           base.marketFactoryAddr,
        creator:           base.launchpad.address,
        lpOwner:           base.lpRecipient.address,
        integrator:        base.other.address,
        quoteDecimals:     18,
        startPrice:        START_PRICE,
        decayBpsPerMinute: DECAY_BPS_MIN,
      },
      SEED_TOKEN,
      SEED_QUOTE
    )) as unknown as PreMarket;
    return { ...base, pm };
  }

  it("starts unfunded, with the reserves already on the books", async () => {
    const { pm } = await unfundedFixture();
    expect(await pm.funded()).to.equal(false);
    expect(await pm.tokenReserve()).to.equal(SEED_TOKEN);
    expect(await pm.quoteReserve()).to.equal(SEED_QUOTE);
  });

  it("refuses to swap against reserves it does not hold", async () => {
    const { pm, trader } = await unfundedFixture();
    await expect(
      pm.connect(trader).swap(1n, 0n, true, trader.address)
    ).to.be.revertedWithCustomError(pm, "NotFunded");
  });

  it("refuses a buyout against reserves it does not hold", async () => {
    const { pm, buyer } = await unfundedFixture();
    await expect(
      pm.connect(buyer).buyout(ethers.MaxUint256, 0n)
    ).to.be.revertedWithCustomError(pm, "NotFunded");
  });

  it("cannot be opened by anyone but the seeder", async () => {
    const { pm, trader } = await unfundedFixture();
    await expect(pm.connect(trader).confirmFunded())
      .to.be.revertedWithCustomError(pm, "OnlySeeder");
  });

  it("cannot be opened on the seeder's word alone — the balances are checked", async () => {
    const { pm, token, launchpad } = await unfundedFixture();

    // One leg only. The seeder is the caller and still cannot open it.
    await token.mint(await pm.getAddress(), SEED_TOKEN);
    await expect(pm.connect(launchpad).confirmFunded())
      .to.be.revertedWithCustomError(pm, "NotFunded");
    expect(await pm.funded()).to.equal(false);
  });

  it("opens once both legs are actually there", async () => {
    const { pm, token, quote, launchpad, trader } = await unfundedFixture();
    const addr = await pm.getAddress();

    await token.mint(addr, SEED_TOKEN);
    await quote.mint(addr, SEED_QUOTE);
    await pm.connect(launchpad).confirmFunded();

    expect(await pm.funded()).to.equal(true);
    await expect(
      pm.connect(trader).swap(1n, 0n, true, trader.address)
    ).to.not.be.revertedWithCustomError(pm, "NotFunded");
  });

  it("is already open when the factory hands it back", async () => {
    // The ordinary path: createPreMarket funds it and confirms before it is
    // reachable by anyone else, so no caller ever observes the window.
    const { preMarket } = await loadFixture(withPreMarketFixture);
    expect(await preMarket.funded()).to.equal(true);
  });
});
