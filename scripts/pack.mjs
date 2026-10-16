import { chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: node scripts/pack.mjs --linux AppImage --win zip");
  process.exit(1);
}

const ffmpegRoot = join(root, "vendor", "ffmpeg");

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 1_000_000) return;
  mkdirSync(dirname(dest), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Could not download the video decoder (${response.status})`);
  await pipeline(response.body, createWriteStream(dest));
}

function findBinary(start, name) {
  const result = spawnSync("find", [start, "-type", "f", "-name", name], { encoding: "utf8" });
  const found = result.stdout.split("\n").find((line) => line.endsWith(`/${name}`));
  if (!found) throw new Error(`Could not find ${name}`);
  return found.trim();
}

async function ensureLinux() {
  const dest = join(ffmpegRoot, "linux-x64", "ffmpeg");
  if (existsSync(dest) && statSync(dest).size > 1_000_000) return dest;
  const archive = join(ffmpegRoot, "src", "linux.tar.xz");
  await download(
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-lgpl.tar.xz",
    archive,
  );
  const unpacked = join(ffmpegRoot, "src", "linux");
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  const extracted = spawnSync("tar", ["--no-same-owner", "-xJf", archive, "-C", unpacked, "--wildcards", "*/bin/ffmpeg"]);
  if (extracted.status !== 0) throw new Error("Could not unpack the Linux video decoder");
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(findBinary(unpacked, "ffmpeg"), dest);
  chmodSync(dest, 0o755);
  return dest;
}

async function ensureWindows() {
  const dest = join(ffmpegRoot, "win32-x64", "ffmpeg.exe");
  if (existsSync(dest) && statSync(dest).size > 1_000_000) return dest;
  const archive = join(ffmpegRoot, "src", "win.zip");
  await download(
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip",
    archive,
  );
  mkdirSync(dirname(dest), { recursive: true });
  const extracted = spawnSync("unzip", ["-j", "-o", archive, "*/bin/ffmpeg.exe", "-d", dirname(dest)]);
  if (extracted.status !== 0 || !existsSync(dest)) throw new Error("Could not unpack the Windows video decoder");
  return dest;
}

const linuxBin = targets.includes("--linux") ? await ensureLinux() : null;
const winBin = targets.includes("--win") ? await ensureWindows() : null;

const config = {
  appId: "app.alder.desktop",
  productName: "Alder",
  executableName: "Alder",
  electronVersion: "35.7.5",
  asar: true,
  npmRebuild: false,
  directories: { output: join(root, "desktop-dist") },
  files: ["desktop/**/*", "src/**/*", "package.json", "node_modules/**/*"],
  asarUnpack: ["**/*.wasm"],
  linux: {
    target: ["AppImage"],
    category: "Utility",
    icon: "desktop/icon.png",
    extraResources: linuxBin ? [{ from: linuxBin, to: "ffmpeg/ffmpeg" }] : [],
  },
  win: {
    target: ["zip"],
    icon: "desktop/icon.png",
    extraResources: winBin ? [{ from: winBin, to: "ffmpeg/ffmpeg.exe" }] : [],
  },
};

const configPath = join(root, "electron-builder.pack.json");
writeFileSync(configPath, JSON.stringify(config, null, 2));
const result = spawnSync("npx", ["electron-builder", "--config", configPath, ...targets, "--publish", "never"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
});
rmSync(configPath, { force: true });
if (result.status !== 0) process.exit(result.status ?? 1);
