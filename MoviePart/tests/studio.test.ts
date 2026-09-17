import test from "node:test";
import assert from "node:assert/strict";
import { mainStoryboardFrames } from "../src/lib/storyboard-view";
import type { StoryboardFrame } from "../integration/contracts";
import { creationBlockers, selectableProducts } from "../src/lib/studio-readiness";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MovieRecovery } from "../src/components/movie-recovery";
import type { JobView } from "../integration/contracts";
import { vehicleChoices } from "../src/catalog/vehicles";

test("studio shows four current frames, not extra hero end frames or rejected attempts", () => {
  const frame = (shotId: string, assetId: string): StoryboardFrame => ({
    shotId, assetId, continuity: { verdict: "PASS", reasons: [], confidence: 0.9 }, provider: "test", model: "test",
  });
  const result = mainStoryboardFrames([
    frame("shot_01", "old"), frame("shot_02", "two"), frame("shot_03", "three"),
    frame("shot_04", "four"), frame("shot_01", "new"), frame("shot_03_end", "end"),
  ]);
  assert.deepEqual(result.map(value => value.assetId), ["new", "two", "three", "four"]);
  assert.equal(mainStoryboardFrames([]).length, 0);
});
test("six-shot view keeps all narrative frames and excludes supplemental end frames", () => {
  const ids = ["shot_01", "shot_02", "shot_03", "shot_04", "shot_05", "shot_06"];
  const frames: StoryboardFrame[] = [...ids, "shot_04_end"].map(shotId => ({
    shotId, assetId: shotId, continuity: { verdict: "PASS", reasons: [], confidence: 1 }, provider: "test", model: "test",
  }));
  assert.deepEqual(mainStoryboardFrames(frames, ids).map(frame => frame.shotId), ids);
});

test("the Toyota and Lexus lineup remains selectable before the server configuration loads", () => {
  assert.deepEqual(selectableProducts(null).map(product => product.name), vehicleChoices.map(product => product.name));
  assert.ok(selectableProducts(null).every(product => !product.ready));
});

test("the selector never exposes products outside the downloaded Toyota and Lexus list", () => {
  const products = selectableProducts({
    products: [
      { id: "toyota-camry", name: "Toyota Camry", ready: true },
      { id: "operator-custom", name: "Operator custom", ready: true },
    ],
    templates: [],
    providers: { openai: { available: true, message: "Ready" }, veo: { available: true, message: "Ready" } },
    worker: { available: true, message: "Ready" }, renderer: { available: true, message: "Ready" },
  });
  assert.equal(products.some(product => product.id === "operator-custom"), false);
  assert.deepEqual(products.map(product => product.id), vehicleChoices.map(product => product.id));
});

test("creation explains every missing prerequisite instead of silently disabling the button", () => {
  const missing = creationBlockers({
    config: null, productId: "toyota-camry", needsPhotos: true,
    photoCount: 0, generationConsent: false, personalizationConsent: false,
  });
  assert.equal(missing.length, 5);
  assert.match(missing.join(" "), /temporarily unavailable/);
  assert.match(missing.join(" "), /Reconnect/);
  assert.deepEqual(creationBlockers({
    config: {
      products: [{ id: "toyota-camry", name: "Toyota Camry", ready: true }], templates: [],
      providers: { openai: { available: true, message: "Ready" }, veo: { available: false, message: "Optional" } },
      worker: { available: true, message: "Ready" }, renderer: { available: true, message: "Ready" },
    },
    productId: "toyota-camry", needsPhotos: false, photoCount: 0,
    generationConsent: true, personalizationConsent: true,
  }), []);
});

test("a prior approved shot is retained even when a later rejected candidate exists", () => {
  const frames: StoryboardFrame[] = [
    { shotId: "shot_01", assetId: "approved", continuity: { verdict: "PASS", reasons: [], confidence: 1 }, provider: "test", model: "test" },
    { shotId: "shot_01", assetId: "rejected", continuity: { verdict: "RETRY", reasons: ["Wrong background"], confidence: 1 }, provider: "test", model: "test" },
  ];
  assert.equal(mainStoryboardFrames(frames)[0].assetId, "approved");
});

