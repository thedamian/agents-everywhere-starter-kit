import assert from "node:assert/strict";
import test from "node:test";

// Launcher configuration is deliberately independent from either application's runtime.
const { integrationEnvironments, launchOptions, studioReady, apiReady } = await import("../scripts/kiosk-config.mjs");

test("kiosk launcher defaults to distinct loopback ports and validates overrides", () => {
  assert.deepEqual(launchOptions([]), {
    liveMedia: false, liveStudio: false, liveVoice: false, googleCalendar: false, windowsBridge: false,
    apiPort: 3101, uiPort: 3200, mediaPort: 3201, publicOrigin: undefined, startupTimeoutMs: 300_000,
  });
  assert.equal(launchOptions(["--ui-port", "3202"]).uiPort, 3202);
  assert.throws(() => launchOptions(["--ui-port", "3101"]), /distinct/);
  assert.throws(() => launchOptions(["--ui-port", "0"]), /port/);
  assert.throws(() => launchOptions(["--unknown"]), /Unsupported/);
  assert.throws(() => launchOptions(["--live-media", "--live-studio"]), /not both/);
  assert.equal(launchOptions(["--startup-timeout-ms", "600000"]).startupTimeoutMs, 600000);
  for (const timeout of ["0", "29999", "600001", "Infinity", "wrong"]) {
    assert.throws(() => launchOptions(["--startup-timeout-ms", timeout]), /startup timeout/);
  }
  for (const origin of ["http://192.168.1.5:3202", "https://user:pass@kiosk.test", "https://kiosk.test/path", "*"]) {
    assert.throws(() => launchOptions(["--public-origin", origin]), /trusted HTTPS/);
  }
});

test("offline kiosk mode isolates inherited credentials and configures the actual UI origin", () => {
  const environment = integrationEnvironments({
    options: launchOptions(["--ui-port", "3202"]),
    parent: {
      PATH: "test-path", OPENAI_API_KEY: "must-not-leak", GH_TOKEN: "must-not-leak", NODE_OPTIONS: "must-not-propagate",
      NEXT_PUBLIC_PRIVATE_VALUE: "must-not-leak", CALENDAR_PROVIDER: "google", SHOWROOM_BRIDGE_ENABLED: "true",
      GOOGLE_REFRESH_TOKEN: "must-not-leak", VOICE_ENABLED: "true", NEW_PROVIDER_CREDENTIAL: "must-not-leak",
    },
    finalEnv: { BRIEF_PROVIDER: "openai", PROFILE_PROVIDER: "exa", MEDIA_SERVICE_TOKEN: "ignored" },
    movieEnv: { OPENAI_API_KEY: "ignored", GOOGLE_API_KEY: "ignored" },
    deviceToken: "test-device-capability", mediaToken: "test-service-capability",
  });
  assert.equal(environment.api.MOCK_ONLY, "true");
  assert.equal(environment.api.MEDIA_PROVIDER, "mock");
  assert.equal(environment.api.ALLOWED_ORIGINS, "http://127.0.0.1:3101,http://127.0.0.1:3202");
  assert.equal(environment.api.OPENAI_API_KEY, "");
  assert.equal(environment.ui.OPENAI_API_KEY, "");
  assert.equal(environment.ui.GOOGLE_API_KEY, "");
  assert.equal(environment.ui.MEDIA_SERVICE_TOKEN, "");
  assert.equal(environment.ui.GH_TOKEN, undefined);
  assert.equal(environment.ui.NODE_OPTIONS, undefined);
  assert.equal(environment.ui.DEMO_DEVICE_TOKEN, undefined);
  assert.equal(environment.api.MEDIA_SERVICE_TOKEN, "");
  assert.equal(environment.api.CALENDAR_PROVIDER, "disabled");
  assert.equal(environment.api.SHOWROOM_BRIDGE_ENABLED, "false");
  assert.equal(environment.api.VOICE_ENABLED, "false");
  assert.equal(environment.api.SHOWROOM_MODE, "fixture");
  assert.equal(environment.ui.SHOWROOM_API_UPSTREAM, "http://127.0.0.1:3101");
  assert.equal(environment.ui.SHOWROOM_PUBLIC_ORIGIN, "http://127.0.0.1:3202");
  assert.equal(environment.ui.__NEXT_PROCESSED_ENV, "true");
  for (const env of [environment.api, environment.ui, environment.worker, environment.media]) {
    assert.equal(env.PATH, "test-path");
    assert.equal(env.NEXT_PUBLIC_PRIVATE_VALUE, undefined);
    assert.equal(env.NEW_PROVIDER_CREDENTIAL, undefined);
    assert.equal(env.GOOGLE_REFRESH_TOKEN, "");
  }
});

