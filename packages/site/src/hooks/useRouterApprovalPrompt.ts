import { useEffect, useSyncExternalStore } from "react";
import { getCookie, setCookie, DAY_SECONDS } from "../lib/cookies.ts";

/**
 * Tracks whether any trade surface is currently about to show a per-trade
 * "Approve USDC" button, so the router pre-approval modal can offer the
 * one-click alternative from any page instead of only the feed.
 *
 * Held in a module-level store rather than React state: registration happens
 * from an effect, and calling setState there would cascade a render on every
 * keystroke that changes the trade amount. `useSyncExternalStore` is the
 * supported way to read external state without that.
 *
 * Refcounted because more than one panel can be mounted at once (a pool page
 * has trade, swap and LP panels); the prompt clears only when the last one does.
 */

export const SNOOZE_COOKIE = "exnihilo_router_approval_snooze";
export const SNOOZE_DAYS = 30;

let pendingCount = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot() {
  return pendingCount;
}

/** Marks a per-trade approval as being shown. Returns an idempotent release fn. */
function acquire(): () => void {
  pendingCount += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingCount = Math.max(0, pendingCount - 1);
    emit();
  };
}

/** How many trade surfaces currently need a per-trade approval. */
export function usePendingPerTradeApprovals(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Registers with the prompt for as long as `active` stays true.
 * Call from any component that renders a per-trade approve button.
 */
export function useNeedsPerTradeApproval(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return acquire();
  }, [active]);
}

// ── 30-day opt-out ──────────────────────────────────────────────────────────
// A cookie rather than localStorage because it expires on its own: there is no
// stored timestamp to compare against, so a stale value can't outlive its window.

export function isSnoozed(): boolean {
  return getCookie(SNOOZE_COOKIE) === "1";
}

export function snoozeForThirtyDays(): void {
  setCookie(SNOOZE_COOKIE, "1", SNOOZE_DAYS * DAY_SECONDS);
}
