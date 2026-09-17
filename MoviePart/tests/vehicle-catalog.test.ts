import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ProductCatalog } from "../src/server/catalog";
import { LocalMediaRepository } from "../src/server/media";
import { uploadProductReferences } from "../src/server/product-upload";
import { vehicleCatalogFolder, vehicleChoices } from "../src/catalog/vehicles";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "movie-vehicle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new ProductCatalog(directory, new LocalMediaRepository(directory), null);
}
async function image(color: string) {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: color } }).png().toBuffer();
}
function upload(exterior: Uint8Array, interior: Uint8Array, permissionConfirmed = true) {
  const form = new FormData();
  form.append("exterior", new File([Buffer.from(exterior)], "exterior.png", { type: "image/png" }));
  form.append("interior", new File([Buffer.from(interior)], "interior.png", { type: "image/png" }));
  form.append("metadata", JSON.stringify({
    permissionConfirmed, source: "Operator-owned synthetic test shapes", exteriorColor: "Red", interiorColor: "Black",
  }));
  return new Request("http://localhost:3200/api/movie-products/test/references", { method: "POST", body: form });
}

test("Toyota and Lexus vehicles are selectable but not ready without reference packs", async t => {
  const catalog = await fixture(t);
  assert.deepEqual(await catalog.list(), vehicleChoices.map(({ id, name }) => ({ id, name, ready: false })));
  assert.ok(vehicleChoices.every(vehicle => vehicle.make === "Toyota" || vehicle.make === "Lexus"));
  assert.ok(vehicleChoices.some(vehicle => vehicle.id === "toyota-bz"));
  assert.ok(vehicleChoices.some(vehicle => vehicle.id === "lexus-rz"));
  await assert.rejects(catalog.getProduct("toyota-camry"), /missing/);
});

test("every checked-in Toyota and Lexus reference folder is complete and catalog-valid", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "movie-bundled-vehicles-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../vehicle-catalog", import.meta.url));
  const folders = (await readdir(source, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.deepEqual(folders.sort(), vehicleChoices.map(vehicleCatalogFolder).sort());
  const catalog = new ProductCatalog(directory, new LocalMediaRepository(directory));
  assert.ok((await catalog.list()).every(product => product.ready));
  for (const vehicle of vehicleChoices) {
    const product = await catalog.getProduct(vehicle.id);
    assert.equal(product.make, vehicle.make);
    assert.equal(product.model, vehicle.model);
    assert.equal(product.referenceImages.length, 2);
    assert.ok(product.referenceImages.some(reference => reference.role === "interior"));
  }
});

test("authorized exterior/interior uploads create distinct durable Toyota and Lexus packs", async t => {
  const catalog = await fixture(t);
  await uploadProductReferences(upload(await image("red"), await image("black")), "toyota-camry", catalog);
  await uploadProductReferences(upload(await image("blue"), await image("gray")), "lexus-lc", catalog);
  const camry = await catalog.getProduct("toyota-camry");
  const lexus = await catalog.getProduct("lexus-lc");
  assert.equal(camry.model, "Camry");
  assert.equal(lexus.model, "LC");
  assert.deepEqual(camry.approvedClaims, []);
  assert.deepEqual(lexus.approvedClaims, []);
  assert.equal(camry.referenceImages.length, 2);
  assert.ok(camry.referenceImages.some(reference => reference.role === "interior"));
  assert.notDeepEqual(camry.referenceImages, lexus.referenceImages);
  assert.deepEqual((await catalog.getProduct("toyota-camry")).referenceImages, camry.referenceImages);
  assert.equal((await catalog.list()).filter(product => product.ready).length, 2);
});

test("missing rights, duplicate images, missing interior or unsupported vehicle fail before readiness", async t => {
  const catalog = await fixture(t);
  const red = await image("red");
  await assert.rejects(uploadProductReferences(upload(red, await image("black"), false), "toyota-camry", catalog), /permission/);
  await assert.rejects(uploadProductReferences(upload(red, red), "toyota-camry", catalog), /distinct/);
  await assert.rejects(uploadProductReferences(upload(red, await image("black")), "unsupported-car", catalog), /Toyota or Lexus/);
  const missing = new FormData();
  missing.append("exterior", new File([Uint8Array.from(red)], "exterior.png", { type: "image/png" }));
  await assert.rejects(uploadProductReferences(new Request("http://localhost/upload", { method: "POST", body: missing }), "toyota-camry", catalog), /interior/);
  assert.ok((await catalog.list()).every(product => !product.ready));
});
