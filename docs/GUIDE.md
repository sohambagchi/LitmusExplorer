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
- Connect operations with relation edges (created as `po`, then re-typed in the sidebar).
- Define memory variables in the Memory strip (Constants / Local Registers / Shared).
- Group memory variables into structs for qualified names (e.g. `s.x`).
- Validate edges against basic constraints (same-thread rules, same-location rules).
- Export/import sessions (JSON), export the graph as PNG, and optionally share sessions.

Conceptually:
- Memory is the "state".
- Operations (nodes) express actions on memory.
- Relations (edges) connect operations within/across threads.

## Quick Start (Developer)
```sh
npm install
npm run dev
```

Vite serves the app; entry point is `index.html` -> `src/main.tsx`.

## Repository Map (High Level)
- `index.html`: Vite entry shell.
- `src/main.tsx`: React root + StrictMode.
- `src/App.tsx`: Layout, demo seeding, Share flow, Validate button.
- `src/components/EditorCanvas.tsx`: React Flow canvas + Memory strip + viewport controls.
- `src/components/Sidebar.tsx`: Session/model tools, toolbox, memory palette, properties editor.
- `src/components/OperationNode.tsx`, `src/components/BranchNode.tsx`: Custom nodes.
- `src/components/RelationEdge.tsx`: Custom edge renderer + labels.
- `src/store/useStore.ts`: Zustand store (nodes, edges, memory, threads, model config).
- `src/session/`: Session snapshot creation/parsing.
- `src/share/`: Supabase sharing helpers.
- `src/cat/`: Minimal `.cat` parser to extract relation definitions/types.
- `src/utils/`: Constraints, branch evaluation, PNG export, IDs.
- `src/types.ts`: Domain + snapshot types.
- `tests/session-samples/`: Example session JSON files for manual import.
- `docs/sharing.md`: Supabase table + env vars + SPA routing notes.
- `vercel.json`: SPA rewrite rule (so `/<uuid>` routes load the app).

## Architecture Overview
The app is organized around three layers:

1) Domain Types
   - `src/types.ts` defines memory, nodes, edges, operations, and session snapshots.

2) State Management (Zustand)
   - `src/store/useStore.ts` is the single source of truth for app state.
   - It also owns validation (`validateGraph`) and `.cat`-driven model metadata.

3) UI / Interactions (React + React Flow)
   - `EditorCanvas` renders the graph and Memory strip.
   - `Sidebar` manages sessions/models and edits selected node/edge properties.

## Data Model Deep Dive

### Memory Variables (`MemoryVariable`)
Defined in `src/types.ts`:
- `id`: Unique ID string.
- `name`: User-facing name.
- `type`: `"int" | "array" | "ptr" | "struct"`.
- `scope`: `"constants" | "locals" | "shared"`.
- `value`: Optional literal string (for `int`).
- `size`: Optional numeric size (for `array`).
- `pointsToId`: Target variable id (for `ptr`, including structs).
- `parentId`: For struct membership; child variables point to struct `id`.

Default memory:
- The store seeds a `NULL` constant (`id: "const-null"`, value `"0"`).

Structs are represented as a `type: "struct"` variable plus children that point to it
via `parentId`. Formatting uses `parent.name + "." + child.name` (or IDs as fallback).

### Operations (`Operation`)
Each node has an `operation` object (in `TraceNodeData`):
- `type`: `"LOAD" | "STORE" | "RMW" | "FENCE" | "BRANCH"`.
- ID-based references (preferred):
  - `addressId`: Accessed location.
  - `indexId`: Optional index variable for array accesses.
  - `resultId`: Destination variable for `LOAD`.
  - `valueId`: Source variable for `STORE` (or use legacy `value`).
  - `expectedValueId` / `desiredValueId`: CAS-style inputs for `RMW`.
- Legacy inline fields (kept for compatibility with older snapshots/seeds):
  - `address`, `index`, `value`.
- Memory order fields are strings:
  - `memoryOrder` for `LOAD`/`STORE`/`FENCE`.
  - `successMemoryOrder` / `failureMemoryOrder` for `RMW`.
  - Defaults come from `DEFAULT_MEMORY_ORDERS` in `src/types.ts` (includes `Standard`, `Acq_Rel`, etc.).
- Branching:
  - `branchCondition` is a tree of comparison rules combined by `&&`/`||`.
  - `branchShowBothFutures` controls whether the non-taken branch is hidden.

### Graph Nodes (`TraceNode`)
React Flow node with `TraceNodeData`:
- `threadId`: Lane identifier (e.g., `T0`, `T1`).
- `sequenceIndex`: Derived from x-position (`round(x / GRID_X)`, clamped to `>= 1`).

Nodes are lane-snapped while dragging and are normalized on drag-stop:
- Y is snapped to the lane center.
- X is snapped to `sequenceIndex * GRID_X`.
- If you drop/drag into the dashed “next thread” lane, a new thread is created.

### Relation Edges (`RelationEdge`)
React Flow edge with `RelationEdgeData`:
- `relationType`: A string. Defaults are `DEFAULT_RELATION_TYPES` (`rf`, `co`, `fr`, `po`, `ad`, `cd`, `dd`).
- `invalid`: When true, `RelationEdge` renders a jagged red path.
- `generated`: Used for derived, non-interactive edges.

Edge creation/editing:
- New edges created via connect gesture start as `relationType: "po"`.
- To set `rf`/`co`/`fr`/etc., select the edge and update `relationType` in the Sidebar.

Derived dependency edges:
- `EditorCanvas` derives `ad`/`cd`/`dd` edges within each thread by analyzing node fields and renders them as non-interactive “bands” (`generated: true`).
- Derived edges are not labeled and are excluded from edge property editing.