test("failed-movie recovery is explicit, explains retained shots and costs, and disables duplicate clicks", () => {
  const job: JobView = {
    id: "job", sessionId: "session", status: "FAILED", createdAt: "", updatedAt: "",
    events: [], warnings: [], error: null, character: null, plan: null, frames: [], hero: null, result: null,
    retry: { attempt: 0, eligible: true, approvedShots: 2, remainingShots: 4 },
  };
  let called = false;
  const props = { job, retrying: false, disabled: false, onRetry: () => { called = true; } };
  const html = renderToStaticMarkup(createElement(MovieRecovery, props));
  assert.match(html, /Retry failed and remaining shots/);
  assert.match(html, /2 approved shots/);
  assert.match(html, /4 failed or missing shots/);
  assert.match(html, /API charges/);
  assert.match(html, /only when every required shot is approved/);
  assert.equal(called, false);
  const inFlight = renderToStaticMarkup(createElement(MovieRecovery, { ...props, retrying: true }));
  assert.match(inFlight, /disabled=""/);
  assert.match(inFlight, /Requesting retry/);
  assert.equal(renderToStaticMarkup(createElement(MovieRecovery, { ...props, job: { ...job, status: "COMPLETED" } })), "");
  const assembly = renderToStaticMarkup(createElement(MovieRecovery, {
    ...props, job: { ...job, retry: { attempt: 1, eligible: true, approvedShots: 6, remainingShots: 0 } },
  }));
  assert.match(assembly, /Retry final assembly/);
  assert.match(assembly, /No storyboard images or director plan will be regenerated/);
});

test("continuity recovery offers bounded paid replacement before explicit image-motion fallback", () => {
  const base: JobView = {
    id: "job", sessionId: "session", status: "FAILED", createdAt: "", updatedAt: "",
    events: [], warnings: [], error: { code: "VEO_CONTINUITY_REJECTED", message: "Rejected", stage: "GENERATING_HERO" },
    character: null, plan: null, frames: [], hero: null, result: null,
    retry: {
      attempt: 0, eligible: true, approvedShots: 4, remainingShots: 0,
      videoRecovery: {
        replacementAttempts: 0, maxReplacementAttempts: 2, rejectedSegment: 2,
        veoSubmissionUncertain: false, replacementAvailable: true, imageMotionAvailable: false,
      },
    },
  };
  const replacement = renderToStaticMarkup(createElement(MovieRecovery, {
    job: base, retrying: false, disabled: false, onRetry: () => {}, onReplaceClip: () => {},
  }));
  assert.match(replacement, /Replace animation clip 3/);
  assert.match(replacement, /Replacement attempt 1 of 2/);
  assert.match(replacement, /another paid provider request/);
  assert.match(replacement, /explicitly authorize replacement 1 of 2/);
  assert.doesNotMatch(replacement, /Sora 2 Pro/);
  assert.doesNotMatch(replacement, /replacement limit is exhausted/);
  assert.doesNotMatch(replacement, /Resume animation and assembly/);

  const fallback = renderToStaticMarkup(createElement(MovieRecovery, {
    job: {
      ...base,
      retry: {
        ...base.retry!, videoRecovery: {
          replacementAttempts: 2, maxReplacementAttempts: 2, rejectedSegment: 2,
          veoSubmissionUncertain: false, replacementAvailable: false, imageMotionAvailable: true,
        },
      },
    },
    retrying: false, disabled: false, onRetry: () => {}, onUseImageMotion: () => {},
  }));
  assert.match(fallback, /Both replacement attempts have been used/);
  assert.match(fallback, /Use image motion instead/);
  assert.match(fallback, /rather than generated footage/);
  assert.doesNotMatch(fallback, /Sora 2 Pro/);
  assert.doesNotMatch(fallback, /Generate replacement clip/);
});

test("uncertain Veo submission offers only an explicit bounded Veo replacement", () => {
  const job: JobView = {
    id: "job", sessionId: "session", status: "FAILED", createdAt: "", updatedAt: "",
    events: [], warnings: [],
    error: { code: "VEO_WORKFLOW_FAILED", message: "Submission did not return an operation ID.", stage: "GENERATING_HERO" },
    character: null, plan: null, frames: [], hero: null, result: null,
    retry: {
      attempt: 0, eligible: true, approvedShots: 4, remainingShots: 0,
      videoRecovery: {
        replacementAttempts: 0, maxReplacementAttempts: 2, veoSubmissionUncertain: true,
        replacementAvailable: true, imageMotionAvailable: false,
      },
    },
  };
  const html = renderToStaticMarkup(createElement(MovieRecovery, {
    job, retrying: false, disabled: false, onRetry: () => {}, onReplaceClip: () => {},
  }));
  assert.match(html, /returned no operation ID/);
  assert.match(html, /explicitly authorize replacement attempt 1 of 2/);
  assert.match(html, /may also have been charged/);
  assert.doesNotMatch(html, /Sora 2 Pro/);
  assert.match(html, /Generate replacement clip/);
  assert.doesNotMatch(html, /Use image motion instead/);
});
