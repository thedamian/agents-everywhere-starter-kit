import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../src/app/kiosk/manifest.webmanifest/route";
import { metadata, viewport } from "../src/app/kiosk/layout";

test("the explicitly routed iPad manifest returns the correct MIME, scope and full-screen colors", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/manifest+json");
  const manifest = await response.json();
  assert.equal(manifest.start_url, "/kiosk");
  assert.equal(manifest.scope, "/kiosk");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "any");
  assert.equal(manifest.background_color, "#202a25");
  assert.equal(manifest.theme_color, "#202a25");
  assert.equal(metadata.manifest, "/kiosk/manifest.webmanifest");
  assert.equal(viewport.viewportFit, "cover");
  assert.equal(viewport.interactiveWidget, "resizes-content");
});
