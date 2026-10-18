import {
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
  env,
} from "@huggingface/transformers";
import { decide, fileStem, maxScores, parseKinks, promptsFor } from "./decide.mjs";

const MODEL = "Xenova/clip-vit-base-patch32";
const FILED = /^(img|vid)_.+_(SFW|NSFW)_\d+\.[A-Za-z0-9]{1,8}$/i;
const DEFAULT_KINKS = "oral\nvaginal\nanal\nsolo\ngroup\nbondage\nfeet\nlingerie";

const collectionInput = document.querySelector("#collection");
const kinksInput = document.querySelector("#kinks");
const thresholdInput = document.querySelector("#threshold");
const thresholdValue = document.querySelector("#threshold-value");
const videosInput = document.querySelector("#videos");
const skipInput = document.querySelector("#skip");
const sortButton = document.querySelector("#sort");
const stopButton = document.querySelector("#stop");
const hint = document.querySelector("#hint");
const progressWrap = document.querySelector("#progress-wrap");
const bar = document.querySelector("#bar");
const count = document.querySelector("#count");
const current = document.querySelector("#current");
const time = document.querySelector("#time");
const banner = document.querySelector("#banner");

let models = null;
let stop = false;
let started = 0;

collectionInput.value = localStorage.getItem("alder-collection") ?? "";
kinksInput.value = localStorage.getItem("alder-kinks") ?? DEFAULT_KINKS;
thresholdInput.value = localStorage.getItem("alder-threshold") ?? "0.22";
videosInput.checked = localStorage.getItem("alder-videos") === "1";
skipInput.checked = localStorage.getItem("alder-skip") !== "0";
thresholdValue.textContent = Number(thresholdInput.value).toFixed(2);
syncSortButton();

collectionInput.addEventListener("input", () => {
  localStorage.setItem("alder-collection", collectionInput.value);
  syncSortButton();
});
kinksInput.addEventListener("input", () => localStorage.setItem("alder-kinks", kinksInput.value));
thresholdInput.addEventListener("input", () => {
  thresholdValue.textContent = Number(thresholdInput.value).toFixed(2);
  localStorage.setItem("alder-threshold", thresholdInput.value);
});
videosInput.addEventListener("change", () => localStorage.setItem("alder-videos", videosInput.checked ? "1" : "0"));
skipInput.addEventListener("change", () => localStorage.setItem("alder-skip", skipInput.checked ? "1" : "0"));
document.querySelector("#choose").addEventListener("click", async (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!window.alder) {
    showBanner("Open the Alder desktop app to choose a folder.");
    return;
  }
  try {
    const picked = await window.alder.pickFolder();
    if (!picked) return;
    collectionInput.value = picked;
    localStorage.setItem("alder-collection", picked);
    syncSortButton();
    showBanner("");
  } catch (error) {
    showBanner(error instanceof Error ? error.message : "Could not open the folder list");
  }
});
sortButton.addEventListener("click", () => void runSort());
stopButton.addEventListener("click", () => {
  stop = true;
});

function syncSortButton() {
  sortButton.disabled = collectionInput.value.trim() === "";
}

function showBanner(text) {
  banner.hidden = !text;
  banner.textContent = text ?? "";
}

function showProgress(done, total, file) {
  progressWrap.hidden = false;
  const ratio = total > 0 ? done / total : 0;
  bar.style.width = `${Math.round(ratio * 100)}%`;
  count.textContent = total > 0 ? `${done} of ${total}` : "Preparing the picture model";
  current.textContent = file || "";
  const elapsed = Math.max(0, Date.now() - started);
  const remaining = done > 0 && total > done ? (elapsed / done) * (total - done) : 0;
  time.textContent = `${format(elapsed)} elapsed${done > 0 && total > done ? ` · about ${format(remaining)} left` : ""}`;
}

function format(ms) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return `${rest}s`;
  return `${minutes}m ${rest}s`;
}

function row(tensor) {
  const data = tensor.data;
  const dims = tensor.dims ?? [];
  const width = dims.length > 1 ? dims[dims.length - 1] : data.length;
  const count = dims.length > 1 ? dims[dims.length - 2] : 1;
  return { data, width, count };
}

function normalize(parsed) {
  const out = new Float32Array(parsed.data.length);
  for (let index = 0; index < parsed.count; index += 1) {
    let sum = 0;
    const start = index * parsed.width;
    for (let column = 0; column < parsed.width; column += 1) sum += parsed.data[start + column] ** 2;
    const scale = sum > 0 ? 1 / Math.sqrt(sum) : 0;
    for (let column = 0; column < parsed.width; column += 1) out[start + column] = parsed.data[start + column] * scale;
  }
  return { data: out, width: parsed.width, count: parsed.count };
}

function cosine(image, texts) {
  const scores = [];
  for (let index = 0; index < texts.count; index += 1) {
    let sum = 0;
    const start = index * texts.width;
    for (let column = 0; column < image.width; column += 1) sum += image.data[column] * texts.data[start + column];
    scores.push(sum);
  }
  return scores;
}

