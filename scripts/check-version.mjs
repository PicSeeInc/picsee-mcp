import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const serverJson = JSON.parse(fs.readFileSync("server.json", "utf8"));
const indexSource = fs.readFileSync("src/index.ts", "utf8");

const packageVersion = packageJson.version;
const registryVersion = serverJson.version;
const runtimeMatch = indexSource.match(
  /MCP_SERVER_VERSION\s*=\s*["']([^"']+)["']/,
);
const runtimeVersion = runtimeMatch?.[1];

const versions = {
  packageVersion,
  registryVersion,
  runtimeVersion,
};

if (
  !runtimeVersion ||
  packageVersion !== registryVersion ||
  packageVersion !== runtimeVersion
) {
  console.error("MCP version mismatch:", versions);
  process.exit(1);
}

console.log(`MCP versions are aligned: ${packageVersion}`);
