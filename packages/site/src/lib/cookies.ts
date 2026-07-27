/**
 * Minimal first-party cookie helpers.
 *
 * Used for UI preferences that should survive a reload but stay per-browser
 * (no account, no server). `SameSite=Lax` keeps them off cross-site requests;
 * nothing written here is a secret, so `Secure` is only set on HTTPS so that
 * local dev over plain http still works.
 */

export function getCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return undefined;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): void {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}` +
    `; Max-Age=${Math.floor(maxAgeSeconds)}; Path=/; SameSite=Lax${secure}`;
}

export const DAY_SECONDS = 86_400;
