import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

export default {
  tests: "e2e/**/*.e2e.ts",
  targets: [
    {
      name: "chromium",
      engine: web(),
      app: {
        url: "http://127.0.0.1:5200",
        command: { executable: "pnpm", args: ["ui:dev", "--host", "127.0.0.1"] },
      },
    },
  ],
  workers: 1,
  retries: 0,
  trace: "retain-on-failure",
  video: "retain-on-failure",
  reporters: ["list", "junit"],
} satisfies E2EConfig;
