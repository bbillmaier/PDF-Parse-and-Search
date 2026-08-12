import type {
  DocumentAsset,
  DocumentBlock,
  DocumentImage,
  DocumentPage,
  LinkTarget,
  ParsedDocument,
  TextRun,
} from "../types.ts";
import { isSafeSemanticId } from "../navigation.ts";

export interface HtmlRendererClassHooks {
  article?: string;
  page?: (page: DocumentPage) => string | undefined;
  block?: (block: DocumentBlock) => string | undefined;
}

export interface HtmlRendererOptions {
  includePageSections?: boolean;
  pageSectionId?: (page: DocumentPage) => string | undefined;
  blockId?: (block: DocumentBlock) => string | undefined;
  classes?: HtmlRendererClassHooks;
  resolveAssetUrl?: (asset: DocumentImage) => string | undefined;
  renderUnsupportedImages?: boolean;
  allowedLinkProtocols?: string[];
}

export interface RenderedHtml {
  html: string;
  cleanup(): void;
}

const DEFAULT_PROTOCOLS = ["http:", "https:", "mailto:"];

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function attrs(values: Record<string, string | undefined | false>): string {
  let out = "";
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    out += ` ${name}="${escapeAttr(value)}"`;
  }
  return out;
}

function safeExternalHref(href: string, allowed: string[]): string | undefined {
  try {
    const url = new URL(href, "https://example.invalid");
    return allowed.includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function hrefFor(target: LinkTarget, allowed: string[]): string | undefined {
  if (target.kind === "internal") return `#page-${target.pageNumber}`;
  return safeExternalHref(target.href, allowed);
}

function renderRuns(runs: TextRun[], options: Required<Pick<HtmlRendererOptions, "allowedLinkProtocols">>): string {
  return runs
    .map((run) => {
      const text = escapeText(run.text);
      if (!run.link) return text;
      const href = hrefFor(run.link, options.allowedLinkProtocols);
      if (!href) return text;
      return `<a${attrs({ href, rel: run.link.kind === "external" ? "noopener noreferrer" : undefined })}>${text}</a>`;
    })
    .join("");
}

function renderBlocks(blocks: DocumentBlock[], assets: Map<string, DocumentImage>, options: HtmlRendererOptions): string {
  const linkOptions = { allowedLinkProtocols: options.allowedLinkProtocols ?? DEFAULT_PROTOCOLS };
  return blocks.map((block) => renderBlock(block, assets, options, linkOptions)).join("");
}

function blockAttrs(block: DocumentBlock, options: HtmlRendererOptions): string {
  const id = options.blockId?.(block) ?? block.id;
  return attrs({
    id: isSafeSemanticId(id) ? id : undefined,
    class: options.classes?.block?.(block),
    "data-page": String(block.pageNumber),
    "data-section": block.sectionId,
  });
}

function renderBlock(
  block: DocumentBlock,
  assets: Map<string, DocumentImage>,
  options: HtmlRendererOptions,
  linkOptions: Required<Pick<HtmlRendererOptions, "allowedLinkProtocols">>,
): string {
  switch (block.type) {
    case "heading": {
      const tag = `h${block.level}`;
      return `<${tag}${blockAttrs(block, options)}>${renderRuns(block.text, linkOptions)}</${tag}>`;
    }
    case "paragraph":
      return `<p${blockAttrs(block, options)}>${renderRuns(block.text, linkOptions)}</p>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items
        .map((item) => `<li${attrs({ id: isSafeSemanticId(item.id) ? item.id : undefined, "data-page": String(block.pageNumber), "data-section": block.sectionId })}>${renderBlocks(item.blocks, assets, options)}</li>`)
        .join("");
      return `<${tag}${blockAttrs(block, options)}>${items}</${tag}>`;
    }
    case "table": {
      const rows = block.rows
        .map((row) => {
          const cells = row.cells
            .map((cell) => {
              const tag = cell.isHeader ? "th" : "td";
              return `<${tag}${attrs({
                id: isSafeSemanticId(cell.id) ? cell.id : undefined,
                "data-page": String(cell.pageNumber),
                "data-section": cell.sectionId ?? block.sectionId,
                colspan: cell.colSpan > 1 ? String(cell.colSpan) : undefined,
                rowspan: cell.rowSpan > 1 ? String(cell.rowSpan) : undefined,
              })}>${renderBlocks(cell.blocks, assets, options)}</${tag}>`;
            })
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      return `<table${blockAttrs(block, options)}><tbody>${rows}</tbody></table>`;
    }
    case "figure": {
      const asset = assets.get(block.imageId);
      const img = asset
        ? `<img${attrs({ src: options.resolveAssetUrl?.(asset), alt: block.altText ?? "" })}>`
        : options.renderUnsupportedImages
          ? `<div role="img"${attrs({ "aria-label": block.altText ?? "Unsupported PDF image" })}></div>`
          : "";
      const caption = block.caption && block.caption.length > 0 ? `<figcaption>${renderRuns(block.caption, linkOptions)}</figcaption>` : "";
      return `<figure${blockAttrs(block, options)}>${img}${caption}</figure>`;
    }
    case "unknown":
      return options.renderUnsupportedImages ? `<div${blockAttrs(block, options)}>${escapeText(block.reason)}</div>` : "";
  }
}

export function renderDocumentToHtml(document: ParsedDocument, options: HtmlRendererOptions = {}): string {
  const assets = new Map(document.assets.map((asset) => [asset.id, asset]));
  const articleClass = options.classes?.article;
  const body = options.includePageSections === false
    ? renderBlocks(document.pages.flatMap((page) => page.blocks), assets, options)
    : document.pages
        .map((page) => {
          const sectionId = options.pageSectionId?.(page) ?? `page-${page.pageNumber}`;
          return `<section${attrs({ id: sectionId, class: options.classes?.page?.(page), "data-page": String(page.pageNumber) })}>${renderBlocks(page.blocks, assets, options)}</section>`;
        })
        .join("");
  return `<article${attrs({ class: articleClass })}>${body}</article>`;
}

export function createObjectUrlResolver(assets: DocumentAsset[]): { resolveAssetUrl(asset: DocumentImage): string; cleanup(): void } {
  const urls = new Map<string, string>();
  const assetSet = new Set(assets.map((asset) => asset.id));
  return {
    resolveAssetUrl(asset) {
      if (!assetSet.has(asset.id)) return "";
      const existing = urls.get(asset.id);
      if (existing) return existing;
      const url = URL.createObjectURL(new Blob([asset.bytes.buffer as ArrayBuffer], { type: asset.mimeType }));
      urls.set(asset.id, url);
      return url;
    },
    cleanup() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}

export function renderDocumentToDisposableHtml(document: ParsedDocument, options: Omit<HtmlRendererOptions, "resolveAssetUrl"> = {}): RenderedHtml {
  const resolver = createObjectUrlResolver(document.assets);
  return {
    html: renderDocumentToHtml(document, { ...options, resolveAssetUrl: resolver.resolveAssetUrl }),
    cleanup: resolver.cleanup,
  };
}
