# Repository Guidelines

## Project Structure & Module Organization
`PROMPT.md` defines the intended React/TypeScript application and core modules. Keep code under `src/` with clear subfolders, for example: `src/types.ts`, `src/store/useStore.ts`, `src/components/OperationNode.tsx`, `src/components/EditorCanvas.tsx`, and `src/components/Sidebar/`. Place custom React Flow edges/nodes under `src/edges/` and `src/nodes/`, and static assets under `src/assets/`.

## Build, Test, and Development Commands
Use the scripts defined in `package.json`:
```sh
npm install       # install dependencies
npm run dev       # start local dev server
npm run build     # production build
npm run preview   # preview production build
```
Testing and linting scripts are not configured yet.

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
