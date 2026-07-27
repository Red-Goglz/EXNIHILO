import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useAppChain } from "../../hooks/useAppChain.ts";

const FAUCET_ABI = [
  {
    name: "claim",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

export default function FaucetButtons() {
  const { isConnected } = useAccount();
  const { chainId, addresses, testnet } = useAppChain();

  if (!isConnected || !testnet) return null;

  const faucetAddr = "faucet" in addresses ? addresses.faucet : undefined;

  return (
    <>
      <AvaxFaucetLink />
      {faucetAddr && <UsdcFaucetClaim faucetAddr={faucetAddr} chainId={chainId} />}
    </>
  );
}

const faucetButtonStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.12em",
  padding: "4px 10px",
  border: "1px solid var(--green)",
  background: "transparent",
  color: "var(--green)",
  cursor: "pointer",
  transition: "all 0.15s",
  textDecoration: "none",
};

function AvaxFaucetLink() {
  return (
    <a
      href="https://core.app/tools/testnet-faucet"
      target="_blank"
      rel="noopener noreferrer"
      style={faucetButtonStyle}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--green)";
        e.currentTarget.style.color = "#000";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--green)";
      }}
    >
      AVAX FAUCET ↗
    </a>
  );
}

function UsdcFaucetClaim({ faucetAddr, chainId }: { faucetAddr: `0x${string}`; chainId: number }) {
  const { writeContract, data: txHash, isPending, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError } = useWaitForTransactionReceipt({ hash: txHash });

  const isLoading = isPending || isConfirming;

  const label = isPending
    ? "SIGNING..."
    : isConfirming
    ? "CLAIMING..."
    : isSuccess
    ? "CLAIMED"
    : isError
    ? "FAILED"
    : "USDC FAUCET (MOCK)";

  const handleClick = () => {
    if (isSuccess || isError) {
      reset();
      return;
    }
    writeContract({
      address: faucetAddr,
      abi: FAUCET_ABI,
      functionName: "claim",
      chainId,
    });
  };

  return (
    <button
      onClick={handleClick}
      disabled={isLoading}
      style={{
        ...faucetButtonStyle,
        background: isSuccess ? "var(--green)" : "transparent",
        color: isSuccess ? "#000" : "var(--green)",
        cursor: isLoading ? "wait" : "pointer",
        opacity: isLoading ? 0.6 : 1,
      }}
      onMouseEnter={(e) => {
        if (!isLoading && !isSuccess) {
          e.currentTarget.style.background = "var(--green)";
          e.currentTarget.style.color = "#000";
        }
      }}
      onMouseLeave={(e) => {
        if (!isSuccess) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--green)";
        }
      }}
    >
      {isLoading && "⟳ "}{label}
    </button>
  );
}
