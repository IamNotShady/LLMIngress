import { formatShellExports, loadEnvFiles } from "./env-loader";

const { loadedValues } = loadEnvFiles();
const exports = formatShellExports(loadedValues);

if (exports) {
  process.stdout.write(exports);
}
