export type CatAssetFixture = {
  name: string;
  text: string;
};

/**
 * Bundled LKMM `.cat` files shipped with the app.
 *
 * These are loaded via Vite's `import.meta.glob` so the UI can populate the model config
 * without requiring users to manually hunt down the LKMM spec files.
 */
export const LKMM_CAT_FIXTURES: CatAssetFixture[] = (() => {
  const modules = import.meta.glob<string>("../../assets/cat/lkmm/*.cat", {
    eager: true,
    query: "?raw",
    import: "default",
  });

  const fixtures: CatAssetFixture[] = [];

  for (const [path, text] of Object.entries(modules)) {
    const fileName = path.split("/").pop() ?? path;
    fixtures.push({ name: fileName, text });
  }

  fixtures.sort((a, b) => a.name.localeCompare(b.name));
  return fixtures;
})();

