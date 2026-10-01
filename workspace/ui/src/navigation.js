import { useLayoutEffect, useRef, useState } from "react";

// Local navigation also works in opaque/sandboxed MCP frames without URL access.
// Only the active screen participates in layout; the dashboard keeps its state.
export function useWorkspaceNavigation() {
  const [frames, setFrames] = useState([
    { view: { kind: "dashboard" }, key: 0 },
  ]);
  const sequence = useRef(0);
  const pending = useRef(null);
  const current = frames.at(-1);
  const remember = () => ({
    ...current,
    scroll: window.scrollY,
    focus: document.activeElement,
  });
  const navigate = (view) => {
    pending.current = { scroll: 0 };
    setFrames([
      ...frames.slice(0, -1),
      remember(),
      { view, key: ++sequence.current },
    ]);
  };
  const back = () => {
    if (frames.length < 2) return;
    pending.current = frames.at(-2);
    setFrames(frames.slice(0, -1));
  };
  const home = () => {
    pending.current = frames[0];
    setFrames([frames[0]]);
  };
  useLayoutEffect(() => {
    const target = pending.current;
    if (!target) return;
    pending.current = null;
    const focus =
      target.focus?.isConnected && !target.focus.closest("[hidden]")
        ? target.focus
        : document.querySelector(
            ".screen-view:not([hidden]) [data-screen-focus]",
          );
    focus?.focus({ preventScroll: true });
    window.scrollTo({ top: target.scroll ?? 0, behavior: "instant" });
  }, [current.key]);
  return { view: current.view, key: current.key, navigate, back, home };
}
