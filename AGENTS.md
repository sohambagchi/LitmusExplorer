# Repository Guidelines

## Project Structure & Module Organization
`PROMPT.md` captures the original product scaffold goals; the running implementation lives in `src/`.

Current module layout:
- `src/types.ts`: Domain and snapshot types.
- `src/store/useStore.ts`: Zustand store (nodes, edges, memory, model config).
- `src/components/`: UI components (includes React Flow node/edge components today).
  - `src/components/EditorCanvas.tsx`: React Flow canvas + memory strip + viewport controls.
  - `src/components/Sidebar.tsx`: Session/model tools, toolbox, and properties editor.
  - `src/components/OperationNode.tsx`, `src/components/BranchNode.tsx`: Custom nodes.
  - `src/components/RelationEdge.tsx`: Custom edge renderer.
- `src/session/`: Import/export snapshot parsing/creation.
- `src/share/`: Supabase-backed sharing (see `docs/sharing.md`).
- `src/cat/`: Minimal `.cat` parser to extract relation definitions/types.
- `src/utils/`: Pure helpers (constraints, PNG export, IDs, branch evaluation).

If you introduce many new node/edge types, you may add `src/nodes/` and `src/edges/`, but keep existing imports and structure consistent with the current codebase.

## Build, Test, and Development Commands
Use the scripts defined in `package.json`:
```sh
npm install       # install dependencies
npm run dev       # start local dev server
npm run build     # production build
npm run preview   # preview production build
```
There is no test runner or linter script configured yet. `tests/session-samples/` contains example session JSON fixtures for manual import.

## Tooling Versions
- react: ^18.3.1
- react-dom: ^18.3.1
- reactflow: ^11.11.4
- zustand: ^4.5.5
- vite: ^5.4.0
- typescript: ^5.5.4
- tailwindcss: ^3.4.7

## Coding Style & Naming Conventions
Use TypeScript for all source files. Prefer 2-space indentation and consistent formatting via Prettier once configured; otherwise match existing file style. Component files use `PascalCase.tsx` (e.g., `OperationNode.tsx`), hooks use `useX.ts` (e.g., `useStore.ts`), and shared types live in `types.ts`. Keep Tailwind class lists ordered for readability, and use descriptive prop names aligned with the domain (e.g., `memoryOrder`, `threadId`).

## Testing Guidelines
Testing is not configured yet. When adding tests, standardize on a framework (e.g., Vitest + React Testing Library) and store tests alongside code as `*.test.tsx` or in `src/**/__tests__/`. Document any coverage thresholds in `package.json` and update this guide.

## Commit & Pull Request Guidelines
There is no Git history in this repository yet. Until a convention is established, use concise, imperative commit messages such as `feat: add RelationEdge render` or `chore: scaffold store`. For pull requests, include a short summary, link related issues, and add screenshots or short clips for UI changes.

## Agent Notes
Treat `PROMPT.md` as the authoritative product spec. Use the Context7 MCP to pull up-to-date documentation when referencing library APIs. If you add or reorganize modules, update this guide to reflect the actual structure and commands.
