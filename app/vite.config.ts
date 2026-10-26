import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Static SPA — served by dynames behind `tailscale serve` (ARCH §1).
  // Single origin; conversations go direct to each agent host over wss://.
  build: {
    outDir: "dist",
  },
});