test("live media is opt-in and forwards the provider key only to the media server", () => {
  const options = launchOptions(["--live-media"]);
  assert.throws(() => integrationEnvironments({ options, parent: {}, deviceToken: "device", mediaToken: "service" }), /MoviePart/);
  const env = integrationEnvironments({
    options, parent: {}, movieEnv: { OPENAI_API_KEY: "fake-test-only", OPENAI_IMAGE_MODEL: "chosen-model" },
    deviceToken: "device", mediaToken: "service",
  });
  assert.equal(env.api.MEDIA_PROVIDER, "http");
  assert.equal(env.api.MEDIA_SERVICE_TOKEN, env.media.MEDIA_SERVICE_TOKEN);
  assert.equal(env.media.OPENAI_API_KEY, "fake-test-only");
  assert.equal(env.ui.OPENAI_API_KEY, "");
  assert.equal(env.api.OPENAI_API_KEY, "");
  assert.equal(env.api.BRIEF_PROVIDER, "mock");
});

test("voice can be live with mock film and disabled calendar without sharing its key", () => {
  const options = launchOptions(["--live-voice", "--ui-port", "3202", "--public-origin", "https://kiosk.example.test"]);
  assert.throws(() => integrationEnvironments({ options, parent: {}, deviceToken: "device", mediaToken: "media" }), /Live voice/);
  const env = integrationEnvironments({
    options, parent: {}, finalEnv: { OPENAI_API_KEY: "fake-voice-key", VOICE_MODEL: "configured-voice" },
    deviceToken: "device", mediaToken: "media",
  });
  assert.equal(env.api.OPENAI_API_KEY, "fake-voice-key");
  assert.equal(env.api.VOICE_MODEL, "configured-voice");
  assert.equal(env.api.REGULAR_MODEL, "gpt-5.6-luna");
  assert.equal(env.api.REASONING_MODEL, "gpt-5.6-luna");
  assert.equal(env.api.MEDIA_PROVIDER, "mock");
  assert.equal(env.api.SHOWROOM_MODE, "fixture");
  assert.equal(env.api.CALENDAR_PROVIDER, "disabled");
  assert.equal(env.api.SHOWROOM_BRIDGE_ENABLED, "false");
  assert.equal(env.api.ALLOWED_ORIGINS, "http://127.0.0.1:3101,http://127.0.0.1:3202,https://kiosk.example.test");
  assert.equal(env.ui.SHOWROOM_PUBLIC_ORIGIN, "https://kiosk.example.test");
  for (const target of [env.ui, env.worker, env.media]) assert.equal(target.OPENAI_API_KEY, "");
});

test("studio starts from a distinct opt-in and routes only film credentials to web and worker", () => {
  const options = launchOptions(["--live-studio", "--ui-port", "3202"]);
  assert.throws(() => integrationEnvironments({ options, parent: {}, deviceToken: "device", mediaToken: "media" }), /Live studio/);
  const env = integrationEnvironments({
    options, parent: {}, deviceToken: "device", mediaToken: "media", studioToken: "private-studio",
    finalEnv: { OPENAI_API_KEY: "voice-not-selected", GOOGLE_CLIENT_SECRET: "calendar-not-selected" },
    movieEnv: {
      OPENAI_API_KEY: "fake-film-key", GEMINI_API_KEY: "fake-video-key", MOVIE_DATA_DIR: ".movie-test",
      VEO_MODEL: "chosen-veo", NEXT_PUBLIC_API_KEY: "must-not-leak", GOOGLE_REFRESH_TOKEN: "must-not-leak",
    },
  });
  assert.equal(env.api.SHOWROOM_MODE, "studio");
  assert.equal(env.api.MEDIA_PROVIDER, "mock");
  assert.equal(env.api.MOVIE_STUDIO_URL, "http://127.0.0.1:3202");
  assert.equal(env.api.MOVIE_API_TOKEN, "private-studio");
  assert.equal(env.api.OPENAI_API_KEY, "");
  assert.equal(env.api.GEMINI_API_KEY, "");
  for (const target of [env.ui, env.worker]) {
    assert.equal(target.OPENAI_API_KEY, "fake-film-key");
    assert.equal(target.GEMINI_API_KEY, "fake-video-key");
    assert.equal(target.MOVIE_API_TOKEN, "private-studio");
    assert.equal(target.MOVIE_DATA_DIR, ".movie-test");
    assert.equal(target.VEO_MODEL, "chosen-veo");
    assert.equal(target.GOOGLE_CLIENT_SECRET, "");
    assert.equal(target.GOOGLE_REFRESH_TOKEN, "");
    assert.equal(target.NEXT_PUBLIC_API_KEY, undefined);
  }
  assert.equal(env.media.OPENAI_API_KEY, "");
  assert.equal(env.media.MEDIA_SERVICE_TOKEN, "");
});

