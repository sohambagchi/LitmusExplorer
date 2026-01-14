# Litmus Explorer AI Agent Guide

This guide is a deep-dive reference for AI agents working in this repository.
It explains the architecture, codebase structure, key components, data models,
interaction patterns, and how to extend and test the app safely.

If you are an agent, read this doc along with `AGENTS.md` and `PROMPT.md` before
making changes.

## Purpose and Product Overview
Litmus Explorer is a React + React Flow prototype for visualizing litmus tests.
The UI lets users:
- Lay out operations along thread lanes.
- Connect relation edges between operations.
- Define memory variables in top-of-canvas Memory sections.
- Group variables into structs to express address dependencies.
- Validate simple edge constraints (currently read-from ordering).

Conceptually:
- Memory is the "state".
- Operations (nodes) express state changes.
- Relations (edges) connect operations (across or within threads).

## Quick Start (Developer)
```sh
npm install
npm run dev
```
Vite serves the app; entry point is `index.html` -> `src/main.tsx`.

## Repository Map (High Level)
- `index.html`: Vite entry shell.
- `src/main.tsx`: React root + StrictMode.
- `src/App.tsx`: Top-level layout and seed data.
- `src/components/EditorCanvas.tsx`: React Flow canvas + Memory UI strip.
- `src/components/Sidebar.tsx`: Toolbox, Memory definition palette, relation type selector, and Properties editor.
- `src/components/OperationNode.tsx`: Operation node UI.
- `src/components/BranchNode.tsx`: Branch node UI.
- `src/components/RelationEdge.tsx`: Custom edge rendering.
- `src/store/useStore.ts`: Zustand store and all app state/actions.
- `src/types.ts`: Domain types.
- `src/index.css`: Tailwind layers and global CSS.
- `vite.config.ts`: Vite + React plugin.
- `tailwind.config.cjs` and `postcss.config.cjs`: styling pipeline.

## Architecture Overview
The app is intentionally small and is organized around three layers:

1) Domain Types (static definitions)
   - `src/types.ts` defines memory, nodes, edges, and operation shapes.
   - These types should remain stable and descriptive; new features should
     extend types rather than bypass them.

2) State Management (Zustand store)
   - `src/store/useStore.ts` is the single source of truth for app state.
   - State includes nodes, edges, memory, active branch, threads, and UI
     selection for memory grouping.
   - Store actions handle all mutations so UI remains dumb and predictable.

3) UI and Interactions (React components)
   - `EditorCanvas` renders React Flow and the Memory strip.
   - `Sidebar` provides tools for creating nodes/edges and editing properties.
   - Node and edge components encapsulate visuals for different types.

This separation keeps React Flow-specific logic localized in `EditorCanvas` and
keeps state mutations centralized in the store.

## Data Model Deep Dive

### Memory Variables (`MemoryVariable`)
Defined in `src/types.ts`:
- `id`: Unique ID string.
- `name`: User-facing name.
- `type`: `"int" | "array" | "struct"`.
- `scope`: `"constants" | "locals" | "shared"`.
- `value`: Optional literal string.
- `parentId`: For struct membership; child variables point to struct `id`.

Structs are modeled as a memory variable with `type: "struct"` and child
variables referencing it via `parentId`. This is important for address
dependency tracking and for addressing in operations.

### Operations (`Operation`)
Each node holds an operation:
- `type`: `"LOAD" | "STORE" | "RMW" | "FENCE" | "BRANCH"`.
- `addressId` and `valueId`: Memory variable references (preferred).
- `address` and `value`: Legacy inline fields (kept for compatibility).
- `memoryOrder`: `"Relaxed" | "Acquire" | "Release" | "SC"`.

UI prefers memory references. When `addressId` or `valueId` are set, inline
fields are cleared by the editor so only one data path is active.

