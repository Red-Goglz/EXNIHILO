import { type ButtonHTMLAttributes } from "react";

type TxStatus = "idle" | "pending" | "confirming" | "success" | "error";

interface TxButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  status?: TxStatus;
  idleLabel: string;
  variant?: "cyan" | "red" | "green" | "default";
}

export default function TxButton({
  status = "idle",
  idleLabel,
  disabled,
  className = "",
  variant = "cyan",
  ...props
}: TxButtonProps) {
  const isLoading = status === "pending" || status === "confirming";

  let label: string;
  let extraClass: string;

  switch (status) {
    case "pending":
      label = "SIGNING";
      extraClass = "btn-terminal";
      break;
    case "confirming":
      label = "CONFIRMING";
      extraClass = "btn-terminal";
      break;
    case "success":
      label = "DONE";
      extraClass = "btn-terminal btn-green";
      break;
    case "error":
      label = "FAILED";
      extraClass = "btn-terminal btn-red";
      break;
    default:
      label = idleLabel.toUpperCase();
      extraClass =
        variant === "red"
          ? "btn-terminal btn-red"
          : variant === "green"
          ? "btn-terminal btn-green"
          : variant === "cyan"
          ? "btn-terminal btn-cyan"
          : "btn-terminal";
  }

  return (
    <button
      {...props}
      disabled={disabled || isLoading}
      className={`${extraClass} ${className}`}
    >
      {isLoading && <span className="spinner">⟳</span>}
      {isLoading && status === "pending" && (
        <>
          {label}
          <span className="cursor-blink">_</span>
        </>
      )}
      {isLoading && status === "confirming" && (
        <>
          {label}
          <span className="cursor-blink">_</span>
        </>
      )}
      {!isLoading && label}
    </button>
  );
}
