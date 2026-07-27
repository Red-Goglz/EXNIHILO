import { useState, useEffect } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { showToast } from "../components/shared/Toast.tsx";

export type TxStatus = "idle" | "pending" | "confirming" | "success" | "error";

/**
 * Wraps useWriteContract + useWaitForTransactionReceipt into one status
 * machine that actually surfaces failures: wallet rejection, on-chain
 * revert, and an 8s confirmation timeout all land in status "error" and
 * fire a toast. Every tx flow in the app should use this instead of
 * hand-rolling the pair (a hand-rolled pair silently swallows errors).
 *
 * @param label Short action name used in toasts, e.g. "RENEWAL", "CLAIM".
 */
export function useTx(label: string) {
  const {
    writeContract,
    data: hash,
    isPending,
    isError: isRejected,
    reset,
  } = useWriteContract();
  const {
    isLoading: isConfirming,
    isSuccess,
    isError: isFailed,
    data: receipt,
  } = useWaitForTransactionReceipt({ hash });

  // Confirmation timeout: submitted but not mined within 8s.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!hash || isSuccess || isFailed) {
      setTimedOut(false);
      return;
    }
    const t = setTimeout(() => setTimedOut(true), 8_000);
    return () => clearTimeout(t);
  }, [hash, isSuccess, isFailed]);

  useEffect(() => {
    if (isRejected) showToast(`${label} REJECTED`);
  }, [isRejected, label]);
  useEffect(() => {
    if (isFailed) showToast(`${label} FAILED ON-CHAIN`);
  }, [isFailed, label]);
  useEffect(() => {
    if (timedOut) showToast(`${label} CONFIRMATION TIMED OUT`);
  }, [timedOut, label]);

  const status: TxStatus = isPending
    ? "pending"
    : isConfirming
    ? "confirming"
    : isSuccess
    ? "success"
    : isRejected || isFailed || timedOut
    ? "error"
    : "idle";

  const errorLabel = timedOut ? "TIMED OUT" : isRejected ? "REJECTED" : "FAILED";

  return { writeContract, status, isSuccess, errorLabel, reset, hash, receipt };
}