### Graph Nodes (`TraceNode`)
React Flow node with `TraceNodeData`:
- `threadId`: Lane identifier (e.g., `T1`, `T2`).
- `sequenceIndex`: Derived from x-position; used for ordering.
- `branchId` and `branchPath`: Optional for branch collapsing.

Nodes are placed on discrete y-lanes. Dropping or dragging a node reassigns
`threadId` based on its lane.

### Relation Edges (`RelationEdge`)
React Flow edge with `RelationEdgeData`:
- `relationType`: `"rf" | "co" | "fr" | "po"`.
- `invalid`: Optional flag used to render jagged edges.

Edges are created by user connection gestures and inherit the relation type
selected in the sidebar. There is no automatic `po` edge generation in the
current implementation.

## Component Deep Dive

### `App.tsx`
- Seeds an initial example graph the first time the app loads.
- Hosts the main layout: sidebar + canvas.

### `EditorCanvas.tsx`
Responsibilities:
- React Flow configuration (nodeTypes, edgeTypes, handlers).
- Memory strip UI (Constants/Locals/Shared drop zones).
- Drag/drop for nodes and memory variables.
- Snap-to-grid and lane locking behavior.

Key behaviors:
- Y-axis is discrete; lane selection maps to thread IDs.
- X-axis controls `sequenceIndex` on drop and drag-stop.
- Horizontal-only panning via React Flow props.
- Grid overlay indicates sequence slots.

Extension points:
- Add new node/edge types to `nodeTypes` or `edgeTypes`.
- Add new memory scopes or change the Memory layout.
- Add custom background overlays or lane labels.

### `Sidebar.tsx`
Responsibilities:
- Session actions (New/Export).
- Memory palette (draggable `int`, `array`) and Struct grouping.
- Relation type selector for new edges.
- Toolbox items for creating nodes.
- Properties editor for selected nodes.

Important details:
- Struct grouping is enabled only when 2+ items in the same scope are selected.
- Properties editor uses memory variable references, not raw strings.

### `OperationNode.tsx`
Responsibilities:
- Render compact operation labels and metadata.
- Resolve memory labels from `addressId`/`valueId`.

If you change memory labeling rules, update the formatter here.

### `BranchNode.tsx`
Responsibilities:
- Compact diamond-shaped branch node.
- Allows selecting `then`/`else` path and collapsing visibility.

### `RelationEdge.tsx`
Responsibilities:
- Render relation edges with straight or jagged paths.
- Color by relation type; jagged lines for invalid edges.

## Interaction Model

### Thread Lanes
Thread lanes are vertical bands determined by y-position.
Rules:
- Nodes are forced to a lane on drag and on drag-stop.
- `threadId` is assigned based on the lane index.
- Lane count is driven by `threads` in the store.

### Sequence Indexing
Sequence order is derived from x-position:
- `sequenceIndex = round(x / GRID_X)`.
- Nodes snap to grid on drag-stop.
- Grid lines are rendered at `GRID_X` intervals.

### Memory Drag & Drop
Memory items are dragged from the sidebar and dropped into Memory sections.
On drop:
- A new `MemoryVariable` is created with scope = drop zone.
- Name and value are editable inline in the Memory strip.

### Struct Grouping
Struct grouping:
- Select 2+ memory items (checkboxes).
- Click `Struct` to create a parent struct.
- Selected items get `parentId` set to the struct ID.

This grouping does not change node data directly, but provides a stronger
addressing scheme (e.g., `struct.member`).

### Edge Creation
Edges are created with a user gesture (connect source -> target).
The selected relation type in the sidebar is applied to the new edge.

## How to Add Features

### Add a New Operation Type
1) Update `OperationType` in `src/types.ts`.
2) Extend `opLabels` in `src/components/OperationNode.tsx`.
3) Add a toolbox item in `src/components/Sidebar.tsx`.
4) Update any seed data in `src/App.tsx` if needed.
5) Consider how validation should handle the new type.

