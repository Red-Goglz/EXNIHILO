import { createContext, useContext, useCallback, useState } from "react";

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

  const addAlert = useCallback((side: "long" | "short", symbol: string) => {
    const id = nextId++;
    setAlerts((prev) => [...prev, { id, side, symbol }]);
  }, []);

  const removeAlert = useCallback((id: number) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  return { alerts, addAlert, removeAlert };
}
