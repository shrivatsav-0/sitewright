/**
 * pickVisionImages: which screenshots the analyze step lets the vision model see.
 *
 * The analyze step must actually look at the captured photos before anything is
 * generated: the fold shot for the overall layout plus the largest per-section
 * crops, bounded by AI_MAX_SECTION_IMAGES and a hard total ceiling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickVisionImages } from "../src/lib/analyzer/synthesize";

const shotsDir = "/proj/screenshots";

function crop(index: number, width: number, height: number) {
  return { index, file: `section-${String(index).padStart(2, "0")}.png`, width, height };
}

test("fold shot is included when present", () => {
  const images = pickVisionImages({
    shotsDir,
    foldFile: "original-desktop-fold.png",
    sectionShots: [],
    maxSectionImages: 2,
  });
  assert.equal(images.length, 1);
  assert.equal(images[0].label, "fold: the source site at desktop width");
  assert.equal(images[0].path, `${shotsDir}/original-desktop-fold.png`);
});

test("largest section crops are chosen, bounded by maxSectionImages", () => {
  const sectionShots = [
    crop(0, 1440, 200),
    crop(1, 1440, 900),
    crop(2, 1440, 460),
  ];
  const images = pickVisionImages({ shotsDir, foldFile: "fold.png", sectionShots, maxSectionImages: 2 });
  // area 1 (1296000) and area 2 (662400) beat area 0 (288000)
  assert.equal(images.length, 3);
  assert.equal(images[1].label, "section 1: desktop crop of the source page");
  assert.equal(images[2].label, "section 2: desktop crop of the source page");
});

test("maxSectionImages of zero attaches only the fold shot", () => {
  const images = pickVisionImages({
    shotsDir,
    foldFile: "fold.png",
    sectionShots: [crop(0, 1440, 900), crop(1, 1440, 300)],
    maxSectionImages: 0,
  });
  assert.equal(images.length, 1);
  assert.match(images[0].label, /^fold:/);
});

test("the fold shot counts against the hard total ceiling", () => {
  const images = pickVisionImages({
    shotsDir,
    foldFile: "fold.png",
    sectionShots: [crop(0, 1440, 900), crop(1, 1440, 900), crop(2, 1440, 900)],
    maxSectionImages: 50,
    maxTotal: 3,
  });
  assert.equal(images.length, 3);
  assert.match(images[0].label, /^fold:/);
  assert.equal(images.filter((i) => /section/.test(i.label)).length, 2);
});

test("no photos on disk yields no attachments", () => {
  const images = pickVisionImages({
    shotsDir,
    foldFile: undefined,
    sectionShots: [],
    maxSectionImages: 2,
  });
  assert.deepEqual(images, []);
});

test("bizarre budgets never blow up or attach negatives", () => {
  const images = pickVisionImages({
    shotsDir,
    foldFile: "fold.png",
    sectionShots: [crop(0, 100, 100)],
    maxSectionImages: -5,
  });
  assert.equal(images.length, 1);
  const none = pickVisionImages({
    shotsDir,
    foldFile: undefined,
    sectionShots: [crop(0, 100, 100)],
    maxSectionImages: Number.NaN,
  });
  assert.equal(none.length, 0);
});