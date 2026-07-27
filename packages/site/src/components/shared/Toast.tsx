import { useState, useEffect } from "react";

/**
 * Minimal global toast: any module calls showToast(message), the single
 * <ToastHost/> mounted in the app layout renders it bottom-right for 5s.
 * Terminal-styled to match TxButton error states.
 */

type ToastKind = "error" | "info";
interface ToastMsg {
  message: string;
  kind: ToastKind;
  key: number;
}

let listener: ((t: ToastMsg) => void) | null = null;

export function showToast(message: string, kind: ToastKind = "error") {
  listener?.({ message, kind, key: Date.now() });
}

export default function ToastHost() {
  const [toast, setToast] = useState<ToastMsg | null>(null);

  useEffect(() => {
    listener = setToast;
    return () => {
      if (listener === setToast) listener = null;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5_000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;

  const color = toast.kind === "error" ? "var(--red)" : "var(--cyan)";
  const glow = toast.kind === "error" ? "rgba(239,68,68,0.25)" : "rgba(0,229,255,0.25)";

  return (
    <div
      key={toast.key}
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        zIndex: 9999,
        background: "var(--surface)",
        border: `1px solid ${color}`,
        padding: "12px 20px",
        fontFamily: "var(--font-mono)",
        fontSize: "0.72rem",
        letterSpacing: "0.08em",
        color,
        boxShadow: `0 4px 24px ${glow}`,
        animation: "toast-in 0.2s ease-out",
        cursor: "pointer",
      }}
      onClick={() => setToast(null)}
    >
      {toast.message}
    </div>
  );
}
