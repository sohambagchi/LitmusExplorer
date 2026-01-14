**System Role:** You are a Senior React Architect specializing in visualization tools and formal verification GUIs.

**Objective:** Scaffold a React application called "LitmusExplorer". The app is a drag-and-drop trace explorer for memory consistency models.

**Tech Stack:**

* React (Typescript)
* Zustand (State Management)
* React Flow (Graph/Canvas visualization)
* Tailwind CSS (Styling)
* Lucide React (Icons)

**Core Requirements:**

**1. The Data Model (`types.ts`)**
Create a robust type system including:

* `MemoryLocation`: `{ name: string, type: 'int' | 'struct' | 'array', initialValue: any }`
* `OperationType`: `'LOAD' | 'STORE' | 'RMW' | 'FENCE' | 'BRANCH'`
* `MemoryOrder`: `'Relaxed' | 'Acquire' | 'Release' | 'SC'`
* `TraceNode`: Extends React Flow's `Node`. Data includes `threadId`, `sequenceIndex`, `operation` details.
* `RelationEdge`: Extends React Flow's `Edge`. Data includes `relationType` ('rf', 'co', 'fr', 'po').

**2. The State Store (`useStore.ts` - Zustand)**
Create a store that manages:

* `memoryEnv`: List of defined variables (Shared/Locals).
* `threads`: List of active thread IDs.
* `activeBranch`: For handling the "Trace Explorer" view (hiding/showing specific if/else paths).
* **Action:** `validateGraph()`: A function that iterates through all edges. If a `rf` (reads-from) edge connects a Store at Sequence 5 to a Load at Sequence 2, mark that edge as `invalid` (which will visually turn it red).

**3. The Canvas (`EditorCanvas.tsx`)**

* Implement a **React Flow** instance.
* **Swimlanes:** The background should define horizontal stripes for Threads.
* **Grid Snapping:** Nodes must snap to a strict Grid (X-axis = Time/Sequence).
* **Constraint:** A node belonging to Thread 1 *cannot* be dragged vertically into Thread 2's lane. It can only move horizontally (reordering time).
* **Implicit Edges:** Automatically render standard gray lines between nodes in the same thread to represent "Program Order" (`po`).

**4. Custom Components**

* `OperationNode.tsx`: A visual block.
* Change background color based on `MemoryOrder` (e.g., Red for Acquire, Blue for Release).
* Display the instruction text (e.g., `LD x (Acq)`).
* Include Handles for connecting relations.


* `BranchNode.tsx`: A diamond shape. Features a "Collapse" button that hides downstream nodes associated with the unchosen path.
* `RelationEdge.tsx`: A custom edge. If `data.invalid` is true, render a jagged red line.

**5. The Sidebar Panel**

* **Memory Definition:** A form to add new shared variables (e.g., `int x = 0;`).
* **Toolbox:** Draggable items for Load, Store, Fence, CAS, Branch.
* **Properties Panel:** When a node is selected, show a form to edit its Address, Value, and Memory Order.

**Implementation Step:**
Please generate the **file structure** and the code for:

1. `types.ts`
2. `useStore.ts` (with the mock validation logic)
3. `OperationNode.tsx` (The visual component)
4. `EditorCanvas.tsx` (The main setup with the drag constraints)

**Important logic to implement now:**
Ensure the `onNodeDrag` callback in React Flow restricts the Y-position so nodes are "locked" to their assigned Thread Swimlane.
