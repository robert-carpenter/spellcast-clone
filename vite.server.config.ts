import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node18",
    ssr: "src/server/server.ts",
    outDir: "dist/server",
    emptyOutDir: false,
    rollupOptions: {
      input: "src/server/server.ts",
      external: [
        "cors",
        "express",
        "socket.io",
        "uuid",
        "http",
        "fs",
        "path",
        "url",
        "crypto"
      ],
      output: {
        format: "esm",
        entryFileNames: "index.mjs"
      }
    }
  },
  ssr: {
    external: ["cors", "express", "socket.io", "uuid"]
  }
});
