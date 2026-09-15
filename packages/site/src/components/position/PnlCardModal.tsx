import { useEffect, useState } from "react";
import { formatUsdc } from "../../lib/format.ts";
import { buildPnlCardSvg, type PnlCardData } from "../../lib/pnlCard.ts";
import { showToast } from "../shared/Toast.tsx";

/**
 * Shareable PnL card for a position.
 *
 * The card is drawn client-side (lib/pnlCard.ts) rather than taken from
 * PositionNFT.tokenURI: the on-chain art's 10px labels at #555 are unreadable
 * once the 800×450 canvas is scaled down, and that renderer lives in a contract
 * with no owner and no proxy, referenced by every pool as an `immutable` — so
 * it cannot be restyled without redeploying the protocol. The numbers are the
 * same live values the row and the card already read from the pool.
 */

interface PnlCardModalProps extends PnlCardData {
  onClose: () => void;
}

/**
 * Rasterise an SVG string to a PNG blob. The markup is inlined as a data URI,
 * which does not taint the canvas, so the result is readable back out.
 *
 * The card declares explicit width/height, but the size is still taken from the
 * viewBox as a fallback: an SVG without intrinsic dimensions can report
 * `naturalWidth === 0` once loaded into an Image and rasterise at the wrong
 * aspect ratio.
 */
async function svgToPng(svgText: string, scale = 2): Promise<Blob> {
  const viewBox = svgText.match(/viewBox="\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*"/);
  const vbWidth = viewBox ? parseFloat(viewBox[3]) : 0;
  const vbHeight = viewBox ? parseFloat(viewBox[4]) : 0;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not load the card image"));
    // URI-encode rather than base64: btoa throws on non-Latin1 token symbols.
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  });

  const width = Math.round((img.naturalWidth || vbWidth || 800) * scale);
  const height = Math.round((img.naturalHeight || vbHeight || 450) * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.drawImage(img, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image"))),
      "image/png",
    );
  });
}

export default function PnlCardModal({ onClose, ...data }: PnlCardModalProps) {
  const { tokenId, tokenSymbol, isLong, hasPnl, pnlPositive, pnlNetAbs, returnPct } = data;
  const [busy, setBusy] = useState<"copy" | "download" | null>(null);

  // Close on Escape — a modal that only closes by button is a trap on mobile.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Not memoised: `data` is a fresh rest-spread object every render, so a memo
  // keyed on it would never hit. Building the markup is a template string over
  // a dozen values — cheaper than the equality check would be.
  const svg = buildPnlCardSvg(data);
  const imageSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  // Return on premium, same figure the card draws. Both it and `pnlNetAbs` are
  // net of the premium, so the dollar amount and the percent share a basis.
  const pctText = returnPct === null
    ? null
    : `${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(0)}%`;

  const shareText =
    `${isLong ? "LONG" : "SHORT"} ${tokenSymbol}/USDC on EXNIHILO` +
    (hasPnl
      ? `\n${pnlPositive ? "+" : "-"}${formatUsdc(pnlNetAbs)}${pctText ? ` (${pctText} on premium)` : ""}`
      : "") +
    `\n\nOut of thin air - without any collateral.\n\nhttps://exnihilo.markets`;

  async function handleCopyImage() {
    setBusy("copy");
    try {
      const blob = await svgToPng(svg);
      // Not universally supported — Safari/Firefox have historically limited
      // image writes — so failures fall through to the download path.
      if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
        throw new Error("Clipboard images unsupported in this browser");
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast("CARD COPIED — PASTE INTO YOUR POST", "info");
    } catch (e) {
      showToast(
        `COPY FAILED: ${(e as Error).message.slice(0, 48)} — TRY DOWNLOAD`,
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleDownload() {
    setBusy("download");
    try {
      const blob = await svgToPng(svg);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `exnihilo-${tokenSymbol.toLowerCase()}-${isLong ? "long" : "short"}-${tokenId}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      showToast(`DOWNLOAD FAILED: ${(e as Error).message.slice(0, 48)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  function handleShareOnX() {
    // X's intent endpoint takes text only — images cannot be attached
    // programmatically, so the flow is copy/download first, then paste.
    const url = new URL("https://twitter.com/intent/tweet");
    url.searchParams.set("text", shareText);
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.86)",
        backdropFilter: "blur(6px)",
        padding: 20,
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 420,
          background: "var(--surface)",
          border: "1px solid var(--cyan)",
          padding: "24px 20px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <span style={{ position: "absolute", top: -1, left: -1, width: 14, height: 14, borderTop: "1px solid var(--cyan)", borderLeft: "1px solid var(--cyan)" }} />
        <span style={{ position: "absolute", bottom: -1, right: -1, width: 14, height: 14, borderBottom: "1px solid var(--cyan)", borderRight: "1px solid var(--cyan)" }} />

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "1.2rem", color: "#fff", letterSpacing: "0.05em", margin: 0 }}>
            POSITION #{tokenId.toString()}
          </h2>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: "0.8rem", padding: 0 }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Card art */}
        <div
          style={{
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            overflow: "hidden",
          }}
        >
          <img
            src={imageSrc}
            alt={`${tokenSymbol} ${isLong ? "long" : "short"} position card`}
            style={{ width: "100%", height: "auto", display: "block" }}
          />
        </div>

        {/* No stats grid here — side, size, premium, PnL, opened and size left are
            all already rendered inside the card above. */}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={handleCopyImage}
            disabled={busy !== null}
            className="btn-terminal"
            style={{ flex: 1, justifyContent: "center" }}
          >
            {busy === "copy" ? <><span className="spinner">⟳</span> COPYING</> : "COPY IMAGE"}
          </button>
          <button
            onClick={handleDownload}
            disabled={busy !== null}
            className="btn-terminal"
            style={{ flex: 1, justifyContent: "center" }}
          >
            {busy === "download" ? <><span className="spinner">⟳</span> SAVING</> : "DOWNLOAD"}
          </button>
        </div>

        <button
          onClick={handleShareOnX}
          className="btn-terminal btn-cyan"
          style={{ width: "100%", justifyContent: "center" }}
        >
          SHARE ON X
        </button>

        <p style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-nano)", color: "var(--dim)", letterSpacing: "0.06em", lineHeight: 1.6, margin: 0, textAlign: "center" }}>
          X can't attach images from a link — copy or download the card first,
          then paste it into the post.
        </p>
      </div>
    </div>
  );
}
