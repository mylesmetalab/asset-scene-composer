import { createRoot } from "react-dom/client";
import { useEffect, useRef } from "react";
import { mount, type ShellHandle } from "@mylesmetalab/shell";
import { voxelSceneTool } from "./tool";

function App() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    let handle: ShellHandle | null = null;
    handle = mount(voxelSceneTool, ref.current);
    return () => handle?.unmount();
  }, []);
  return <div ref={ref} style={{ width: "100%", height: "100vh" }} />;
}

const container = document.getElementById("root")!;
const g = window as unknown as { __voxelRoot?: ReturnType<typeof createRoot> };
const root = g.__voxelRoot ?? (g.__voxelRoot = createRoot(container));
root.render(<App />);
