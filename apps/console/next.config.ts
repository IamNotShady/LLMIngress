import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const testDistDirectory = process.env.LLMINGRESS_TEST_CONSOLE_DIST_DIR?.trim();

const config: NextConfig = {
  output: "standalone",
  ...(testDistDirectory ? { distDir: testDistDirectory } : {}),
  turbopack: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
  },
};

export default config;
