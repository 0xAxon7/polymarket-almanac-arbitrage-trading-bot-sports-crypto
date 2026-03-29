import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Route frontend /api/* calls to the backend during development.
      // This avoids hardcoding `localhost:3001` in the browser (which breaks
      // when the UI is accessed from another machine).
      "/api": {
        target: "http://localhost:3001",
        ws: true,
      },
    },
  },
});

