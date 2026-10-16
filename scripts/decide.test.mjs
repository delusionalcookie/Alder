import assert from "node:assert/strict";
import test from "node:test";
import { blockedLabel, decide, fileStem, folderName, maxScores } from "../src/decide.mjs";

test("a kink wins only when it clears the slider and beats none", () => {
  const scores = [0.3, 0.18, 0.1, 0.22, 0.4];
  assert.deepEqual(decide(scores, 2, 0.24), { index: 0, nsfw: false, best: 0.3 });
  assert.deepEqual(decide(scores, 2, 0.35), { index: -1, nsfw: false, best: 0.3 });
  assert.deepEqual(decide([0.2, 0.26, 0.5, 0.1], 2, 0.2), { index: -1, nsfw: true, best: 0.26 });
});

test("one strong video frame is enough", () => {
  const scores = maxScores([
    [0.1, 0.05, 0.08, 0.1, 0.3],
    [0.31, 0.12, 0.1, 0.42, 0.2],
  ]);
  assert.deepEqual(decide(scores, 2, 0.24), { index: 0, nsfw: true, best: 0.31 });
});

test("folder names and blocked labels", () => {
  assert.equal(folderName("oral"), "Oral");
  assert.equal(fileStem("img", "Oral", true), "img_Oral_NSFW");
  assert.equal(blockedLabel("teen"), true);
  assert.equal(blockedLabel("oral"), false);
  assert.equal(blockedLabel("bondage"), false);
});
