import assert from "node:assert/strict";

export function createShowroomInterfaceData(schemas) {
  const ref = (name) => {
    assert.ok(schemas[name], `Unknown showroom schema: ${name}`);
    return { $ref: `./contracts.schema.json#/$defs/${name}` };
  };
  const json = (schema) => ({ "application/json": { schema } });
  const error = { description: "Explicit safe error; no provider credentials or upstream bodies", content: json(ref("ApiErrorResponseSchema")) };
  const paths = {};
  const pathParameter = (name) => ({ name, in: "path", required: true, schema: { type: "string", format: "uuid" } });
  function route(method, path, role, input, output, status = 200) {
    const operation = {
      operationId: `${method}_${path.replace(/[{}]/g, "").replace(/\//g, "_")}`,
      security: role ? [{ [role]: [] }] : [],
      ...(input ? { requestBody: { required: true, content: json(ref(input)) } } : {}),
      responses: {
        [status]: output ? { description: "Validated result", content: json(ref(output)) } : { description: "Completed; no response body" },
        400: error, 401: error, 403: error, 409: error, 410: error, 429: error, 503: error,
      },
    };
    paths[path] ??= {
      ...(path.includes("{id}") ? { parameters: [pathParameter("id")] } : {}),
      ...(path.includes("{bridgeId}") ? { parameters: [pathParameter("bridgeId")] } : {}),
    };
    paths[path][method] = operation;
    return operation;
  }
  route("post", "/v1/operator/kiosk-pairings", "deviceBearer", "KioskPairingInputSchema", "KioskPairingSchema", 201);
  route("post", "/v1/kiosk/pair", null, "KioskPairExchangeSchema", "ShowroomSessionCreatedSchema", 201);
  route("get", "/v1/sessions/{id}/showroom", "sessionBearer", null, "ShowroomSnapshotSchema");
  route("post", "/v1/sessions/{id}/showroom/actions", "sessionBearer", "ShowroomActionSchema", "ShowroomSnapshotSchema");
  route("get", "/v1/sessions/{id}/showroom/catalog", "sessionBearer", null, "ShowroomCatalogSchema");
  route("post", "/v1/sessions/{id}/showroom/voice", "sessionBearer", "ShowroomVoiceSetupInputSchema", "ShowroomVoiceSetupSchema", 201);
  route("delete", "/v1/sessions/{id}/showroom/voice", "sessionBearer", null, null, 204);
  const upload = route("post", "/v1/sessions/{id}/showroom/references", "sessionBearer", null, "ShowroomReferenceUploadedSchema", 201);
  upload.parameters = [
    { name: "expectedRevision", in: "query", required: true, schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } },
    { name: "eventId", in: "query", required: true, schema: { type: "string", format: "uuid" } },
  ];
  upload.requestBody = { required: true, content: Object.fromEntries(["image/png", "image/jpeg"].map((mime) =>
    [mime, { schema: { type: "string", format: "binary" } }])) };
  upload.description = "At most 5 MiB. Exact eventId+bytes retries return the original receipt; changed payload conflicts. Ownership and consent are server-checked.";
  upload.responses[413] = error;
  upload.responses[415] = error;
  const removeReference = route("delete", "/v1/sessions/{id}/showroom/references/{assetId}", "sessionBearer", null, "ShowroomSnapshotSchema");
  paths["/v1/sessions/{id}/showroom/references/{assetId}"].parameters.push(pathParameter("assetId"));
  removeReference.parameters = upload.parameters;
  removeReference.description = "Revoke an unused owned reference for retake; reject in-use accepted inputs. Idempotent eventId and expectedRevision required.";
  const download = route("get", "/v1/sessions/{id}/assets/{assetId}", "sessionBearer", null, null);
  paths["/v1/sessions/{id}/assets/{assetId}"].parameters.push(pathParameter("assetId"));
  download.parameters = [{ name: "Range", in: "header", schema: { type: "string" }, description: "Existing single byte range" }];
  download.responses[200] = { description: "Authorized image or MP4 bytes", content: Object.fromEntries(["image/png", "image/jpeg", "video/mp4"].map((mime) =>
    [mime, { schema: { type: "string", format: "binary" } }])) };
  download.responses[206] = { description: "Authorized byte range" };
  download.responses[416] = error;
  route("delete", "/v1/sessions/{id}", "sessionBearer", null, null, 204);
  route("post", "/v1/operator/bridges", "deviceBearer", "BridgeRegistrationInputSchema", "BridgePairingSchema", 201);
  route("post", "/v1/bridges/{bridgeId}/pair", null, "BridgePairInputSchema", "BridgeCredentialSchema", 201);
  route("post", "/v1/operator/bridges/{bridgeId}/operator-pairing", "deviceBearer", "KioskPairingInputSchema", "OperatorPairingSchema", 201);
  route("post", "/v1/bridges/{bridgeId}/operator-pair", null, "OperatorPairInputSchema", "OperatorCredentialSchema", 201);
  route("post", "/v1/operator/bridges/{bridgeId}/lease", "operatorBearer", "BridgeLeaseInputSchema", "BridgeLeaseSchema", 201);
  const commands = route("get", "/v1/bridges/{bridgeId}/commands", "bridgeBearer", null, "BridgeCommandBatchSchema");
  commands.parameters = [{ name: "afterSequence", in: "query", schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }];
  route("post", "/v1/bridges/{bridgeId}/acknowledgements", "bridgeBearer", "BridgeAcknowledgementSchema", null, 204);
  route("post", "/v1/bridges/{bridgeId}/heartbeats", "bridgeBearer", "BridgeHeartbeatSchema", null, 204);
  const connect = route("get", "/v1/bridges/{bridgeId}/connect", null, null, null, 101);
  connect.description = "Windows local WebSocket upgrade only. Authenticate once in the first message, never in a URL; reject any other messages until authenticated. Not exposed through the tablet gateway.";
  connect["x-websocket-client-message"] = ref("BridgeClientMessageSchema");
  connect["x-websocket-server-message"] = ref("BridgeServerMessageSchema");
  const openapi = {
    openapi: "3.1.0",
    info: {
      title: "MagicPitch showroom integration boundary", version: "1.0.0",
      description: "Contract specification; foundation does not implement routes. One authoritative FinalProject session, full MoviePart studio, scoped Windows bridge. Legacy dedicated-media v1 unchanged.",
    },
    servers: [{ url: "/" }],
    components: { securitySchemes: Object.fromEntries([
      ["deviceBearer", "Local operator setup only; never a browser long-lived secret"],
      ["sessionBearer", "Short-lived session capability redeemed from one-time kiosk code; in-memory only"],
      ["bridgeBearer", "One bridge connection, commands/acknowledgements/heartbeats only"],
      ["operatorBearer", "Short-lived bridge:lease grant scoped to one bridge; not a bridge connection credential"],
    ].map(([name, description]) => [name, { type: "http", scheme: "bearer", description }])) },
    paths,
  };
  const id = "11111111-1111-4111-8111-111111111111";
  const assetId = "22222222-2222-4222-8222-222222222222";
  const now = 1_800_000_000_000;
  const captureSet = {
    captureSetId: id, sessionId: id, consentId: id, inputRevision: 2,
    references: [{ assetId, view: "front_face" }], primaryAssetId: assetId,
  };
  const studioInput = {
    mode: "studio", sessionId: id, inputRevision: 2,
    visitor: { visitorId: id, sessionId: id, source: "self_reported", displayName: "Alex" },
    selection: {
      productId: "toyota-camry", templateId: "DREAM_ROUTE", heroMode: "LIKENESS",
      productionMode: "reviewed-storyboard", videoProvider: "google-veo", enableHeroVideo: true,
      storyFormat: "four-shot", renderLayout: "storyboard", movieDurationSeconds: null,
    },
    context: { signals: [{ value: "Coastal drives", source: "manual", visualUseAllowed: true, confidence: null }] },
    consent: { consentId: id, inputRevision: 2, recordedAt: now, policyVersion: "showroom-1",
      personalization: true, capture: true, likeness: true, providerTransfer: true, calendar: false, motion: false },
    captureSet,
  };
  const pendingAction = {
    pendingActionId: id, expectedRevision: 3, inputRevision: 2, confirmationFingerprint: "a".repeat(64),
    readback: "Use the approved photo and coastal-drive interest to make the selected Toyota Camry studio movie?",
    expiresAt: now + 60_000, kind: "studio", payload: studioInput,
  };
  const snapshot = {
    schemaVersion: 1, mode: "studio", sessionId: id, serverInstanceId: id, revision: 3,
    inputRevision: 2, expiresAt: now + 300_000, state: "review",
    visitor: studioInput.visitor, consent: studioInput.consent, context: studioInput.context,
    selection: studioInput.selection, captureSet, pendingAction, acceptedStudio: null,
    studio: { status: "idle" }, playback: { status: "idle" }, calendar: { status: "idle" }, bridge: null, motionGrant: null,
  };
  const examples = {
    KioskPairingSchema: { pairingCode: "ABCD1234", expiresAt: now + 60_000 },
    ShowroomSnapshotSchema: snapshot,
    ShowroomActionSchema: { schemaVersion: 1, eventId: id, expectedRevision: 3, type: "action_confirmed",
      payload: { pendingActionId: id, confirmationFingerprint: "a".repeat(64), decision: "approve", channel: "touch" } },
    AcceptedStudioSnapshotSchema: { schemaVersion: 1, snapshotId: id, acceptedAt: now, acceptedRevision: 4,
      pendingActionId: id, confirmationFingerprint: "a".repeat(64), input: studioInput },
    CalendarDraftSchema: { draftId: id, inputRevision: 2, appointment: {
      startTime: "2027-01-15T15:00:00Z", endTime: "2027-01-15T16:00:00Z", timeZone: "America/New_York",
      attendees: ["visitor@example.com", "staff@example.com"], subject: "Toyota Camry test drive",
      location: "Showroom", productId: "toyota-camry", productName: "Toyota Camry",
    } },
    ShowroomReferenceUploadedSchema: { assetId, snapshot },
    ShowroomCatalogSchema: {
      mode: "studio", products: [{ id: "toyota-camry", name: "Toyota Camry", ready: false }],
      templates: [{ id: "DREAM_ROUTE", name: "Dream Route" }],
      videoProviders: [{ id: "google-veo", available: false }], workerAvailable: false, rendererAvailable: false,
    },
    StudioStatusSchema: { status: "ready", snapshotId: id, jobId: id, assetId, mimeType: "video/mp4",
      durationSeconds: 15, byteLength: 1024, checksum: "a".repeat(64), provenance: "mock_fixture" },
    ShowroomVoiceSetupSchema: { sessionId: id, generation: 1, session: { id: "live_example" },
      transport: { type: "webrtc", sdp: "v=0\r\ns=showroom\r\n" } },
    BridgeLeaseSchema: { bridgeId: id, sessionId: id, leaseId: id, generation: 1,
      issuedAt: now, expiresAt: now + 30_000, operatorArmed: true, rearClearanceConfirmed: true },
    BridgeCommandSchema: { commandId: id, bridgeId: id, sessionId: id, leaseId: id, leaseGeneration: 1,
      sequence: 1, issuedAt: now, expiresAt: now + 2000, type: "motion",
      intent: "reverse_for_half_body", speed: "low", pulseMs: 500,
      tracking: { capturedAt: new Date(now).toISOString(), confidence: 0.9, personCount: 1, goal: "half_body",
        centerX: 0.5, centerY: 0.5, bodyOccupancy: 0.7 } },
    BridgeAcknowledgementSchema: { commandId: id, leaseId: id, leaseGeneration: 1, sequence: 1,
      status: "write_completed", physicalExecution: "unverified", reason: "completed", at: now },
    BridgeServerMessageSchema: { type: "state", bridgeId: id, generation: 1, lastSequence: 0, lease: null, serverTime: now },
    OperatorCredentialSchema: { bridgeId: id, operatorToken: "example-only-not-a-real-capability",
      role: "operator", purpose: "bridge:lease", expiresAt: now + 60_000 },
  };
  for (const [name, input] of Object.entries(examples)) examples[name] = schemas[name].parse(input);
  return {
    openapi, examples,
    runtimeRules: [
      "Exact event ID retry dedupe does not replace expectedRevision concurrency",
      "Pending ID, fingerprint, input revision, expiry and explicit approval bind all side effects",
      "Current consent, same-session ownership, real catalog readiness and immutable studio acceptance",
      "One to four unique capture views and assets with primary in set; no images in non-likeness provider calls",
      "Exactly sixty elapsed calendar minutes; all recipients and configured product/location in readback",
      "Bridge role isolation; tracking freshness, foreground heartbeat, local watchdog and cumulative pulse budget",
      "Stop bypasses movement ordering/revision/expiry limits after authentication",
      "SDP and reference bytes bounded; no provider credentials or long-lived browser secrets",
    ],
  };
}
