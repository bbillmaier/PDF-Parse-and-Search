import { PdfParseError } from "../errors.ts";
import type { PdfDocument } from "../parser/document.ts";
import { dictGet, isDict, isName, isRef, isStream, type PdfDict, type PdfStream, type PdfValue } from "../parser/objects.ts";
import type { PageDescriptor } from "../parser/pages.ts";
import type { XObjectPlacement } from "../content/interpreter.ts";
import type { DocumentImage, ImagePlacement, ParseWarning, SafetyLimits } from "../types.ts";
import { encodeRgbaPng } from "./png.ts";

export interface ImageTimingDiagnostics {
  jpegPassThroughMs: number;
  flateImageDecodeMs: number;
  pngEncodeMs: number;
  imageBytes: number;
}

export interface ImageExtractionResult {
  assets: DocumentImage[];
  placementImageIds: Map<string, string>;
  warnings: ParseWarning[];
  timings: ImageTimingDiagnostics;
}

interface MutableImageAsset extends DocumentImage {
  placements: ImagePlacement[];
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function warning(message: string, pageNumber: number, detail?: string): ParseWarning {
  return { code: "unsupported-image", message, pageNumber, detail };
}

function nameOf(value: PdfValue | undefined): string | undefined {
  return isName(value) ? value.name : undefined;
}

function filterNames(dict: PdfDict): string[] {
  const filter = dictGet(dict, "Filter");
  if (isName(filter)) return [filter.name];
  if (filter && typeof filter === "object" && "kind" in filter && filter.kind === "array") {
    return filter.items.map(nameOf).filter((name): name is string => typeof name === "string");
  }
  return [];
}

function computePlacement(event: XObjectPlacement): ImagePlacement {
  const [a, b, c, d, e, f] = event.matrix;
  return {
    pageNumber: event.pageNumber,
    x: e,
    y: f,
    width: Math.hypot(a, b),
    height: Math.hypot(c, d),
    matrix: [...event.matrix] as [number, number, number, number, number, number],
    xObjectName: event.name,
  };
}

function placementKey(event: XObjectPlacement): string {
  return `${event.pageNumber}:${event.name}:${event.sourceOffset}`;
}

async function resolveXObjectDict(doc: PdfDocument, page: PageDescriptor): Promise<PdfDict | undefined> {
  if (!page.resources) return undefined;
  const xobjects = await doc.resolve(dictGet(page.resources, "XObject"));
  return isDict(xobjects) ? xobjects : undefined;
}

function validateDimensions(
  width: number | undefined,
  height: number | undefined,
  limits: Pick<SafetyLimits, "maxImageDimensionPx" | "maxImagePixelCount">,
): { ok: true; width: number; height: number } | { ok: false; reason: string } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height) return { ok: false, reason: "missing or invalid width/height" };
  if (width > limits.maxImageDimensionPx || height > limits.maxImageDimensionPx) {
    return { ok: false, reason: `dimensions ${width}x${height} exceed maxImageDimensionPx (${limits.maxImageDimensionPx})` };
  }
  if (width * height > limits.maxImagePixelCount) {
    return { ok: false, reason: `pixel count ${width * height} exceeds maxImagePixelCount (${limits.maxImagePixelCount})` };
  }
  return { ok: true, width, height };
}

function validateJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9;
}

function rawStreamBytes(doc: PdfDocument, stream: PdfStream): Uint8Array {
  return doc.bytes.slice(stream.start, stream.end);
}

function rgbaFromGray(decoded: Uint8Array, width: number, height: number, alpha?: Uint8Array): Uint8Array {
  const pixels = width * height;
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const v = decoded[i] ?? 0;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = alpha ? alpha[i] ?? 255 : 255;
  }
  return out;
}

function rgbaFromRgb(decoded: Uint8Array, width: number, height: number, alpha?: Uint8Array): Uint8Array {
  const pixels = width * height;
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    out[i * 4] = decoded[i * 3] ?? 0;
    out[i * 4 + 1] = decoded[i * 3 + 1] ?? 0;
    out[i * 4 + 2] = decoded[i * 3 + 2] ?? 0;
    out[i * 4 + 3] = alpha ? alpha[i] ?? 255 : 255;
  }
  return out;
}

async function decodeMask(doc: PdfDocument, maskValue: unknown, width: number, height: number): Promise<Uint8Array | undefined> {
  if (!maskValue) return undefined;
  const mask = await doc.resolve(maskValue as PdfValue);
  if (!isStream(mask)) return undefined;
  const maskWidth = dictGet(mask.dict, "Width");
  const maskHeight = dictGet(mask.dict, "Height");
  const bits = dictGet(mask.dict, "BitsPerComponent");
  const colorSpace = nameOf(dictGet(mask.dict, "ColorSpace"));
  const imageMask = dictGet(mask.dict, "ImageMask") === true;
  if (maskWidth !== width || maskHeight !== height) return undefined;
  if (imageMask) return undefined;
  if (bits !== 8 || (colorSpace && colorSpace !== "DeviceGray")) return undefined;
  const decoded = await doc.getDecodedStreamBytes(mask);
  return decoded.byteLength >= width * height ? decoded.subarray(0, width * height) : undefined;
}

