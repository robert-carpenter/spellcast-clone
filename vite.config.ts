import { defineConfig } from "vite";
import express from "express";
import { initializeBackend } from "./src/server/server";

export default defineConfig({
  plugins: [
    {
      name: "spellcast-backend",
      apply: "serve",
      configureServer(server) {
        let attached = false;
        const attachBackend = () => {
          if (attached || !server.httpServer) return;
          const backendApp = express();
          initializeBackend(backendApp, server.httpServer, { serveClient: false });
          server.middlewares.use(backendApp);
          attached = true;
        };
        attachBackend();
      }
    }
  ],
  server: {
    host: "0.0.0.0",
    port: 8900
  },
  build: {
    outDir: "dist/client"
  }
});
