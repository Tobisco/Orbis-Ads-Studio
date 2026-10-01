import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { load } from "cheerio";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 6;
const REQUEST_TIMEOUT_MS = 12_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const ACCEPT_HEADER =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";

function normalizeProductUrl(value: string) {
  const url = new URL(value.trim());
  for (const key of [...url.searchParams.keys()]) {
    if (
      /^utm_/i.test(key) ||
      /^(lv|social_share|ref|tag|linkcode|creativeasin|ascsubtag|sp_csd)$/i.test(key) ||
      /^ref[_-]/i.test(key)
    ) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

function isPublicIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) {
    return false;
  }
  const [first, second, third] = parts;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113)
  );
}

function isPublicIp(address: string) {
  if (isIP(address) === 4) return isPublicIpv4(address);
  if (isIP(address) !== 6) return false;

  const normalized = address.toLowerCase().split("%")[0];
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isPublicIpv4(mappedIpv4);
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

async function assertPublicUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only public http(s) product URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("Product URLs cannot contain embedded credentials.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local network URLs cannot be used for product extraction.");
  }

  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new Error("Local network URLs cannot be used for product extraction.");
    }
    return;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error("Product URL resolves to a non-public address.");
  }
}

async function fetchFollowingRedirects(
  value: string,
  allowBlockedHtml = false,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let currentUrl = value;

  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await assertPublicUrl(currentUrl);
      const response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: ACCEPT_HEADER,
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirectCount === MAX_REDIRECTS) {
          throw new Error("The product URL redirected too many times.");
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok && !allowBlockedHtml) {
        await response.body?.cancel();
        throw new Error(`Product page returned HTTP ${response.status}.`);
      }
      return { response, finalUrl: currentUrl };
    }
    throw new Error("The product URL redirected too many times.");
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedBody(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error("The product page or image is too large to process.");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("The product page or image had no response body.");
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("The product page or image is too large to process.");
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function findProductJsonLd($: ReturnType<typeof load>) {
  const products: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const type = record["@type"];
    const isProductType = (value: unknown) =>
      typeof value === "string" && value.endsWith("Product");
    if (
      (isProductType(type) || (Array.isArray(type) && type.some(isProductType))) &&
      (record.name || record.image)
    ) {
      products.push(record);
    }
    visit(record["@graph"]);
    visit(record.mainEntity);
    visit(record.itemListElement);
  };

  $("script[type='application/ld+json']").each((_, element) => {
    try {
      visit(JSON.parse($(element).text()));
    } catch {
      // Ignore invalid structured-data blocks and keep searching page metadata.
    }
  });
  return products.find((product) => product.image) || products[0] || null;
}

function jsonLdImages(product: Record<string, unknown> | null) {
  const image = product?.image;
  const values = Array.isArray(image) ? image : image ? [image] : [];
  return values.flatMap((value) => {
    if (typeof value === "string") return [value];
    if (typeof value !== "object" || !value) return [];
    const record = value as Record<string, unknown>;
    const url = record.url || record.contentUrl;
    return typeof url === "string" ? [url] : [];
  });
}

function parseDynamicImage(value: string) {
  try {
    const images = JSON.parse(value) as Record<string, number[]>;
    return Object.entries(images)
      .map(([imageUrl, dimensions]) => ({
        imageUrl,
        area: Array.isArray(dimensions) ? Number(dimensions[0]) * Number(dimensions[1]) : 0,
      }))
      .sort((left, right) => right.area - left.area)
      .map(({ imageUrl }) => imageUrl);
  } catch {
    return [];
  }
}

