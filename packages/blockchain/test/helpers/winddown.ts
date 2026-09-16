import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { EXNIHILOPool } from "../../typechain-types";

/**
 * Retire positions that cannot be closed voluntarily.
 *
 * Positions no longer expire, so an underwater one has no third-party exit the
 * moment a clock runs out. What it has instead is funding: its collateral
 * decays continuously into the LP's reserves, and once the decay has taken all
 * but SWEEP_DUST_BPS of it, sweepDust() lets anyone clear the husk and cancel
 * the synthetic debt that was still distorting the curve.
 *
 * closePool starts the wind-down — opens blocked immediately, then the funding
 * rate doubling every WIND_DOWN_DOUBLING past closeDate. This helper runs that
 * whole path, and is therefore what replaces the old
 * `time.increase(7 days); closePositionAfterDeadline(id)` in tests that need a
 * pool emptied. It is deliberately not a shortcut: the wait is real, and a test
 * using this is asserting that the wind-down actually terminates.
 */
export async function windDownAndSweep(
  pool: EXNIHILOPool,
  lpSigner: HardhatEthersSigner,
  nftIds: bigint[],
): Promise<void> {
  if (!(await pool.isClosing())) {
    await (await pool.connect(lpSigner).closePool()).wait();
  }

  // Grace period, then enough of the doubling ramp to take any position below
  // the sweep threshold. Funding.ts pins the figure this is derived from.
  await time.increase(7 * 24 * 3600 + 45 * 24 * 3600);
  await (await pool.pokeFunding()).wait();

  for (const id of nftIds) {
    try {
      await (await pool.sweepDust(id)).wait();
    } catch {
      // Already released by a voluntary close earlier in the test.
    }
  }
}
