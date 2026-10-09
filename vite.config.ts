import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig(({ command, mode }) => ({
  build: {
    minify: true,
  },
  define: {
    // Keep OAuth metadata aligned with the proxy only during local development.
    "process.env.PORTLESS_URL":
      command === "serve" && mode === "development"
        ? (JSON.stringify(process.env.PORTLESS_URL) ?? "undefined")
        : "undefined",
  },
  plugins: [cloudflare()],
}));