function objectAfterMarker(value: string, marker: RegExp) {
  const match = marker.exec(value);
  if (!match) return null;
  const start = value.indexOf("{", match.index + match[0].length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try {
        return JSON.parse(value.slice(start, index + 1)) as unknown;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function amazonImageCandidates($: ReturnType<typeof load>) {
  const candidates: string[] = [];
  const add = (value?: string) => {
    if (value?.trim()) candidates.push(value.trim());
  };
  const addImage = (image: ReturnType<typeof $>) => {
    add(image.attr("data-old-hires"));
    add(parseDynamicImage(image.attr("data-a-dynamic-image") || "")[0]);
    add(image.attr("src"));
    add(image.attr("data-src"));
  };
  const landingImage = $("#landingImage").first();
  add(landingImage.attr("data-old-hires"));
  parseDynamicImage(landingImage.attr("data-a-dynamic-image") || "").forEach(add);
  add(landingImage.attr("src"));
  $("#imgTagWrapperId img").each((_, element) => addImage($(element)));

  $("script").each((_, element) => {
    const script = $(element).text();
    const colorImages = objectAfterMarker(script, /colorImages\s*=/);
    if (!colorImages || typeof colorImages !== "object") return;
    const record = colorImages as Record<string, unknown>;
    const variants = Array.isArray(record.initial) ? record.initial : Object.values(record);
    variants.forEach((variant) => {
      if (!variant || typeof variant !== "object") return;
      const images = variant as Record<string, unknown>;
      add(typeof images.hiRes === "string" ? images.hiRes : undefined);
      add(typeof images.large === "string" ? images.large : undefined);
    });
  });

  $("#main #imageBlock img, #main img, [data-feature-name='desktop-image-gallery'] img, #imageBlock img")
    .each((_, element) => {
      const image = $(element);
      const width = Number(image.attr("width") || 0);
      const height = Number(image.attr("height") || 0);
      if (width >= 300 || height >= 300 || (!width && !height)) addImage(image);
    });

  return [...new Set(candidates)];
}

function extractMetadata(html: Buffer, finalUrl: string) {
  const $ = load(html);
  const product = findProductJsonLd($);
  const firstMeta = (...selectors: string[]) => {
    for (const selector of selectors) {
      const value = $(selector).first().attr("content")?.trim();
      if (value) return value;
    }
    return "";
  };

  const title =
    firstMeta("meta[property='og:title']", "meta[name='twitter:title']") ||
    String(product?.name || $("title").first().text() || "").trim();
  const description =
    firstMeta(
      "meta[property='og:description']",
      "meta[name='description']",
      "meta[name='twitter:description']",
    ) || String(product?.description || "").trim();
  const metadataImages = [
    "meta[property='og:image:secure_url']",
    "meta[property='og:image']",
    "meta[name='twitter:image']",
    "meta[name='twitter:image:src']",
    "meta[itemprop='image']",
  ].flatMap((selector) => $(selector).toArray().map((element) => $(element).attr("content")?.trim() || "")).filter(Boolean);
  const imageCandidates = [
    ...metadataImages,
    ...jsonLdImages(product),
    ...amazonImageCandidates($),
  ].map((image) => {
    try {
      return new URL(image, finalUrl).toString();
    } catch {
      return "";
    }
  }).filter(Boolean);

  return {
    title: title.replace(/\s+/g, " ").slice(0, 300),
    description: description.replace(/\s+/g, " ").slice(0, 2_000),
    imageCandidates: [...new Set(imageCandidates)],
  };
}

function imageMimeType(response: Response) {
  const fromHeader = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (fromHeader?.startsWith("image/") && fromHeader !== "image/svg+xml") {
    return fromHeader;
  }
  return "";
}

function imageDimensions(bytes: Buffer, mimeType: string) {
  if (mimeType === "image/png" && bytes.length >= 24 && bytes.toString("ascii", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === "image/gif" && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mimeType === "image/webp" && bytes.length >= 30 && bytes.toString("ascii", 12, 16) === "VP8X") {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (mimeType === "image/webp" && bytes.length >= 25 && bytes.toString("ascii", 12, 16) === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + ((bytes[22] >> 6) & 0x03) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
  }
  if (
    mimeType === "image/webp" &&
    bytes.length >= 30 &&
    bytes.toString("ascii", 12, 16) === "VP8 " &&
    bytes.toString("hex", 23, 26) === "9d012a"
  ) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      const segmentLength = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return {
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      }
      if (segmentLength < 2) break;
      offset += segmentLength + 2;
    }
  }
  return null;
}

async function downloadVerifiedImage(value: string) {
  const image = await fetchFollowingRedirects(value);
  if (!image.response.ok) return null;
  const mimeType = imageMimeType(image.response);
  if (!mimeType) {
    await image.response.body?.cancel();
    return null;
  }
  const bytes = await readLimitedBody(image.response, MAX_IMAGE_BYTES);
  const dimensions = imageDimensions(bytes, mimeType);
  if (!dimensions || dimensions.width < 300 || dimensions.height < 300) return null;
  return { bytes, mimeType, finalUrl: image.finalUrl, dimensions };
}

export async function POST(request: Request) {
  let body: { url?: unknown; imageUrl?: unknown };
  try {
    body = (await request.json()) as { url?: unknown };
  } catch {
    return NextResponse.json({ error: "Send a valid product URL." }, { status: 400 });
  }

  const directImageUrl = typeof body.imageUrl === "string" ? body.imageUrl : "";
  if (directImageUrl) {
    if (directImageUrl.length > 4_096) {
      return NextResponse.json({ error: "Send a valid product image URL." }, { status: 400 });
    }
    try {
      const image = await downloadVerifiedImage(directImageUrl);
      if (!image) {
        return NextResponse.json(
          { error: "The URL did not return an image at least 300px wide and tall." },
          { status: 422 },
        );
      }
      return NextResponse.json(
        {
          title: new URL(image.finalUrl).hostname,
          description: "",
          finalUrl: image.finalUrl,
          imageUrl: image.finalUrl,
          mimeType: image.mimeType,
          imageBase64: image.bytes.toString("base64"),
        },
        { headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : "Product image extraction failed.";
      const status = error.includes("non-public") || error.includes("Local network") ? 400 : 502;
      return NextResponse.json({ error }, { status });
    }
  }

  if (typeof body.url !== "string" || body.url.length > 4_096) {
    return NextResponse.json({ error: "Send a valid product URL." }, { status: 400 });
  }

  try {
    const normalizedUrl = normalizeProductUrl(body.url);
    await assertPublicUrl(normalizedUrl);
    const page = await fetchFollowingRedirects(normalizedUrl, true);
    const html = await readLimitedBody(page.response, MAX_PAGE_BYTES);
    const htmlText = html.toString("utf8");
    const hostname = new URL(page.finalUrl).hostname.toLowerCase();
    const isAmazon = hostname === "amazon.com" || hostname.endsWith(".amazon.com") || hostname === "a.co";
    const looksBlocked = isAmazon && (
      page.response.status === 503 ||
      /robot check|api-services-support@amazon/i.test(htmlText) ||
      html.byteLength < 1_024
    );
    console.info("[product-extract] Page response", {
      finalUrl: page.finalUrl,
      httpStatus: page.response.status,
      responseLength: html.byteLength,
      looksLikeBotOrCaptcha: looksBlocked,
    });
    if (looksBlocked) {
      return NextResponse.json(
        { error: "Amazon blocked the request. Paste a direct product image URL to continue.", blocked: true },
        { status: 502 },
      );
    }
    if (!page.response.ok) {
      return NextResponse.json(
        { error: `Product page returned HTTP ${page.response.status}.` },
        { status: 502 },
      );
    }
    const pageMimeType = page.response.headers.get("content-type") || "";
    if (!pageMimeType.includes("text/html") && !pageMimeType.includes("application/xhtml+xml")) {
      return NextResponse.json(
        { error: "The URL did not resolve to a product page." },
        { status: 422 },
      );
    }

    const metadata = extractMetadata(html, page.finalUrl);
    if (!metadata.imageCandidates.length) {
      return NextResponse.json(
        { error: "No product image was found on this page." },
        { status: 422 },
      );
    }

    let verifiedImage: Awaited<ReturnType<typeof downloadVerifiedImage>> = null;
    for (const candidate of metadata.imageCandidates) {
      try {
        verifiedImage = await downloadVerifiedImage(candidate);
      } catch {
        verifiedImage = null;
      }
      if (verifiedImage) break;
    }
    if (!verifiedImage) {
      return NextResponse.json(
        { error: "No usable product image at least 300px wide and tall could be downloaded." },
        { status: 422 },
      );
    }

    return NextResponse.json(
      {
        title: metadata.title || new URL(page.finalUrl).hostname,
        description: metadata.description,
        finalUrl: page.finalUrl,
        imageUrl: verifiedImage.finalUrl,
        mimeType: verifiedImage.mimeType,
        imageBase64: verifiedImage.bytes.toString("base64"),
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : "Product extraction failed.";
    const status = error.includes("non-public") || error.includes("Local network") ? 400 : 502;
    return NextResponse.json({ error }, { status });
  }
}