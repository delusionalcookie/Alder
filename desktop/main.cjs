const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

let rules = null;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"]);
const VIDEO_EXT = new Set([
  ".mp4",
  ".m4v",
  ".mkv",
  ".webm",
  ".mov",
  ".avi",
  ".wmv",
  ".flv",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".3gp",
  ".ts",
  ".m2ts",
]);

function insideRoot(root, target) {
  const base = path.resolve(root);
  const file = path.resolve(target);
  return file === base || file.startsWith(base + path.sep);
}

function resolveInside(root, relative) {
  if (typeof root !== "string" || typeof relative !== "string") throw new Error("Bad path");
  if (relative.includes("\0") || path.isAbsolute(relative)) throw new Error("Bad path");
  const full = path.resolve(root, ...relative.split("/").filter(Boolean));
  if (!insideRoot(root, full)) throw new Error("Bad path");
  return full;
}

function safeFolder(name) {
  const cleaned = String(name ?? "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || "Untitled";
}

async function exists(full) {
  try {
    await fs.promises.access(full);
    return true;
  } catch {
    return false;
  }
}

async function vacantName(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  let n = 2;
  for (;;) {
    try {
      await fs.promises.access(path.join(dir, candidate));
      candidate = `${stem}-${n}${ext}`;
      n += 1;
    } catch {
      return candidate;
    }
  }
}

async function numberedName(dir, stem, ext, source) {
  const safeStem = String(stem).replace(/[\\/:*?"<>|]/g, "").slice(0, 80);
  const safeExt = /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext : "";
  if (!safeStem) return path.basename(source);
  const current = path.basename(source);
  const tail = current.slice(safeStem.length + 1, current.length - safeExt.length);
  if (
    path.resolve(path.dirname(source)) === path.resolve(dir) &&
    current.startsWith(`${safeStem}_`) &&
    current.endsWith(safeExt) &&
    /^\d+$/.test(tail)
  ) {
    return current;
  }
  for (let n = 1; n <= 100000; n += 1) {
    const candidate = `${safeStem}_${n}${safeExt}`;
    if (path.resolve(path.join(dir, candidate)) === path.resolve(source)) return candidate;
    try {
      await fs.promises.access(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
  return `${safeStem}_${Date.now()}${safeExt}`;
}

async function transfer(src, dest) {
  const stat = await fs.promises.lstat(src);
  if (stat.isDirectory()) {
    await fs.promises.mkdir(dest, { recursive: true });
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      await transfer(path.join(src, entry.name), path.join(dest, entry.name));
    }
    await fs.promises.rmdir(src).catch(() => {});
    return;
  }
  if (await exists(dest)) {
    await transfer(src, path.join(path.dirname(dest), await vacantName(path.dirname(dest), path.basename(src))));
    return;
  }
  try {
    await fs.promises.rename(src, dest);
  } catch (error) {
    if (!error || error.code !== "EXDEV") throw error;
    await fs.promises.copyFile(src, dest);
    await fs.promises.unlink(src);
  }
}

function destinationDir(destRoot, destDir) {
  const full = String(destDir ?? "")
    .split("/")
    .filter(Boolean)
    .map((part) => safeFolder(part))
    .reduce((dir, part) => path.join(dir, part), path.resolve(destRoot));
  if (!insideRoot(destRoot, full)) throw new Error("Bad path");
  return full;
}

async function pruneEmptyParents(start, root) {
  let current = start;
  while (path.resolve(current) !== path.resolve(root)) {
    if (!insideRoot(root, current)) return;
    let names;
    try {
      names = await fs.promises.readdir(current);
    } catch {
      return;
    }
    if (names.length > 0) return;
    await fs.promises.rmdir(current);
    current = path.dirname(current);
  }
}

async function moveInto(sourceRoot, relative, destRoot, destDir, stem) {
  const source = resolveInside(sourceRoot, relative);
  const folder = destinationDir(destRoot, destDir);
  await fs.promises.mkdir(folder, { recursive: true });
  const ext = path.extname(source);
  const name = stem ? await numberedName(folder, stem, ext, source) : await vacantName(folder, path.basename(source));
  const dest = path.join(folder, name);
  if (path.resolve(dest) === path.resolve(source)) return false;
  await transfer(source, dest);
  await pruneEmptyParents(path.dirname(source), path.resolve(sourceRoot));
  return true;
}

async function listFiles(root) {
  const base = path.resolve(root);
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "__MACOSX" || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (!insideRoot(base, full)) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const relative = path.relative(base, full).split(path.sep).join("/");
      if (IMAGE_EXT.has(ext)) found.push({ relative, kind: "image" });
      else if (VIDEO_EXT.has(ext)) found.push({ relative, kind: "video" });
      else found.push({ relative, kind: "misc" });
    }
  }
  await walk(base);
  return found;
}

function ffmpegBin() {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  if (app.isPackaged) return path.join(process.resourcesPath, "ffmpeg", name);
  const folder = `${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`;
  return path.join(__dirname, "..", "vendor", "ffmpeg", folder, name);
}

function runFfmpeg(args, collectStdout) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegBin();
    if (!fs.existsSync(bin)) {
      reject(new Error("The video decoder is not in this copy of Alder."));
      return;
    }
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(bin, 0o755);
      } catch {
        // The packaged binary may already be executable.
      }
    }
    const child = spawn(bin, args, { windowsHide: true });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on("data", (chunk) => {
      if (collectStdout) out.push(chunk);
    });
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

async function videoFrames(full) {
  const probed = await runFfmpeg(["-hide_banner", "-i", full], false);
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probed.stderr);
  const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  const times =
    duration > 1
      ? [0.1, 0.3, 0.5, 0.7, 0.9].map((point) => Math.max(0.25, Math.min(duration - 0.25, duration * point)))
      : [0];
  const frames = [];
  for (const seconds of times) {
    const shot = await runFfmpeg(
      ["-hide_banner", "-loglevel", "error", "-ss", seconds.toFixed(3), "-i", full, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
      true,
    );
    if (shot.stdout.length > 100) frames.push(shot.stdout);
  }
  return frames;
}

function safeJoin(root, relative) {
  const file = path.resolve(root, ...String(relative).split("/").filter(Boolean));
  if (file !== path.resolve(root) && !file.startsWith(path.resolve(root) + path.sep)) return null;
  return file;
}

function startUi() {
  const srcRoot = path.resolve(__dirname, "..", "src");
  const modelRoot = path.resolve(__dirname, "..", "node_modules", "@huggingface", "transformers");
  const wasmRoot = path.resolve(__dirname, "..", "node_modules", "onnxruntime-web", "dist");
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".json": "application/json",
    ".map": "application/json",
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let file = null;
    if (url.pathname.startsWith("/vendor/transformers/")) {
      file = safeJoin(modelRoot, decodeURIComponent(url.pathname.slice("/vendor/transformers/".length)));
    } else {
      const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      file = safeJoin(srcRoot, relative);
    }
    if ((!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) && url.pathname.endsWith(".wasm")) {
      file = safeJoin(wasmRoot, path.basename(url.pathname));
    }
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}/`);
    });
  });
}

function register() {
  ipcMain.handle("alder:pick-folder", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window ?? undefined, {
      title: "Choose a folder",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("alder:list-files", (_event, root) => listFiles(root));
  ipcMain.handle("alder:read-bytes", async (_event, root, relative) => fs.promises.readFile(resolveInside(root, relative)));
  ipcMain.handle("alder:video-frames", (_event, root, relative) => videoFrames(resolveInside(root, relative)));
  ipcMain.handle("alder:move-into", (_event, source, relative, collection, destDir, stem) => {
    if (rules?.blockedLabel?.(destDir) || rules?.blockedLabel?.(stem ?? "")) {
      throw new Error("Alder does not sort that.");
    }
    return moveInto(source, relative, collection, destDir, stem || null);
  });
}

async function openWindow(url) {
  const window = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: "Alder",
    backgroundColor: "#161513",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });
  await window.loadURL(url);
  if (process.env.ALDER_SMOKE === "1") {
    window.webContents.on("console-message", (_event, _level, message) => {
      if (/error|fail|unable/i.test(message)) console.error("SMOKE", message);
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const ready = await window.webContents.executeJavaScript(
      "document.title === 'Alder' && Boolean(window.alder && window.alder.listFiles) && document.querySelector('#kinks').value.includes('oral')",
    );
    console.log(ready ? "SMOKE ok" : "SMOKE failed");
    app.exit(ready ? 0 : 1);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(async () => {
    rules = await import("../src/decide.mjs");
    register();
    const url = await startUi();
    return openWindow(url);
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
  app.on("window-all-closed", () => app.quit());
}
