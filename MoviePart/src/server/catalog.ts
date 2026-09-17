import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MovieError, productSchema, type ProductReference } from "../domain";
import { atomicWrite, isMissing } from "./files";
import { LocalMediaRepository, MAX_IMAGE_BYTES } from "./media";
import { vehicleCatalogFolder, vehicleChoice, vehicleChoices } from "../catalog/vehicles";
import type { ConfigView } from "../domain/http";

const catalogSchema = productSchema.omit({ referenceImages: true }).extend({
  images: z.array(z.object({
    file: z.string().min(1).max(200),
    role: z.string().min(1).max(80),
  }).strict()).min(2).max(8),
}).strict().superRefine((value, ctx) => {
  if (!value.images.some(image => /interior/i.test(image.role))) {
    ctx.addIssue({ code: "custom", message: "An interior reference is required." });
  }
  if (new Set(value.images.map(image => image.file.toLowerCase())).size !== value.images.length) {
    ctx.addIssue({ code: "custom", message: "References must be unique." });
  }
});

export function catalogFile(directory: string, file: string): string {
  if (path.isAbsolute(file) || file.includes(":") || file.includes("\\") || file.includes("/") || file === "." || file === "..") {
    throw new MovieError("INVALID_CATALOG", "Catalog images must be plain filenames within the catalog directory.", 503);
  }
  return path.join(directory, file);
}

export class ProductCatalog {
  readonly directory: string;
  private readonly bundledDirectory: string | null;
  constructor(dataDir: string, private readonly media: LocalMediaRepository, bundledDirectory: string | null = path.resolve("vehicle-catalog")) {
    this.directory = path.join(path.resolve(dataDir), "catalog");
    this.bundledDirectory = bundledDirectory;
  }

  async load(): Promise<{ product: ProductReference | null; warning: string | null }> {
    return this.loadDirectory(this.directory);
  }

  private async isReadyDirectory(directory: string, expectedId: string): Promise<boolean> {
    try {
      const manifest = path.join(directory, "product.json");
      const root = await realpath(directory);
      if (path.dirname(await realpath(manifest)).toLowerCase() !== root.toLowerCase()) return false;
      if ((await stat(manifest)).size > 64 * 1024) return false;
      const input = catalogSchema.parse(JSON.parse(await readFile(manifest, "utf8")));
      if (input.id !== expectedId) return false;
      for (const image of input.images) {
        const filename = await realpath(catalogFile(root, image.file));
        if (path.dirname(filename).toLowerCase() !== root.toLowerCase()) return false;
        const info = await stat(filename);
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async loadDirectory(directory: string): Promise<{ product: ProductReference | null; warning: string | null }> {
    try {
      const manifest = path.join(directory, "product.json");
      const root = await realpath(directory);
      if (path.dirname(await realpath(manifest)).toLowerCase() !== root.toLowerCase()) throw new Error("Catalog escape");
      if ((await stat(manifest)).size > 64 * 1024) throw new Error("Catalog too large");
      const input = catalogSchema.parse(JSON.parse(await readFile(manifest, "utf8")));
      const referenceImages: ProductReference["referenceImages"] = [];
      for (const image of input.images) {
        const filename = await realpath(catalogFile(root, image.file));
        if (path.dirname(filename).toLowerCase() !== root.toLowerCase()) throw new Error("Catalog escape");
        const info = await stat(filename);
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error("Invalid image");
        const asset = await this.media.saveProduct(await readFile(filename));
        referenceImages.push({ assetId: asset.id, role: image.role, origin: "original" });
      }
      if (new Set(referenceImages.map(image => image.assetId)).size !== referenceImages.length) throw new Error("Duplicate product images");
      const { images: _, ...metadata } = input;
      return { product: productSchema.parse({ ...metadata, referenceImages }), warning: null };
    } catch (error) {
      return {
        product: null,
        warning: isMissing(error)
          ? "Product catalog or reference images are missing. Add a permitted exterior/interior reference pack to the local catalog."
          : "Product catalog is invalid. Check product.json metadata, usage permission, and 2–8 unique local images including an interior reference.",
      };
    }
  }

  async list(): Promise<ConfigView["products"]> {
    return Promise.all(vehicleChoices.map(async choice => ({
      id: choice.id,
      name: choice.name,
      ready: await this.isReadyDirectory(path.join(this.directory, choice.id), choice.id)
        || await this.isReadyDirectory(this.directory, choice.id)
        || !!this.bundledDirectory && await this.isReadyDirectory(path.join(this.bundledDirectory, vehicleCatalogFolder(choice)), choice.id),
    })));
  }

  async install(input: {
    id: string; exteriorColor: string; interiorColor: string | null; permission: string;
    exterior: Uint8Array; interior: Uint8Array;
  }): Promise<ProductReference> {
    const choice = vehicleChoice(input.id);
    if (!choice) throw new MovieError("UNKNOWN_PRODUCT", "Choose a supported Toyota or Lexus vehicle.", 400);
    const [exterior, interior] = await Promise.all([
      this.media.saveProduct(input.exterior), this.media.saveProduct(input.interior),
    ]);
    if (exterior.id === interior.id) throw new MovieError("DUPLICATE_PHOTO", "Use distinct exterior and interior vehicle photographs.", 400);
    const directory = path.join(this.directory, choice.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const manifest = catalogSchema.parse({
      id: choice.id, version: 1, name: choice.name, make: choice.make, model: choice.model,
      exteriorColor: input.exteriorColor, interiorColor: input.interiorColor, appearance: choice.appearance,
      approvedClaims: [], usagePermission: input.permission,
      images: [
        { file: `${exterior.id}.jpg`, role: "front_three_quarter" },
        { file: `${interior.id}.jpg`, role: "interior" },
      ],
    });
    await atomicWrite(path.join(directory, manifest.images[0].file), input.exterior);
    await atomicWrite(path.join(directory, manifest.images[1].file), input.interior);
    // Publish the complete pack last so existing jobs never observe half an update.
    await atomicWrite(path.join(directory, "product.json"), JSON.stringify(manifest));
    return productSchema.parse({
      ...choice, version: 1, exteriorColor: input.exteriorColor, interiorColor: input.interiorColor,
      approvedClaims: [], usagePermission: input.permission,
      referenceImages: [
        { assetId: exterior.id, role: "front_three_quarter", origin: "original" },
        { assetId: interior.id, role: "interior", origin: "original" },
      ],
    });
  }

  async getProduct(id: string): Promise<ProductReference> {
    let result = vehicleChoice(id) ? await this.loadDirectory(path.join(this.directory, id)) : await this.load();
    if (!result.product && vehicleChoice(id)) {
      const legacy = await this.load();
      if (legacy.product?.id === id) result = legacy;
    }
    const choice = vehicleChoice(id);
    if (!result.product && choice && this.bundledDirectory) {
      result = await this.loadDirectory(path.join(this.bundledDirectory, vehicleCatalogFolder(choice)));
    }
    if (!result.product || result.product.id !== id) {
      throw new MovieError("PRODUCT_NOT_READY", result.warning ?? "The selected product is not configured.", 503);
    }
    return result.product;
  }
}
