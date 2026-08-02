import { useEffect } from "react";
import { useAccount, useBalance, useReadContract, useReadContracts } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { positionNFTAbi, erc20Abi, exnihiloFactoryAbi, exnihiloPoolAbi } from "@exnihilio/abis";
import { useAppChain } from "../hooks/useAppChain.ts";
import { formatUsdc } from "../lib/format.ts";
import { useTx } from "../hooks/useTx.ts";
import ChainGuard from "../components/wallet/ChainGuard.tsx";
import PositionCard from "../components/position/PositionCard.tsx";
import PositionRow from "../components/position/PositionRow.tsx";
import TxButton from "../components/shared/TxButton.tsx";
import { useSeo } from "../lib/seo.ts";

export default function PortfolioPage() {
  // noindex: the content is whatever the connected wallet holds. To a crawler
  // (which has no wallet) this is a permanently empty page, and indexing it
  // would put a blank result under a query someone meant for the app.
  useSeo({
    title: "Your portfolio",
    description:
      "Your open EXNIHILO positions, LP holdings and balances on Avalanche.",
    noindex: true,
  });

  return (
    <ChainGuard>
      <PortfolioContent />
    </ChainGuard>
  );
}

interface OnChainPosition {
  isLong: boolean;
  pool: `0x${string}`;
  lockedAmount: bigint;
  usdcIn: bigint;
  airUsdMinted: bigint;
  airTokenMinted: bigint;
  feesPaid: bigint;
  openedAt: bigint;
  deadline: bigint;
}

/**
 * Claimable payouts: expired positions closed by third parties credit the
 * holder's `claimable` balance on the pool (pull payment). This section
 * enumerates all pools and offers a one-tap claim wherever a balance exists.
 */
