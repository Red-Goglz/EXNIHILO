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

export default function FaucetButtons() {
  const { isConnected, chainId } = useAccount();

  const isTestnet = chainId === FUJI_CHAIN_ID || chainId === 31337;
  if (!isConnected || !isTestnet) return null;

  const addrs = ADDRESSES[chainId as keyof typeof ADDRESSES];
  const faucetAddr = addrs && "faucet" in addrs ? addrs.faucet : undefined;

  return (
    <>
      <AvaxFaucetLink />
      {faucetAddr && <UsdcFaucetClaim faucetAddr={faucetAddr} />}
    </>
  );
}

const faucetButtonStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.58rem",
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
      AVAX FAUCET
    </a>
  );
}

function UsdcFaucetClaim({ faucetAddr }: { faucetAddr: `0x${string}` }) {
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
    : "USDC FAUCET";

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
