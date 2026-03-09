import { type ChangeEvent } from "react";
import { useAccount, useReadContract } from "wagmi";
import { erc20Abi } from "@exnihilio/abis";
import { formatToken } from "../../lib/format.ts";

interface TokenInputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  tokenAddress?: `0x${string}`;
  decimals?: number;
  symbol?: string;
  disabled?: boolean;
}

export default function TokenInput({
  label,
  value,
  onChange,
  tokenAddress,
  decimals = 18,
  symbol,
  disabled,
}: TokenInputProps) {
  const { address } = useAccount();

  const { data: balance } = useReadContract(
    tokenAddress && address
      ? {
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }
      : undefined
  );

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (/^\d*\.?\d*$/.test(val)) onChange(val);
  };

  const setMax = () => {
    if (balance === undefined) return;
    const scale = 10n ** BigInt(decimals);
    const whole = balance / scale;
    const frac = balance % scale;
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    onChange(fracStr ? `${whole}.${fracStr}` : whole.toString());
  };

  return (
    <div className="flex flex-col gap-1">
      {/* Label row */}
      <div className="flex justify-between items-baseline">
        <label
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            letterSpacing: "0.15em",
            color: "var(--muted)",
            textTransform: "uppercase",
          }}
        >
          {label}
        </label>
        {balance !== undefined && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.62rem",
              color: "var(--muted)",
              letterSpacing: "0.05em",
            }}
          >
            BAL: {formatToken(balance, decimals)} {symbol}
          </span>
        )}
      </div>

      {/* Input row */}
      <div className="flex gap-0">
        <input
          type="text"
          value={value}
          onChange={handleChange}
          disabled={disabled}
          placeholder="0.00"
          className="input-terminal flex-1"
          style={{ borderRight: symbol ? "none" : undefined }}
        />
        {symbol && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.72rem",
              letterSpacing: "0.08em",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              color: "var(--muted)",
              padding: "8px 12px",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
            }}
          >
            {symbol}
          </span>
        )}
        {balance !== undefined && (
          <button
            type="button"
            onClick={setMax}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              letterSpacing: "0.1em",
              background: "transparent",
              border: "1px solid var(--border)",
              borderLeft: "none",
              color: "var(--cyan)",
              padding: "8px 10px",
              cursor: "pointer",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) =>
              ((e.target as HTMLElement).style.background = "var(--cyan-glow)")
            }
            onMouseLeave={(e) =>
              ((e.target as HTMLElement).style.background = "transparent")
            }
          >
            MAX
          </button>
        )}
      </div>
    </div>
  );
}
