import JSZip from "jszip";
import { XMLParser, XMLValidator } from "fast-xml-parser";

type XmlNode = Record<string, unknown>;

interface SlidePage {
  readonly content: string;
  readonly pageNumber: number;
}

/** Reorders Xberg's extracted slides to match the presentation's `<p:sldIdLst>` sequence. */
export async function orderSlides(data: Buffer, pages: readonly SlidePage[]): Promise<{ text: string; pages: number }> {
  const zip = await JSZip.loadAsync(data);
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  const readXml = async (name: string): Promise<XmlNode> => {
    const part = zip.file(name);
    if (!part) throw new Error(`Cannot determine PPTX slide order: missing ${name}.`);
    const source = await part.async("string");
    if (XMLValidator.validate(source) !== true) throw new Error(`Invalid PPTX XML in ${name}.`);
    return parser.parse(source) as XmlNode;
  };
  const [presentation, relationships] = await Promise.all([
    readXml("ppt/presentation.xml"),
    readXml("ppt/_rels/presentation.xml.rels"),
  ]);
  const root = one(child(presentation, "presentation"));
  const relationshipRoot = one(child(relationships, "Relationships"));
  if (!root || !relationshipRoot) throw new Error("Cannot determine PPTX slide order: invalid presentation metadata.");

  const targets = new Map<string, string>();
  const nativePaths: string[] = [];
  for (const relation of nodes(child(relationshipRoot, "Relationship"))) {
    const type = String(relation["@_Type"] ?? "");
    if (!type.includes("slide") || type.includes("slideMaster")) continue;
    const id = String(relation["@_Id"] ?? "");
    const target = String(relation["@_Target"] ?? "").replace(/^\//, "");
    const slidePath = target.startsWith("ppt/") ? target : `ppt/${target}`;
    if (!id || targets.has(id) || relation["@_TargetMode"] === "External" || !/^ppt\/slides\/slide\d+\.xml$/.test(slidePath)) {
      throw new Error("Cannot determine PPTX slide order: unsupported or invalid slide relationship.");
    }
    if (!zip.file(slidePath)) throw new Error(`Cannot determine PPTX slide order: missing ${slidePath}.`);
    targets.set(id, slidePath);
    nativePaths.push(slidePath);
  }

  // Xberg 1.3.10 sorts slide relationships by filename rather than `<p:sldIdLst>`:
  // https://github.com/xberg-io/xberg/blob/v1.3.10/crates/xberg/src/extraction/pptx/parser.rs
  nativePaths.sort((a, b) => slideNumber(a) - slideNumber(b));
  if (new Set(nativePaths).size !== nativePaths.length || pages.length !== nativePaths.length) {
    throw new Error("Cannot determine PPTX slide order: Xberg did not return every slide exactly once.");
  }
  const content = new Map<string, string>();
  for (const page of pages) {
    const slidePath = nativePaths[page.pageNumber - 1];
    if (!slidePath || content.has(slidePath)) throw new Error("Cannot determine PPTX slide order: invalid Xberg page numbers.");
    content.set(slidePath, page.content);
  }

  const slides = nodes(child(one(child(root, "sldIdLst")) ?? {}, "sldId"));
  if (!slides.length && nativePaths.length) throw new Error("Cannot determine PPTX slide order: missing slide list.");
  const ordered = slides.map((slide) => {
    const id = Object.entries(slide).find(([key]) => /^@_[^:]+:id$/.test(key))?.[1];
    const target = targets.get(String(id ?? ""));
    if (!target || !content.has(target)) throw new Error("Cannot determine PPTX slide order: unresolved slide reference.");
    return content.get(target)!;
  });
  return { text: ordered.join("\n\n"), pages: ordered.length };
}

function child(node: XmlNode, name: string): unknown {
  return Object.entries(node).find(([key]) => !key.startsWith("@_") && key.split(":").at(-1) === name)?.[1];
}

function nodes(value: unknown): XmlNode[] {
  return (value === undefined ? [] : Array.isArray(value) ? value : [value]).map((node) => {
    if (!node || typeof node !== "object") throw new Error("Cannot determine PPTX slide order: invalid XML element.");
    return node as XmlNode;
  });
}

function one(value: unknown): XmlNode | undefined {
  return nodes(value)[0];
}

function slideNumber(slidePath: string): number {
  const number = Number(/slide(\d+)\.xml$/.exec(slidePath)![1]);
  if (!Number.isInteger(number) || number < 0 || number > 0xffff_ffff) {
    throw new Error("Cannot determine PPTX slide order: unsupported slide filename.");
  }
  return number;
}
