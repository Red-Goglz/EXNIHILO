import { useEffect, useMemo, useState } from "react";
import { useReadContract } from "wagmi";
import { positionNFTAbi } from "@exnihilio/abis";
import { formatUsdc } from "../../lib/format.ts";
import { useAppChain } from "../../hooks/useAppChain.ts";
import { showToast } from "../shared/Toast.tsx";

/**
 * Shareable PnL card for a position.
 *
 * The image is the position's own on-chain art: PositionNFT.tokenURI returns a
 * base64 JSON blob whose `image` is a base64 SVG rendered from live pool
 * reserves, so the card already shows current PnL with no server involved.
 * Rasterising that SVG is what "copy image" produces.
 */

// Only what the share text needs — every stat shown to the user comes from the
// on-chain card image itself.
interface PnlCardModalProps {
  tokenId: bigint;
  positionNFTAddress: `0x${string}`;
  tokenSymbol: string;
  isLong: boolean;
  feesPaidRaw: bigint;
  hasPnl: boolean;
  pnlPositive: boolean;
  pnlNetAbs: bigint;
  onClose: () => void;
}

/** `data:application/json;base64,...` → the `image` field inside it. */
function decodeTokenUriImage(tokenUri: string | undefined): string | undefined {
  if (!tokenUri) return undefined;
  const marker = "base64,";
  const idx = tokenUri.indexOf(marker);
  if (idx === -1) return undefined;
  try {
    const json = JSON.parse(atob(tokenUri.slice(idx + marker.length)));
    return typeof json.image === "string" ? json.image : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rasterise a data-URI SVG to a PNG blob. Data URIs don't taint the canvas, so
 * the result is readable back out.
 *
 * The on-chain art declares only a `viewBox` (`0 0 400 440`) with no width or
 * height. An SVG without intrinsic dimensions can report `naturalWidth === 0`
 * once loaded into an Image, which would rasterise at the wrong aspect — so the
 * size is taken from the viewBox and stamped onto the markup before loading.
 */
async function svgDataUriToPng(dataUri: string, scale = 2): Promise<Blob> {
  const b64 = dataUri.split("base64,")[1];
  if (!b64) throw new Error("Unrecognised image encoding");

  const svgText = atob(b64);
  const viewBox = svgText.match(/viewBox="\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*"/);
  const vbWidth = viewBox ? parseFloat(viewBox[3]) : 0;
  const vbHeight = viewBox ? parseFloat(viewBox[4]) : 0;

  const hasSize = /<svg[^>]*\swidth=/.test(svgText);
  const sized = hasSize || !viewBox
    ? svgText
    : svgText.replace(/<svg\b/, `<svg width="${vbWidth}" height="${vbHeight}"`);

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not load the card image"));
    // Re-encode via a Blob URL: base64 of non-Latin1 SVG text can throw.
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  });

  const width = Math.round((img.naturalWidth || vbWidth || 400) * scale);
  const height = Math.round((img.naturalHeight || vbHeight || 440) * scale);

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

export default function PnlCardModal({
  tokenId,
  positionNFTAddress,
  tokenSymbol,
  isLong,
  feesPaidRaw,
  hasPnl,
  pnlPositive,
  pnlNetAbs,
  onClose,
}: PnlCardModalProps) {
  const { chainId } = useAppChain();
  const [busy, setBusy] = useState<"copy" | "download" | null>(null);

  // Close on Escape — a modal that only closes by button is a trap on mobile.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { data: tokenUri, isLoading } = useReadContract({
    address: positionNFTAddress,
    abi: positionNFTAbi,
    functionName: "tokenURI",
    args: [tokenId],
    chainId,
  });

  const imageDataUri = useMemo(
    () => decodeTokenUriImage(tokenUri as string | undefined),
    [tokenUri],
  );

  const pnlPct = feesPaidRaw > 0n
    ? ((Number(pnlNetAbs) / Number(feesPaidRaw)) * 100).toFixed(0)
    : "0";

  const shareText =
    `${isLong ? "LONG" : "SHORT"} ${tokenSymbol}/USDC on EXNIHILO` +
    (hasPnl
      ? `\n${pnlPositive ? "+" : "-"}$${formatUsdc(pnlNetAbs)} (${pnlPositive ? "+" : "-"}${pnlPct}%)`
      : "") +
    `\n\nOut of thin air - without any collateral.\n\nhttps://exnihilo.markets`;

  async function handleCopyImage() {
    if (!imageDataUri) return;
    setBusy("copy");
    try {
      const blob = await svgDataUriToPng(imageDataUri);
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
    if (!imageDataUri) return;
    setBusy("download");
    try {
      const blob = await svgDataUriToPng(imageDataUri);
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

        {/* On-chain card art */}
        <div
          style={{
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            minHeight: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {imageDataUri ? (
            <img
              src={imageDataUri}
              alt={`${tokenSymbol} ${isLong ? "long" : "short"} position card`}
              style={{ width: "100%", height: "auto", display: "block" }}
            />
          ) : (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-label)", color: "var(--muted)", letterSpacing: "0.1em", padding: 40 }}>
              {isLoading ? (
                <><span className="spinner">⟳</span> LOADING CARD<span className="cursor-blink">_</span></>
              ) : (
                "ON-CHAIN ART UNAVAILABLE"
              )}
            </span>
          )}
        </div>

        {/* No stats grid here — side, size, fees, PnL, opened and expires are
            all already rendered inside the on-chain card above. */}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={handleCopyImage}
            disabled={!imageDataUri || busy !== null}
            className="btn-terminal"
            style={{ flex: 1, justifyContent: "center" }}
          >
            {busy === "copy" ? <><span className="spinner">⟳</span> COPYING</> : "COPY IMAGE"}
          </button>
          <button
            onClick={handleDownload}
            disabled={!imageDataUri || busy !== null}
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
