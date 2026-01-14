# Litmus Explorer

Litmus Explorer is a React + React Flow prototype for visualizing litmus tests.
It lets you lay out operations across thread lanes, connect relations, and
validate simple read-from constraints.

## Features
- Drag operations from the toolbox onto thread lanes.
- Connect nodes to define relation edges.
- Collapse or expand branch paths.
- Validate read-from edges against sequence order.

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
- Drag nodes horizontally to change sequence order; vertical movement snaps to a
  thread lane.
- Use the Properties panel to edit address/value/memory-order metadata.
- Click "Validate Graph" to flag invalid read-from edges.

## Tech Stack
- React 18, React DOM 18
- React Flow 11
- Zustand 4
- Vite 5 + TypeScript 5
- Tailwind CSS 3

## Project Structure
- `index.html` app shell and Vite entry.
- `src/main.tsx` React entry point.
- `src/App.tsx` top-level layout + seeded demo graph.
- `src/components/` UI building blocks, nodes, edges.
- `src/store/useStore.ts` Zustand state and graph validation.
- `src/types.ts` shared domain types.

## Testing
No test runner is configured yet.
