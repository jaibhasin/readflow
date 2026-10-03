import { cpSync, mkdirSync } from "node:fs";
import { build, defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist",
    rollupOptions: {
      input: {
        background: "extension/background.ts",
        diagnostics: "extension/diagnostics.html",
        readingList: "extension/reading-list.html",
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
  plugins: [
    {
      name: "copy-extension-manifest",
      async closeBundle() {
        // Chrome content scripts are classic scripts and cannot import shared chunks.
        await build({
          configFile: false,
          build: {
            emptyOutDir: false,
            outDir: "dist",
            lib: { entry: "extension/content.ts", name: "Readflow", formats: ["iife"], fileName: () => "content.js" },
          },
        });
        mkdirSync("dist", { recursive: true });
        cpSync("extension/manifest.json", "dist/manifest.json");
        cpSync("extension/highlight.css", "dist/highlight.css");
        cpSync("extension/SOUNDTOUCH-LICENSE.txt", "dist/SOUNDTOUCH-LICENSE.txt");
        cpSync("extension/THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md");
      },
    },
  ],
});
