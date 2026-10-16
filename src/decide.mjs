const BLOCKED =
  /\b(child|children|kid|kids|minor|minors|underage|under-age|preteen|pre-teen|loli|lolicon|lolita|shota|shotacon|teen|teens|teenage|teenager|jailbait|pedo|paedo|young girl|young boy|little girl|little boy|baby|toddler|infant)\b/i;

export function blockedLabel(label) {
  return BLOCKED.test(String(label));
}

export function folderName(label) {
  const cleaned = String(label)
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
  if (!cleaned) return "";
  return cleaned.replace(/\b([a-z])/g, (letter) => letter.toUpperCase());
}

export function fileStem(kind, folder, nsfw) {
  const short = folder
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!short) return null;
  return `${kind}_${short}_${nsfw ? "NSFW" : "SFW"}`;
}

export function promptsFor(kinks) {
  return [
    ...kinks.map((label) => `a photograph featuring ${label}`),
    "an ordinary photograph with none of the requested subjects",
    "an explicit sexual photograph",
    "a non-sexual photograph of a clothed person",
  ];
}

export function decide(scores, kinkCount, threshold) {
  let best = -Infinity;
  let index = -1;
  for (let i = 0; i < kinkCount; i += 1) {
    const score = scores[i] ?? -Infinity;
    if (score > best) {
      best = score;
      index = i;
    }
  }
  const none = scores[kinkCount] ?? 0;
  const explicit = scores[kinkCount + 1] ?? 0;
  const plain = scores[kinkCount + 2] ?? 0;
  const matched = index >= 0 && best >= threshold && best > none;
  return { index: matched ? index : -1, nsfw: explicit >= plain, best: Number.isFinite(best) ? best : 0 };
}

export function maxScores(frames) {
  if (frames.length === 0) return [];
  const width = frames[0].length;
  const scores = new Array(width).fill(-Infinity);
  for (const frame of frames) {
    for (let i = 0; i < width; i += 1) scores[i] = Math.max(scores[i], frame[i] ?? -Infinity);
  }
  return scores;
}

export function parseKinks(value) {
  const seen = new Set();
  const kinks = [];
  for (const part of String(value ?? "").split(/\n|,/)) {
    const label = part.trim().toLowerCase();
    if (!label || seen.has(label)) continue;
    if (blockedLabel(label)) throw new Error(`Remove "${part.trim()}" from the kink list. Alder does not sort that.`);
    const folder = folderName(label);
    if (!folder) continue;
    seen.add(label);
    kinks.push({ label, folder });
  }
  if (kinks.length === 0) throw new Error("Add at least one kink before sorting.");
  if (kinks.length > 24) throw new Error("Use 24 kinks or fewer in one run.");
  return kinks;
}
