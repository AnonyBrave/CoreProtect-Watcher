import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// L'UI est construite dans dist/, servie par le serveur Fastify (port 8765).
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2020",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
        // Le flux SSE ne doit pas être mis en tampon par le proxy de dev.
        configure: (proxy) => {
          proxy.on("proxyRes", (res) => {
            if (res.headers["content-type"] === "text/event-stream") res.socket?.setNoDelay(true);
          });
        },
      },
    },
  },
});
