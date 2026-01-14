import { useEffect, useRef } from "react";
import EditorCanvas from "./components/EditorCanvas";
import Sidebar from "./components/Sidebar";
import { useStore } from "./store/useStore";
import type { RelationEdge, TraceNode } from "./types";

const LANE_HEIGHT = 120;
const LANE_PADDING = 30;
const GRID_X = 80;

const laneY = (index: number) => index * LANE_HEIGHT + LANE_PADDING;

const seedNodes: TraceNode[] = [
  {
    id: "n1",
    type: "operation",
    position: { x: GRID_X * 1, y: laneY(0) },
    data: {
      threadId: "T1",
      sequenceIndex: 1,
      operation: {
        type: "LOAD",
        address: "x",
        memoryOrder: "Acquire",
      },
    },
  },
  {
    id: "n2",
    type: "branch",
    position: { x: GRID_X * 2, y: laneY(0) },
    data: {
      threadId: "T1",
      sequenceIndex: 2,
      operation: {
        type: "BRANCH",
        text: "if r0",
      },
    },
  },
  {
    id: "n3",
    type: "operation",
    position: { x: GRID_X * 3, y: laneY(0) },
    data: {
      threadId: "T1",
      sequenceIndex: 3,
      branchId: "n2",
      branchPath: "then",
      operation: {
        type: "STORE",
        address: "x",
        value: "1",
        memoryOrder: "Release",
      },
    },
  },
  {
    id: "n4",
    type: "operation",
    position: { x: GRID_X * 4, y: laneY(0) },
    data: {
      threadId: "T1",
      sequenceIndex: 4,
      branchId: "n2",
      branchPath: "else",
      operation: {
        type: "STORE",
        address: "x",
        value: "2",
        memoryOrder: "Release",
      },
    },
  },
  {
    id: "n5",
    type: "operation",
    position: { x: GRID_X * 1, y: laneY(1) },
    data: {
      threadId: "T2",
      sequenceIndex: 1,
      operation: {
        type: "LOAD",
        address: "x",
        memoryOrder: "Relaxed",
      },
    },
  },
  {
    id: "n6",
    type: "operation",
    position: { x: GRID_X * 2, y: laneY(1) },
    data: {
      threadId: "T2",
      sequenceIndex: 2,
      operation: {
        type: "FENCE",
        memoryOrder: "SC",
      },
    },
  },
  {
    id: "n7",
    type: "operation",
    position: { x: GRID_X * 3, y: laneY(1) },
    data: {
      threadId: "T2",
      sequenceIndex: 3,
      operation: {
        type: "STORE",
        address: "y",
        value: "1",
        memoryOrder: "Release",
      },
    },
  },
];

const seedEdges: RelationEdge[] = [
  {
    id: "e1",
    type: "relation",
    source: "n3",
    target: "n5",
    data: { relationType: "rf" },
  },
  {
    id: "e2",
    type: "relation",
    source: "n7",
    target: "n1",
    data: { relationType: "rf" },
  },
];

const App = () => {
  const nodes = useStore((state) => state.nodes);
  const setNodes = useStore((state) => state.setNodes);
  const setEdges = useStore((state) => state.setEdges);
  const setThreads = useStore((state) => state.setThreads);
  const validateGraph = useStore((state) => state.validateGraph);
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current || nodes.length > 0) {
      return;
    }

    seeded.current = true;
    // Seed the initial example once on first load.
    setThreads(["T1", "T2"]);
    setNodes(seedNodes);
    setEdges(seedEdges);
  }, [nodes.length, setEdges, setNodes, setThreads]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 text-slate-900">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <div>
            <div className="text-sm font-semibold tracking-wide">
              Litmus Explorer
            </div>
            <div className="text-xs text-slate-500">
              Drag operations, connect relations, and collapse branches.
            </div>
          </div>
          <button
            type="button"
            className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            onClick={validateGraph}
          >
            Validate Graph
          </button>
        </header>
        <main className="flex-1">
          <EditorCanvas />
        </main>
      </div>
    </div>
  );
};

export default App;
