import { useAccount, useChainId, useReadContract, useReadContracts } from "wagmi";
import { positionNFTAbi } from "@exnihilio/abis";
import { getAddresses } from "../contracts/addresses.ts";
import ChainGuard from "../components/wallet/ChainGuard.tsx";
import PositionCard from "../components/position/PositionCard.tsx";

export default function PortfolioPage() {
  return (
    <ChainGuard>
      <PortfolioContent />
    </ChainGuard>
  );
}

interface OnChainPosition {
  isLong: boolean;
  pool: `0x${string}`;
  lockedToken: `0x${string}`;
  lockedAmount: bigint;
  usdcIn: bigint;
  airUsdMinted: bigint;
  airMemeMinted: bigint;
  feesPaid: bigint;
  openedAt: bigint;
}

function PortfolioContent() {
  const { address } = useAccount();
  const chainId = useChainId();
  const addrs = getAddresses(chainId);

  const positionNFT = { address: addrs.positionNFT, abi: positionNFTAbi } as const;

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
              fontSize: "0.62rem",
              color: "var(--muted)",
              letterSpacing: "0.1em",
            }}
          >
            {count} OPEN POSITION{count !== 1 ? "S" : ""}
          </span>
        )}
      </div>

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
              fontSize: "0.62rem",
              color: "var(--dim)",
              letterSpacing: "0.08em",
            }}
          >
            Open a Long or Short on any market to get started
          </p>
        </div>
      )}

      {/* Longs section */}
      {longs.length > 0 && (
        <div className="mb-8">
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              letterSpacing: "0.2em",
              color: "var(--green)",
              marginBottom: 12,
              paddingBottom: 8,
              borderBottom: "1px solid var(--border)",
            }}
          >
            LONG POSITIONS ({longs.length})
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
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

      {/* Shorts section */}
      {shorts.length > 0 && (
        <div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              letterSpacing: "0.2em",
              color: "var(--red)",
              marginBottom: 12,
              paddingBottom: 8,
              borderBottom: "1px solid var(--border)",
            }}
          >
            SHORT POSITIONS ({shorts.length})
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
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
  );
}
