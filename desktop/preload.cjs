const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("alder", {
  pickFolder: () => ipcRenderer.invoke("alder:pick-folder"),
  listFiles: (root) => ipcRenderer.invoke("alder:list-files", root),
  readBytes: (root, relative) => ipcRenderer.invoke("alder:read-bytes", root, relative),
  videoFrames: (root, relative) => ipcRenderer.invoke("alder:video-frames", root, relative),
  moveInto: (source, relative, collection, destDir, stem) =>
    ipcRenderer.invoke("alder:move-into", source, relative, collection, destDir, stem),
});
