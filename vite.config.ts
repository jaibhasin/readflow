import { cpSync, mkdirSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist",
    rollupOptions: {
      input: {
        background: "extension/background.ts",
        content: "extension/content.ts",
        diagnostics: "extension/diagnostics.html",
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
  plugins: [
    {
      name: "copy-extension-manifest",
      closeBundle() {
        mkdirSync("dist", { recursive: true });
        cpSync("extension/manifest.json", "dist/manifest.json");
        cpSync("extension/highlight.css", "dist/highlight.css");
        cpSync("extension/SOUNDTOUCH-LICENSE.txt", "dist/SOUNDTOUCH-LICENSE.txt");
        cpSync("extension/THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md");
      },
    },
  ],
});
