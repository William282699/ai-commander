import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: "127.0.0.1",
  },
  optimizeDeps: {
    exclude: ["@ai-commander/core", "@ai-commander/shared"],
  },
});