test("calendar and bridge opt-ins are independent and keep bootstrap/OAuth credentials server-only", () => {
  const options = launchOptions(["--google-calendar", "--windows-bridge", "--ui-port", "3202"]);
  const input = {
    options, parent: {}, deviceToken: "device", mediaToken: "media", operatorToken: "operator-private",
    finalEnv: { GOOGLE_CLIENT_ID: "fake-client", GOOGLE_CLIENT_SECRET: "fake-secret", GOOGLE_REFRESH_TOKEN: "fake-refresh" },
  };
  const env = integrationEnvironments(input);
  assert.equal(env.api.CALENDAR_PROVIDER, "google");
  assert.equal(env.api.SCHEDULING_DURATION_MINUTES, "60");
  assert.equal(env.api.GOOGLE_CLIENT_SECRET, "fake-secret");
  assert.equal(env.api.GOOGLE_REFRESH_TOKEN, "fake-refresh");
  assert.equal(env.api.SHOWROOM_BRIDGE_ENABLED, "true");
  assert.equal(env.api.SHOWROOM_BRIDGE_ORIGINS, "http://127.0.0.1:3202");
  assert.equal(env.api.SHOWROOM_OPERATOR_TOKEN, "operator-private");
  assert.equal(env.api.VOICE_ENABLED, "false");
  assert.equal(env.api.SHOWROOM_MODE, "fixture");
  for (const target of [env.ui, env.worker, env.media]) {
    assert.equal(target.SHOWROOM_OPERATOR_TOKEN, undefined);
    assert.equal(target.GOOGLE_CLIENT_SECRET, "");
    assert.equal(target.GOOGLE_REFRESH_TOKEN, "");
  }
  assert.throws(() => integrationEnvironments({ ...input, finalEnv: {} }), /Google Calendar/);
  assert.throws(() => integrationEnvironments({ ...input, operatorToken: "" }), /operator bootstrap/);
});

test("studio readiness requires exact provider/renderer/reference readiness rather than a truthy object", () => {
  const ready = {
    providers: { openai: { available: true }, veo: { available: true } },
    renderer: { available: true }, products: [{ ready: true }], worker: { available: true },
  };
  assert.equal(studioReady(ready), true);
  assert.equal(studioReady({ ...ready, worker: { available: false } }), false);
  assert.throws(() => studioReady({ ...ready, providers: { openai: { available: false }, veo: { available: true } } }), /providers/);
  assert.throws(() => studioReady({ ...ready, renderer: { available: false } }), /renderer/);
  assert.throws(() => studioReady({ ...ready, products: [{ ready: false }] }), /reference pack/);
  assert.throws(() => studioReady(null), /providers/);
});

test("explicit live voice reuses only allowlisted RobotPart configuration with FinalProject overrides", () => {
  const input = {
    options: launchOptions(["--live-voice"]), parent: {}, deviceToken: "device", mediaToken: "media",
    robotEnv: {
      OPENAI_API_KEY: "fake-existing-voice", VOICE_MODEL: "existing-voice-model", REGULAR_MODEL: "existing-regular-model",
      GOOGLE_REFRESH_TOKEN: "must-not-leak", NEXT_PUBLIC_KEY: "must-not-leak", AUTO_MOVE: "true",
    },
  };
  const env = integrationEnvironments(input);
  assert.equal(env.api.OPENAI_API_KEY, "fake-existing-voice");
  assert.equal(env.api.VOICE_MODEL, "existing-voice-model");
  assert.equal(env.api.REGULAR_MODEL, "existing-regular-model");
  assert.equal(env.api.AUTO_MOVE, undefined);
  for (const target of [env.ui, env.worker, env.media]) assert.equal(target.OPENAI_API_KEY, "");
  const overridden = integrationEnvironments({
    ...input, finalEnv: {
      OPENAI_API_KEY: "fake-override", VOICE_MODEL: "override-voice", REGULAR_MODEL: "override-regular",
      REASONING_MODEL: "lower-priority-alias",
    },
  });
  assert.equal(overridden.api.OPENAI_API_KEY, "fake-override");
  assert.equal(overridden.api.VOICE_MODEL, "override-voice");
  assert.equal(overridden.api.REGULAR_MODEL, "override-regular");
  assert.equal(overridden.api.REASONING_MODEL, "override-regular");
  const offline = integrationEnvironments({ ...input, options: launchOptions([]) });
  assert.equal(offline.api.OPENAI_API_KEY, "");
  assert.equal(offline.api.VOICE_MODEL, "gpt-live-1");
});

test("API readiness checks every selected showroom capability, not just legacy media", () => {
  const fixture = {
    status: "ready", providers: { media: "mock" },
    showroom: { mode: "fixture", voice: { enabled: false }, calendar: { provider: "disabled" }, bridge: { enabled: false } },
  };
  assert.equal(apiReady(fixture, launchOptions([])), true);
  assert.equal(apiReady({ status: "ready", providers: { media: "mock" } }, launchOptions([])), false);
  assert.equal(apiReady(fixture, launchOptions(["--live-voice"])), false);
  assert.equal(apiReady(fixture, launchOptions(["--google-calendar"])), false);
  assert.equal(apiReady(fixture, launchOptions(["--windows-bridge"])), false);
  assert.equal(apiReady(fixture, launchOptions(["--live-studio"])), false);
  assert.equal(apiReady(fixture, launchOptions(["--live-media"])), false);
  assert.equal(apiReady(null, launchOptions([])), false);
  assert.equal(apiReady({
    ...fixture,
    showroom: { mode: "studio", voice: { enabled: true }, calendar: { provider: "google" }, bridge: { enabled: true } },
  }, launchOptions(["--live-studio", "--live-voice", "--google-calendar", "--windows-bridge"])), true);
});