async function buildFlatePng(
  doc: PdfDocument,
  stream: PdfStream,
  width: number,
  height: number,
  timings: ImageTimingDiagnostics,
): Promise<Uint8Array> {
  const bits = dictGet(stream.dict, "BitsPerComponent");
  if (bits !== 8) {
    throw new PdfParseError("unsupported-feature", `Only 8-bit Flate image components are supported (got ${String(bits)}).`);
  }
  const colorSpace = nameOf(dictGet(stream.dict, "ColorSpace"));
  const decodeStart = now();
  const decoded = await doc.getDecodedStreamBytes(stream);
  const alpha = await decodeMask(doc, dictGet(stream.dict, "SMask") ?? dictGet(stream.dict, "Mask"), width, height);
  timings.flateImageDecodeMs += now() - decodeStart;

  let rgba: Uint8Array;
  if (colorSpace === "DeviceGray") rgba = rgbaFromGray(decoded, width, height, alpha);
  else if (colorSpace === "DeviceRGB") rgba = rgbaFromRgb(decoded, width, height, alpha);
  else throw new PdfParseError("unsupported-feature", `Unsupported Flate image color space: ${colorSpace ?? "missing"}.`);

  const encodeStart = now();
  const png = await encodeRgbaPng(width, height, rgba);
  timings.pngEncodeMs += now() - encodeStart;
  return png;
}

async function createAssetForStream(
  doc: PdfDocument,
  stream: PdfStream,
  id: string,
  firstPlacement: ImagePlacement,
  warnings: ParseWarning[],
  timings: ImageTimingDiagnostics,
): Promise<MutableImageAsset | undefined> {
  const dimensions = validateDimensions(dictGet(stream.dict, "Width") as number | undefined, dictGet(stream.dict, "Height") as number | undefined, doc.limits);
  if (!dimensions.ok) {
    warnings.push(warning(`Image ${id} was skipped because ${dimensions.reason}.`, firstPlacement.pageNumber));
    return undefined;
  }

  const filters = filterNames(stream.dict);
  try {
    if (filters.length === 1 && (filters[0] === "DCTDecode" || filters[0] === "DCT")) {
      const start = now();
      const bytes = rawStreamBytes(doc, stream);
      timings.jpegPassThroughMs += now() - start;
      timings.imageBytes += bytes.byteLength;
      if (bytes.byteLength > doc.limits.maxDecodedStreamBytes) {
        warnings.push(warning(`JPEG image ${id} exceeds maxDecodedStreamBytes and was skipped.`, firstPlacement.pageNumber));
        return undefined;
      }
      if (!validateJpeg(bytes)) warnings.push(warning(`JPEG image ${id} has an unexpected byte signature; text extraction continues.`, firstPlacement.pageNumber));
      return {
        id,
        pageNumber: firstPlacement.pageNumber,
        width: dimensions.width,
        height: dimensions.height,
        mimeType: "image/jpeg",
        bytes,
        placements: [firstPlacement],
      };
    }

    if (filters.length === 1 && (filters[0] === "FlateDecode" || filters[0] === "Fl")) {
      const bytes = await buildFlatePng(doc, stream, dimensions.width, dimensions.height, timings);
      timings.imageBytes += bytes.byteLength;
      return {
        id,
        pageNumber: firstPlacement.pageNumber,
        width: dimensions.width,
        height: dimensions.height,
        mimeType: "image/png",
        bytes,
        placements: [firstPlacement],
      };
    }

    warnings.push(warning(`Image ${id} uses unsupported filter(s): ${filters.join(", ") || "none"}.`, firstPlacement.pageNumber));
    return undefined;
  } catch (error) {
    warnings.push(warning(`Image ${id} could not be extracted; text extraction continues.`, firstPlacement.pageNumber, error instanceof Error ? error.message : String(error)));
    return undefined;
  }
}

export async function extractPageImages(params: {
  doc: PdfDocument;
  page: PageDescriptor;
  xobjects: XObjectPlacement[];
  assetCache: Map<string, MutableImageAsset>;
  warnings?: ParseWarning[];
  timings?: ImageTimingDiagnostics;
}): Promise<ImageExtractionResult> {
  const { doc, page, xobjects, assetCache } = params;
  const warnings = params.warnings ?? [];
  const timings = params.timings ?? { jpegPassThroughMs: 0, flateImageDecodeMs: 0, pngEncodeMs: 0, imageBytes: 0 };
  const placementImageIds = new Map<string, string>();
  const xobjectDict = await resolveXObjectDict(doc, page);
  if (!xobjectDict) return { assets: [...assetCache.values()], placementImageIds, warnings, timings };

  for (const event of xobjects) {
    await doc.runtime.checkpoint(`page ${page.pageNumber} image extraction`);
    const resourceValue = xobjectDict.map.get(event.name);
    const refKey = isRef(resourceValue) ? `${resourceValue.num}:${resourceValue.gen}` : `p${page.pageNumber}:${event.name}`;
    const assetId = isRef(resourceValue) ? `img-${resourceValue.num}-${resourceValue.gen}` : `p${page.pageNumber}-xobj-${event.name}`;
    const resolved = await doc.resolve(resourceValue);
    if (!isStream(resolved)) continue;
    const subtype = nameOf(dictGet(resolved.dict, "Subtype"));
    if (subtype !== "Image") continue;

    const placement = computePlacement(event);
    let asset = assetCache.get(refKey);
    if (!asset) {
      asset = await createAssetForStream(doc, resolved, assetId, placement, warnings, timings);
      if (asset) assetCache.set(refKey, asset);
    } else {
      asset.placements.push(placement);
    }
    if (asset) placementImageIds.set(placementKey(event), asset.id);
  }

  return { assets: [...assetCache.values()], placementImageIds, warnings, timings };
}

export { placementKey as imagePlacementKey };
