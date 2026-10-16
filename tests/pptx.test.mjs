import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import JSZip from "jszip";
import { orderSlides } from "../build/pptx.js";

const fixture = fs.readFileSync(new URL("./fixtures/relationship-order.pptx", import.meta.url));
const pages = Array.from({ length: 12 }, (_, index) => ({
  pageNumber: index + 1,
  content: `slide ${index + 1}`,
}));

test("PPTX page count and content exclude slides absent from the presentation list", async () => {
  const zip = await JSZip.loadAsync(fixture);
  const presentation = await zip.file("ppt/presentation.xml").async("string");
  const modified = presentation.replace(/<p:sldId\b[^>]*r:id="rId8"[^>]*\/>/, "");
  assert.notEqual(modified, presentation);
  zip.file("ppt/presentation.xml", modified);

  const result = await orderSlides(await zip.generateAsync({ type: "nodebuffer" }), pages);
  assert.equal(result.pages, 11);
  assert.deepEqual(result.text.split("\n\n"), [4, 1, 12, 2, 10, 3, 11, 5, 9, 7, 6].map((number) => `slide ${number}`));
});

test("PPTX rejects a relationship pointing to a missing slide", async () => {
  const zip = await JSZip.loadAsync(fixture);
  const relationships = await zip.file("ppt/_rels/presentation.xml.rels").async("string");
  const modified = relationships.replace('Target="slides/slide4.xml"', 'Target="slides/slide404.xml"');
  assert.notEqual(modified, relationships);
  zip.file("ppt/_rels/presentation.xml.rels", modified);

  await assert.rejects(
    orderSlides(await zip.generateAsync({ type: "nodebuffer" }), pages),
    /missing ppt\/slides\/slide404\.xml/,
  );
});

test("PPTX rejects a presentation slide without a matching relationship", async () => {
  const zip = await JSZip.loadAsync(fixture);
  const presentation = await zip.file("ppt/presentation.xml").async("string");
  const modified = presentation.replace('r:id="rId4"', 'r:id="rId404"');
  assert.notEqual(modified, presentation);
  zip.file("ppt/presentation.xml", modified);

  await assert.rejects(
    orderSlides(await zip.generateAsync({ type: "nodebuffer" }), pages),
    /unresolved slide reference/,
  );
});
