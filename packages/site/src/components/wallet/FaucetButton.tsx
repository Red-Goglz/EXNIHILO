import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { FUJI_CHAIN_ID, ADDRESSES } from "../../contracts/addresses.ts";

const FAUCET_ABI = [
  {
    name: "claim",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

export default function FaucetButton() {
  const { isConnected, chainId } = useAccount();

  const isTestnet = chainId === FUJI_CHAIN_ID || chainId === 31337;
  if (!isConnected || !isTestnet) return null;

  const faucetAddr = ADDRESSES[chainId as keyof typeof ADDRESSES]?.faucet;
  if (!faucetAddr) return null;

  return <FaucetClaim faucetAddr={faucetAddr} />;
}

function FaucetClaim({ faucetAddr }: { faucetAddr: `0x${string}` }) {
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
    : "FAUCET";

  const handleClick = () => {
    if (isSuccess || isError) {
      reset();
      return;
    }
    writeContract({
      address: faucetAddr,
      abi: FAUCET_ABI,
      functionName: "claim",
    });
  };

  return (
    <button
      onClick={handleClick}
      disabled={isLoading}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.58rem",
        letterSpacing: "0.12em",
        padding: "4px 10px",
        border: "1px solid var(--green)",
        background: isSuccess ? "var(--green)" : "transparent",
        color: isSuccess ? "#000" : "var(--green)",
        cursor: isLoading ? "wait" : "pointer",
        transition: "all 0.15s",
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
