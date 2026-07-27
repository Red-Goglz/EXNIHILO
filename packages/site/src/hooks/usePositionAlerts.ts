import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";

/** Alerts self-dismiss; without this they only cleared on click and piled up. */
const ALERT_TTL_MS = 10_000;

export interface PositionAlert {
  id: number;
  side: "long" | "short";
  symbol: string;
}

interface PositionAlertContextValue {
  alerts: PositionAlert[];
  addAlert: (side: "long" | "short", symbol: string) => void;
  removeAlert: (id: number) => void;
}

let nextId = 1;

export const PositionAlertContext = createContext<PositionAlertContextValue>({
  alerts: [],
  addAlert: () => {},
  removeAlert: () => {},
});

export function usePositionAlerts() {
  return useContext(PositionAlertContext);
}

export function usePositionAlertState(): PositionAlertContextValue {
  const [alerts, setAlerts] = useState<PositionAlert[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  // Clear any in-flight timers if the provider goes away.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const removeAlert = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const addAlert = useCallback((side: "long" | "short", symbol: string) => {
    const id = nextId++;
    setAlerts((prev) => [...prev, { id, side, symbol }]);
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setAlerts((prev) => prev.filter((a) => a.id !== id));
      }, ALERT_TTL_MS),
    );
  }, []);

  return { alerts, addAlert, removeAlert };
}