### Add a New Relation Type
1) Update `RelationType` in `src/types.ts`.
2) Add color mapping in `src/components/RelationEdge.tsx`.
3) Add the option to the Relations selector in `src/components/Sidebar.tsx`.
4) Update validation rules in `src/store/useStore.ts` if needed.

### Add a New Memory Scope
1) Update `MemoryScope` in `src/types.ts`.
2) Add a section in `MEMORY_SECTIONS` in `src/components/EditorCanvas.tsx`.
3) Add any related UI text in `src/components/Sidebar.tsx`.

### Add a New Node Type (Custom React Flow Node)
1) Create a node component in `src/components/` or `src/nodes/`.
2) Add the type to `nodeTypes` in `EditorCanvas`.
3) Update the type on node creation and in any seeds.
4) Ensure handles exist for edges if the node is connectable.

### Add Edge Editing (Type or Metadata)
Recommended approach:
- Use React Flow edge selection events.
- Store `selectedEdgeId` in the store.
- Add an Edge Properties section in the sidebar.
- Update the edge data via `setEdges` with immutable updates.

## Testing Strategy (Not Configured Yet)
No test runner is installed yet. If you add tests, keep them lightweight and
close to features that change frequently.

### Suggested Stack
- Vitest + React Testing Library for unit and component tests.
- Playwright for end-to-end flows (optional).

### What to Test
1) Store logic
   - Grouping into structs.
   - Relation validation logic.
   - Session reset/export states.

2) Component logic
   - Memory label rendering with and without `parentId`.
   - Operation node label formatting.
   - Sidebar selection to action wiring.

3) Interaction tests (if using e2e)
   - Drag memory item into a scope; verify it appears.
   - Drag nodes and assert lane snapping.
   - Create an edge and verify relation type.

### Example Test Ideas (Pseudo)
```ts
// Store grouping: selected items with same scope should form struct
expect(store.getState().memoryEnv).toHaveLength(3);
store.getState().groupSelectedIntoStruct();
expect(store.getState().memoryEnv.find((m) => m.type === "struct")).toBeTruthy();
```

```tsx
// OperationNode label formatting
render(<OperationNode data={...} />);
expect(screen.getByText(/LD x/)).toBeInTheDocument();
```

## Debugging and Troubleshooting

Common issues:
- "I cannot connect edges":
  - Ensure node handles exist and are not covered by overlays.
  - Check React Flow props for `nodesConnectable`.

- "Nodes jump to wrong thread":
  - Verify `threads` array and `LANE_HEIGHT` math.
  - Ensure `getLaneIndexFromY` uses the same `LANE_PADDING`.

- "Memory dropdowns show empty":
  - Ensure memory variables have names (empty names are filtered).
  - Confirm `formatMemoryLabel` logic and memory IDs.

## Style and UX Guidelines
- Keep node visuals compact; dense views are expected.
- Avoid excessive animations; keep interactions snappy.
- Use clear, readable labels; prefer abbreviations for dense displays.

## Performance Considerations
React Flow can handle many nodes, but it’s easy to slow down:
- Keep render logic memoized (as in `useMemo` for node/edge lists).
- Avoid creating new functions inside render when possible.
- Keep store updates minimal and targeted.

## Security and Data Handling
All data is local; export produces a JSON download.
If you add persistence or backends:
- Validate input to avoid malformed graphs.
- Serialize only necessary fields to avoid privacy leaks.

## Contribution Checklist (For Agents)
Before submitting changes:
- Verify new types are in `src/types.ts`.
- Ensure store actions cover state changes.
- Keep UI interactions in `EditorCanvas` and `Sidebar`.
- Update README or docs if a new feature is user-facing.
- Use Context7 MCP for up-to-date API references.

## Future Extension Ideas
- Edge editing panel with labels and metadata.
- Per-thread timeline scaling or lane resizing.
- Import session JSON.
- Derived relations (automatic PO edges) as a toggle.
- Constraint validation with richer error details.

