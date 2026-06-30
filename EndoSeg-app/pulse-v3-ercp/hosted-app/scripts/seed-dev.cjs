const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const devDataDir = path.join(rootDir, "dev-data");
const seedPath = path.join(devDataDir, "seed.json");
const dbPath = path.join(devDataDir, "hosted-dev-db.json");
const objectStoreDir = path.join(devDataDir, "object-store");

fs.mkdirSync(devDataDir, { recursive: true });

if (fs.existsSync(objectStoreDir)) {
  fs.rmSync(objectStoreDir, { recursive: true, force: true });
}

const seed = fs.readFileSync(seedPath, "utf8");
fs.writeFileSync(dbPath, seed);

console.log(`Reset hosted dev database from ${seedPath}`);
