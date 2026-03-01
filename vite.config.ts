import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { docsApiPlugin } from "./docsApiPlugin";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 6969,
    allowedHosts: ["memory.test"]
  },
  plugins: [tailwindcss(), react(), docsApiPlugin()]
});