### Sessions (Export / Import / Share)
- Export uses `src/session/createSessionSnapshot.ts`.
- Import validates and normalizes using `src/session/parseSessionSnapshot.ts`.
- `tests/session-samples/` includes example snapshots for manual import.

Optional sharing:
- `Share` stores a snapshot in Supabase under a generated UUID and shows a link.
- See `docs/sharing.md` for table schema and required `VITE_SUPABASE_*` env vars.
- `vercel.json` includes an SPA rewrite so `/<uuid>` routes load the app.

### Model Configuration and `.cat` Files
The store maintains:
- `modelConfig.relationTypes`: The allowed relation names shown in the edge dropdown.
- `modelConfig.memoryOrders`: The allowed memory orders shown in node dropdowns.

Uploading `.cat` files in the Sidebar:
- Parses files locally (no automatic fetching of `include` dependencies).
- Extracts non-macro `let name = ...` definitions and appends those names to `modelConfig.relationTypes`.
- Shows warnings for missing include files and unresolved identifiers.
- Allows viewing extracted definitions in a dialog.

## Validation Rules (Current)
Validation is always run when the user clicks `Validate Graph`. It is also triggered
by some edits (edge creation, edge type changes, and operation property edits), but
lane/sequence drag operations may require a manual validate to refresh `invalid` flags.

1) Structural constraints (`src/utils/edgeConstraints.ts`)
   - `po`, `ad`, `cd`, `dd` must stay within a single thread.
   - `rf`, `co`, `fr` across threads require both endpoints to resolve to the same memory location label (supports structs and array indices).

2) Simple `rf` ordering constraint (`src/store/useStore.ts`)
   - If `rf` connects a `STORE` to a `LOAD` within the same thread and the store’s `sequenceIndex` is greater than the load’s, the edge is marked invalid.

## Component Notes

### `App.tsx`
- Seeds a demo graph on first load (unless `/<uuid>` is present).
- Header provides `Share` and `Validate Graph`.
- `/<uuid>` loads a shared snapshot from Supabase (if configured).

### `EditorCanvas.tsx`
- Memory strip at the top:
  - Constants and Shared accept drops from the Sidebar’s memory palette.
  - Local Registers are created with the `+` button.
- Canvas behavior:
  - Nodes snap to lanes and sequence grid.
  - Mouse wheel pans horizontally; hold Shift to scroll vertically (or use the scrollbar).
  - `Labels` cycles edge label modes (`all` / `nonPo` / `off`).
  - `Export PNG` exports the current graph viewport (based on node bounds).
  - `Locked` disables node dragging and new connections.

### `Sidebar.tsx`
- Session: new session, export snapshot JSON, import snapshot JSON.
- Model: upload `.cat` files, view extracted definitions, reset model config.
- Memory palette: drag `int` / `array` / `ptr` to Constants/Shared; group selected items into a struct.
- Properties:
  - If an edge is selected, edit its `relationType` (from `modelConfig.relationTypes`) or delete it.
  - If a node is selected, edit operation fields using ID-based memory references.

## Branches (How Collapse Works Today)
Branch nodes:
- Evaluate a `branchCondition` against current memory values (`int.value`, `array.size`, and `ptr.pointsToId` for `==`/`!=`).
- Offer two outgoing handles (`then`, `else`) and a `Both` toggle.

Visibility logic (in `EditorCanvas`):
- If a branch node is set to hide one future, the canvas builds a set of nodes reachable from:
  - edges from the branch’s `then` handle and `else` handle, plus
  - downstream reachability following `po` edges.
- The non-taken future’s exclusive nodes are hidden.

This means branch collapsing is driven primarily by edge connectivity (not by pre-tagging nodes with `branchId`/`branchPath`), although those fields may appear in older snapshots.

## How to Add Features (Guidance)

### Add a New Operation Type
1) Update `OperationType` and the `Operation` shape in `src/types.ts`.
2) Extend rendering in `src/components/OperationNode.tsx`.
3) Add toolbox + property editing in `src/components/Sidebar.tsx`.
4) Update seed data (optional) in `src/App.tsx`.
5) Decide whether derived dependencies or constraints should consider it (EditorCanvas/store).

### Add a New Relation Type
1) Add it to `DEFAULT_RELATION_TYPES` in `src/types.ts`, or supply it via `.cat` upload.
2) If you want a specific color, extend `coreRelationColors` in `src/components/RelationEdge.tsx`.
3) Update constraints in `src/utils/edgeConstraints.ts` if the relation has special rules.

### Add a New Memory Scope
1) Update `MemoryScope` in `src/types.ts`.
2) Add a section in `MEMORY_SECTIONS` in `src/components/EditorCanvas.tsx`.
3) Decide how it should behave in the Sidebar’s dropdown filtering.

## Testing Strategy (Not Configured Yet)
No test runner is installed yet. If you add tests, keep them lightweight and close to frequently-changed logic (store validation, snapshot parsing, edge constraints).

## Debugging and Troubleshooting
- "I cannot connect edges":
  - Ensure the canvas isn’t `Locked`.
  - Ensure nodes have visible handles (and aren’t covered by overlays).
- "Edges show as invalid unexpectedly":
  - Check `relationType` constraints (same-thread vs same-location requirements).
  - Verify node address resolution (IDs vs legacy `address`/`index` fields).
- "Shared session won’t load":
  - Verify `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` and your `litmus_shares` table.
  - Ensure your host serves `index.html` for `/<uuid>` routes (see `vercel.json` / `docs/sharing.md`).

## Security and Data Handling
By default, all data is local (snapshots download as JSON).
Sharing is optional and uses Supabase with an anon key; snapshots are stored as JSON and should be treated as user data.
