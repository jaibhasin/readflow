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
      },
    },
  ],
});
