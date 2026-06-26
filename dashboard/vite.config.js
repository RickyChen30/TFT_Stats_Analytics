import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API base is read at runtime from VITE_API_BASE (see src/api.js),
// defaulting to http://localhost:8000 for local development.
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

export default defineConfig({
  plugins: [react()],
  server: { port, host: "0.0.0.0" },
  preview: { port, host: "0.0.0.0" },
});
