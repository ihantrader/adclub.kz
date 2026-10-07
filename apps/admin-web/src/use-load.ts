import { useLoadingGate } from "@adclub/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface Loaded<T> {
  /** The latest answer on screen; `undefined` before the first one. */
  data: T | undefined;
  /** The error of the latest load; the previous data stays (D-069). */
  error: unknown;
  /** The loading indicator of the place (after the delay, at least its minimum). */
  indicator: boolean;
  /** Changes whenever other content takes the place of the shown one. */
  answerKey: string | undefined;
  reload: () => void;
  /** Puts new data on screen without a load (a saved item's answer). */
  replace: (next: T) => void;
}

/**
 * One place of a page that waits for the server (D-069): every answer and
 * error goes through the loading gate of `@adclub/ui` — a quick one at once,
 * a slow one after the indicator was seen, only the latest load counts.
 * `key` names what is loaded (the filters): a new key loads again.
 */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const gate = useLoadingGate();
  const { begin, settle } = gate;
  const loader = useRef(load);
  useLayoutEffect(() => {
    loader.current = load;
  });
  const [state, setState] = useState<{ data?: T; error?: unknown; answerKey?: string }>({});

  const reload = useCallback(() => {
    const ticket = begin();
    loader.current().then(
      (data) => settle(ticket, () => setState({ data, error: undefined, answerKey: key })),
      (error: unknown) => settle(ticket, () => setState((now) => ({ ...now, error }))),
    );
  }, [begin, settle, key]);

  useEffect(() => {
    reload();
  }, [reload]);

  return {
    data: state.data,
    error: state.error,
    indicator: gate.indicator,
    answerKey: state.answerKey,
    reload,
    replace: (next) => setState((now) => ({ ...now, data: next, error: undefined })),
  };
}
