# Litmus Explorer

Litmus Explorer is a React + React Flow prototype for visualizing litmus tests.
It lets you lay out operations across thread lanes, connect relation edges, and
validate basic consistency/typing constraints on those edges.

## Features
- Drag operations from the toolbox onto thread lanes.
- Connect nodes to create `po` (program-order) edges, then select an edge to set its `relationType` (e.g. `rf`, `co`, `fr`, custom).
- Branch nodes expose `then`/`else` handles and can hide the non-taken future (or show both).
- Validate edges (same-thread requirements, same-location requirements for `rf`/`co`/`fr`, and simple `rf` ordering).
- Import herdtools-style `.litmus` tests, import/export session snapshots (JSON), export canvas as PNG.
- Optional: share sessions via Supabase (`docs/sharing.md`).
- Optional: upload `.cat` files to extract relation names/definitions for the edge type dropdown.

## Getting Started
```sh
npm install
npm run dev
```

Open the dev server URL printed by Vite.

## Scripts
- `npm run dev` start the Vite dev server.
- `npm run build` build the app for production.
- `npm run preview` preview the production build.

## Usage Notes
- Drag nodes horizontally to change `sequenceIndex`; vertical movement snaps to a lane. Drag into the dashed “next thread” lane (or click `+ Thread`) to add a thread.
- Use the Properties panel to edit node fields, and to change the `relationType` of a selected edge.
- `ad`/`cd`/`dd` dependency edges are derived automatically from node data and render as non-interactive bands.
- Use `Labels` to toggle edge label rendering; `Export PNG` exports the current graph viewport.
- `Share` generates a UUID link (requires Supabase config; see `docs/sharing.md`).

## Tech Stack
- React 18, React DOM 18
- React Flow 11
- Zustand 4
- Vite 5 + TypeScript 5
- Tailwind CSS 3

## Project Structure
- `index.html` app shell and Vite entry.
- `src/main.tsx` React entry point.
- `src/App.tsx` top-level layout, seeded demo graph, and Share/Validate controls.
- `src/components/` UI building blocks, React Flow nodes/edges, canvas, sidebar.
- `src/store/useStore.ts` Zustand state and edge validation.
- `src/session/` session snapshot creation/parsing.
- `src/share/` Supabase sharing client.
- `src/cat/` `.cat` file parser for relation definitions.
- `src/types.ts` shared domain types.

## Testing
No test runner is configured yet. `tests/session-samples/` contains example session JSON files for manual import.