function ClaimablePayouts({ address, factory }: { address: `0x${string}`; factory: `0x${string}` }) {
  const queryClient = useQueryClient();
  const { chainId } = useAppChain();

  const { data: poolCount } = useReadContract({
    address: factory,
    abi: exnihiloFactoryAbi,
    functionName: "allPoolsLength",
    chainId,
  });

  const count = Number(poolCount ?? 0n);
  const { data: poolAddrResults } = useReadContracts({
    contracts: Array.from({ length: count }, (_, i) => ({
      address: factory,
      abi: exnihiloFactoryAbi,
      functionName: "allPools" as const,
      args: [BigInt(i)] as const,
      chainId,
    })),
    query: { enabled: count > 0 },
  });

  const pools = (poolAddrResults ?? [])
    .map((r) => r.result as `0x${string}` | undefined)
    .filter((p): p is `0x${string}` => p !== undefined);

  const { data: claimableResults } = useReadContracts({
    contracts: pools.map((pool) => ({
      address: pool,
      abi: exnihiloPoolAbi,
      functionName: "claimable" as const,
      args: [address] as const,
      chainId,
    })),
    query: { enabled: pools.length > 0 },
  });

  const claimables = pools
    .map((pool, i) => ({ pool, amount: (claimableResults?.[i]?.result as bigint | undefined) ?? 0n }))
    .filter((c) => c.amount > 0n);

  const { writeContract, status: claimStatus, isSuccess } = useTx("CLAIM");

  useEffect(() => {
    if (isSuccess) queryClient.invalidateQueries();
  }, [isSuccess, queryClient]);

  if (claimables.length === 0) return null;

  return (
    <div className="mb-8">
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-label)",
          letterSpacing: "0.2em",
          color: "var(--cyan)",
          marginBottom: 12,
          paddingBottom: 8,
          borderBottom: "1px solid var(--border)",
        }}
      >
        CLAIMABLE PAYOUTS ({claimables.length})
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {claimables.map(({ pool, amount }) => (
          <div
            key={pool}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-micro)",
                letterSpacing: "0.1em",
                color: "var(--muted)",
              }}
            >
              Pool: {pool.slice(0, 10)}...{pool.slice(-6)}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.9rem",
                color: "var(--green)",
                fontWeight: 600,
              }}
            >
              ${formatUsdc(amount)}
            </div>
            <TxButton
              idleLabel="Claim"
              status={claimStatus}
              variant="cyan"
              onClick={() =>
                writeContract({
                  address: pool,
                  abi: exnihiloPoolAbi,
                  functionName: "claimPayout",
                  args: [address],
                  chainId,
                })
              }
              style={{ width: "100%", justifyContent: "center", fontSize: "var(--fs-label)" }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function PortfolioContent() {
  const { address } = useAccount();
  const { chainId, addresses: addrs } = useAppChain();

  // Wallet balances
  const { data: avaxBalance } = useBalance({
    address,
    chainId,
    query: { enabled: !!address },
  });

  const { data: usdcData } = useReadContracts({
    contracts: address ? [
      { address: addrs.usdc, abi: erc20Abi, functionName: "balanceOf" as const, args: [address] as const, chainId },
      { address: addrs.usdc, abi: erc20Abi, functionName: "symbol" as const, chainId },
    ] : [],
    query: { enabled: !!address },
  });

  const usdcBalance = usdcData?.[0]?.result as bigint | undefined;
  const usdcSymbol  = (usdcData?.[1]?.result as string | undefined) ?? "USDC";

  const positionNFT = { address: addrs.positionNFT, abi: positionNFTAbi, chainId } as const;

  const { data: balance, isLoading: balanceLoading } = useReadContract({
    ...positionNFT,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!address },
  });

  const count = Number(balance ?? 0n);
  const indices = Array.from({ length: count }, (_, i) => i);

  const { data: tokenIdResults, isLoading: idsLoading } = useReadContracts({
    contracts: indices.map((i) => ({
      ...positionNFT,
      functionName: "tokenOfOwnerByIndex" as const,
      args: [
        address ?? "0x0000000000000000000000000000000000000000",
        BigInt(i),
      ] as const,
    })),
    query: { enabled: count > 0 && !!address },
  });

  const tokenIds = tokenIdResults
    ?.map((r) => r.result as bigint | undefined)
    .filter((id): id is bigint => id !== undefined) ?? [];

  const { data: positionResults, isLoading: positionsLoading } = useReadContracts({
    contracts: tokenIds.map((id) => ({
      ...positionNFT,
      functionName: "getPosition" as const,
      args: [id] as const,
    })),
    query: { enabled: tokenIds.length > 0 },
  });

  const positions =
    positionResults
      ?.map((r, i) => ({
        tokenId: tokenIds[i],
        position: r.result as OnChainPosition | undefined,
      }))
      .filter(
        (p): p is { tokenId: bigint; position: OnChainPosition } =>
          p.position !== undefined
      ) ?? [];

  const isLoading = balanceLoading || idsLoading || positionsLoading;

  const longs = positions.filter((p) => p.position.isLong);
  const shorts = positions.filter((p) => !p.position.isLong);

  return (
    <div>
      {/* Header */}
      <div className="flex items-baseline justify-between mb-6">
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "2rem",
            color: "#fff",
            letterSpacing: "0.05em",
            lineHeight: 1,
          }}
        >
          PORTFOLIO
        </h1>
        {!isLoading && address && count > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-label)",
              color: "var(--muted)",
              letterSpacing: "0.1em",
            }}
          >
            {count} OPEN POSITION{count !== 1 ? "S" : ""}
          </span>
        )}
      </div>

      {/* Wallet balances */}
      {address && (
        <div
          style={{
            display: "flex",
            gap: 12,
            marginBottom: 24,
          }}
        >
          {/* AVAX */}
          <div
            style={{
              flex: 1,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              padding: "14px 16px",
              position: "relative",
            }}
          >
            <span style={{ position: "absolute", top: -1, left: -1, width: 6, height: 6, borderTop: "1px solid var(--red)", borderLeft: "1px solid var(--red)" }} />
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-micro)",
                letterSpacing: "0.15em",
                color: "var(--muted)",
                marginBottom: 6,
              }}
            >
              {avaxBalance?.symbol ?? "AVAX"}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.9rem",
                color: "#fff",
                fontWeight: 600,
              }}
            >
              {avaxBalance
                ? Number(avaxBalance.formatted).toFixed(4)
                : "—"}
            </div>
          </div>

          {/* USDC */}
          <div
            style={{
              flex: 1,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              padding: "14px 16px",
              position: "relative",
            }}
          >
            <span style={{ position: "absolute", top: -1, left: -1, width: 6, height: 6, borderTop: "1px solid var(--cyan)", borderLeft: "1px solid var(--cyan)" }} />
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-micro)",
                letterSpacing: "0.15em",
                color: "var(--muted)",
                marginBottom: 6,
              }}
            >
              {usdcSymbol}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.9rem",
                color: "#fff",
                fontWeight: 600,
              }}
            >
              {usdcBalance !== undefined
                ? formatUsdc(usdcBalance)
                : "—"}
            </div>
          </div>
        </div>
      )}

      {/* Claimable payouts from expiry-settled positions */}
      {address && <ClaimablePayouts address={address} factory={addrs.factory} />}

      {/* Not connected */}
      {!address && (
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            color: "var(--muted)",
            letterSpacing: "0.1em",
          }}
        >
          Connect your wallet to view positions.
        </p>
      )}

      {/* Loading */}
      {isLoading && (
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            color: "var(--muted)",
            letterSpacing: "0.1em",
          }}
        >
          <span className="spinner">⟳</span> LOADING POSITIONS
          <span className="cursor-blink">_</span>
        </p>
      )}

      {/* Empty */}
      {!isLoading && address && count === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.7rem",
              color: "var(--muted)",
              letterSpacing: "0.12em",
            }}
          >
            — NO OPEN POSITIONS —
          </p>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-label)",
              color: "var(--dim)",
              letterSpacing: "0.08em",
            }}
          >
            Open a Long or Short on any market to get started
          </p>
        </div>
      )}

      {/* Desktop: one row per position */}
      {positions.length > 0 && (
        <div className="positions-desktop">
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-label)",
              letterSpacing: "0.2em",
              color: "var(--cyan)",
              marginBottom: 12,
              paddingBottom: 8,
              borderBottom: "1px solid var(--border)",
            }}
          >
            OPEN POSITIONS ({positions.length})
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="positions-table">
              <thead>
                <tr>
                  <th>SIDE</th>
                  <th>MARKET</th>
                  <th>SIZE</th>
                  <th>EST. PNL</th>
                  <th>EXPIRES</th>
                  <th>AUTO-RENEW</th>
                  <th style={{ textAlign: "right" }}>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {positions.map(({ tokenId, position }) => (
                  <PositionRow
                    key={tokenId.toString()}
                    tokenId={tokenId}
                    position={position}
                    positionNFTAddress={addrs.positionNFT}
                    underlyingUsdc={addrs.usdc}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Mobile: cards, grouped by side */}
      <div className="positions-mobile">
        {longs.length > 0 && (
          <div className="mb-8">
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-label)",
                letterSpacing: "0.2em",
                color: "var(--green)",
                marginBottom: 12,
                paddingBottom: 8,
                borderBottom: "1px solid var(--border)",
              }}
            >
              LONG POSITIONS ({longs.length})
            </div>
            <div className="grid grid-cols-1 gap-4">
              {longs.map(({ tokenId, position }) => (
                <PositionCard
                  key={tokenId.toString()}
                  tokenId={tokenId}
                  position={position}
                  positionNFTAddress={addrs.positionNFT}
                  underlyingUsdc={addrs.usdc}
                />
              ))}
            </div>
          </div>
        )}

        {shorts.length > 0 && (
          <div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-label)",
                letterSpacing: "0.2em",
                color: "var(--red)",
                marginBottom: 12,
                paddingBottom: 8,
                borderBottom: "1px solid var(--border)",
              }}
            >
              SHORT POSITIONS ({shorts.length})
            </div>
            <div className="grid grid-cols-1 gap-4">
              {shorts.map(({ tokenId, position }) => (
                <PositionCard
                  key={tokenId.toString()}
                  tokenId={tokenId}
                  position={position}
                  positionNFTAddress={addrs.positionNFT}
                  underlyingUsdc={addrs.usdc}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