async function prepare(onFile) {
  if (models) return models;
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = `${location.origin}/vendor/transformers/dist/`;
  env.backends.onnx.wasm.numThreads = 1;
  const options = {
    dtype: "q8",
    progress_callback: (update) => {
      if (update?.file) onFile(update.file);
    },
  };
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL, options);
  const processor = await AutoProcessor.from_pretrained(MODEL, options);
  const textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL, options);
  const visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL, options);
  models = { tokenizer, processor, textModel, visionModel };
  return models;
}

async function embedTexts(engine, prompts) {
  const inputs = await engine.tokenizer(prompts, { padding: true, truncation: true });
  const output = await engine.textModel(inputs);
  return normalize(row(output.text_embeds));
}

async function embedImage(engine, bytes) {
  const image = await RawImage.fromBlob(new Blob([bytes]));
  const inputs = await engine.processor(image);
  const output = await engine.visionModel(inputs);
  return normalize(row(output.image_embeds));
}

async function scoreFrames(engine, texts, frames) {
  const scored = [];
  for (const frame of frames) {
    if (stop) return [];
    const image = await embedImage(engine, frame);
    scored.push(cosine(image, texts));
  }
  return scored;
}

async function runSort() {
  if (!window.alder) {
    showBanner("Open the Alder desktop app to sort a folder.");
    return;
  }
  const collection = collectionInput.value.trim();
  let kinks;
  try {
    kinks = parseKinks(kinksInput.value);
  } catch (error) {
    showBanner(error instanceof Error ? error.message : "Check the kink list.");
    return;
  }
  const source = await window.alder.pickFolder();
  if (!source) return;
  if (!window.confirm("Move files into the collection? A sorted picture is renamed like img_Oral_NSFW_1, and a sorted video like vid_Oral_NSFW_1. The closest kink above the slider wins. Anything else goes to Unsorted.")) {
    return;
  }
  stop = false;
  started = Date.now();
  sortButton.disabled = true;
  stopButton.hidden = false;
  showBanner("");
  showProgress(0, 0, "Preparing the picture model");
  let moved = 0;
  let unsorted = 0;
  let failed = 0;
  let skipped = 0;
  try {
    const engine = await prepare((file) => showProgress(0, 0, `Downloading ${file}`));
    if (stop) return;
    const texts = await embedTexts(engine, promptsFor(kinks.map((item) => item.label)));
    const files = await window.alder.listFiles(source);
    const work = files.filter((file) => !(skipInput.checked && FILED.test(file.relative.slice(file.relative.lastIndexOf("/") + 1))));
    const threshold = Number(thresholdInput.value);
    for (let index = 0; index < work.length; index += 1) {
      if (stop) break;
      const file = work[index];
      showProgress(index, work.length, file.relative);
      try {
        if (file.kind === "misc") {
          const directory = file.relative.includes("/") ? file.relative.slice(0, file.relative.lastIndexOf("/")) : "";
          if (directory === "misc") skipped += 1;
          else if (await window.alder.moveInto(source, file.relative, collection, "misc", null)) moved += 1;
          else skipped += 1;
          continue;
        }
        if (file.kind === "video" && !videosInput.checked) {
          if (await window.alder.moveInto(source, file.relative, collection, "Kinks/Unsorted/videos", null)) moved += 1;
          unsorted += 1;
          continue;
        }
        const frames =
          file.kind === "video"
            ? await window.alder.videoFrames(source, file.relative)
            : [await window.alder.readBytes(source, file.relative)];
        const scored = frames.length ? await scoreFrames(engine, texts, frames) : [];
        if (stop) break;
        const choice = scored.length ? decide(maxScores(scored), kinks.length, threshold) : { index: -1, nsfw: true };
        const kink = choice.index >= 0 ? kinks[choice.index] : null;
        const folder = kink
          ? `Kinks/${kink.folder}${file.kind === "video" ? "/videos" : ""}`
          : file.kind === "video"
            ? "Kinks/Unsorted/videos"
            : "Kinks/Unsorted";
        const stem = kink ? fileStem(file.kind === "video" ? "vid" : "img", kink.folder, choice.nsfw) : null;
        if (await window.alder.moveInto(source, file.relative, collection, folder, stem)) moved += 1;
        else skipped += 1;
        if (!kink) unsorted += 1;
      } catch {
        failed += 1;
      }
    }
    showProgress(work.length, work.length, "");
    const problems = failed ? ` ${failed} could not be moved.` : "";
    showBanner(
      stop
        ? `Stopped after moving ${moved}.`
        : `Moved ${moved}. ${unsorted} went to Unsorted. Left ${skipped} that were already filed.${problems}`,
    );
  } catch (error) {
    showBanner(error instanceof Error ? error.message : "Could not sort that folder");
  } finally {
    sortButton.disabled = collectionInput.value.trim() === "";
    stopButton.hidden = true;
  }
}
