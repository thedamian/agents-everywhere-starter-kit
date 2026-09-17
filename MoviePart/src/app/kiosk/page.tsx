"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import type { ShowroomConsentInput, StudioSelection } from "../../../../FinalProject/src/contracts/showroom";
import { RobotFace } from "../../components/robot-face";
import { ShowroomController } from "../../kiosk/showroom-controller";
import { showroomPrompt } from "../../kiosk/showroom-guide";
import type { ShowroomStep } from "../../kiosk/showroom-guide";
import { useShowroomRuntime } from "../../kiosk/use-showroom-runtime";
import styles from "./kiosk.module.css";

const viewNames = { front_face: "Front face", half_body: "Half body", profile: "Profile", three_quarter: "Three-quarter" };
const noConsent: ShowroomConsentInput = {
  policyVersion: "showroom-v1", personalization: false, capture: false, likeness: false,
  providerTransfer: false, calendar: false, motion: false,
};

export default function KioskPage() {
  const [controller] = useState(() => new ShowroomController());
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const capture = useSyncExternalStore(controller.capture.subscribe, controller.capture.getState, controller.capture.getState);
  const surface = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const cameraVideo = useRef<HTMLVideoElement>(null);
  const voiceAudio = useRef<HTMLAudioElement>(null);
  const runtime = useShowroomRuntime(controller, cameraVideo, voiceAudio);
  const [drawer, setDrawer] = useState<"operator" | "photos" | "permissions" | "answers" | null>(null);
  const [touch, setTouch] = useState(false);
  const [editStep, setEditStep] = useState<ShowroomStep | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [voiceDisclosure, setVoiceDisclosure] = useState(false);
  const [pausedAnimation, setPausedAnimation] = useState(false);
  const [fullscreenNote, setFullscreenNote] = useState<string | null>(null);
  const [moviePaused, setMoviePaused] = useState(true);
  const [movieMuted, setMovieMuted] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const prompt = showroomPrompt(state);
  const step = editStep ?? prompt.step;
  const pending = controller.pending();
  const snapshot = state.snapshot;
  const active = state.connection === "active";

  function run(operation: Promise<unknown>) {
    void operation.catch(error => controller.reportError(error instanceof Error ? error.message : "The action could not be completed."));
  }
  function openDrawer(kind: NonNullable<typeof drawer>) {
    drawerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDrawer(kind);
  }
  function closeDrawer() { setDrawer(null); drawerTrigger.current?.focus(); }

  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      surface.current?.style.setProperty("--showroom-height", `${viewport?.height ?? window.innerHeight}px`);
      surface.current?.style.setProperty("--showroom-top", `${viewport?.offsetTop ?? 0}px`);
    };
    resize(); viewport?.addEventListener("resize", resize); viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize); viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => { if (drawer) drawerRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [drawer]);
  useEffect(() => {
    const element = video.current;
    setMoviePaused(true);
    setMovieMuted(false);
    return () => { if (element) { element.pause(); element.removeAttribute("src"); element.load(); } };
  }, [state.movieUrl]);
  useEffect(() => { setEditStep(null); }, [snapshot?.pendingAction?.pendingActionId]);

  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (surface.current?.requestFullscreen) await surface.current.requestFullscreen();
      else setFullscreenNote("This browser uses the full page. On iPad, choose Share, then Add to Home Screen to hide browser navigation.");
    } catch { setFullscreenNote("Fullscreen wasn't available. The face still fills the page; Add to Home Screen is available on iPad."); }
  }
  async function play() {
    try { await video.current?.play(); controller.clearError(); }
    catch { controller.reportError("Playback was blocked. Tap Play movie again to start with sound."); }
  }

  const actions = (
    <>
      {!runtime.voiceReady && !touch && active && !state.movieUrl && (
        <>
          <label className={styles.check}>
            <input type="checkbox" checked={voiceDisclosure} onChange={event => setVoiceDisclosure(event.target.checked)} />
            <span>Use live voice<small>Your microphone audio is sent to OpenAI for this conversation. Photos need a separate permission.</small></span>
          </label>
          <div className={styles.actions}>
            <button className={styles.primary} disabled={!voiceDisclosure || runtime.voiceConnecting}
              onClick={() => run(runtime.startVoice())}>{runtime.voiceConnecting ? "Connecting live voice..." : "Start live conversation"}</button>
            <button onClick={() => setTouch(true)}>Continue by touch</button>
          </div>
        </>
      )}
      {prompt.step === "pair" && <div className={styles.actions}><button className={styles.primary} onClick={() => openDrawer("operator")}>Connect this tablet</button></div>}
      {prompt.step === "offline" && <div className={styles.actions}><button className={styles.primary} onClick={() => run(controller.refresh())}>Reconnect</button></div>}
      {prompt.step === "ended" && <div className={styles.actions}>
        {state.connection === "cleanup_failed" ? <button onClick={() => run(controller.end())}>Retry server cleanup</button>
          : <button onClick={() => openDrawer("operator")}>Operator pairing</button>}
      </div>}
      {pending && (
        <section className={styles.card} aria-label="Approval readback">
          <h2>{pending.kind === "studio" ? "Your movie, before we begin" : pending.kind === "calendar" ? "Confirm this appointment" : "Is this what you want?"}</h2>
          <p className={styles.readback}>{pending.readback}</p>
          <p className={styles.help}>Only an explicit approval applies to this exact summary. You can correct it or decline.</p>
          <div className={styles.actions}>
            <button className={styles.primary} disabled={state.busy} onClick={() => run(controller.confirm(pending, "approve", "touch"))}>
              {pending.kind === "studio" ? "Approve & create movie" : pending.kind === "calendar" ? "Create appointment & invite" : "Approve this summary"}
            </button>
            <button disabled={state.busy} onClick={() => run(controller.confirm(pending, "reject", "touch"))}>No, change this</button>
          </div>
        </section>
      )}
      {!pending && active && (touch || editStep) && ["consent", "visitor", "context", "selection"].includes(step) &&
        <TouchAnswer key={`${step}:${snapshot?.inputRevision}`} controller={controller} step={step} onDone={() => setEditStep(null)} />}
      {!pending && active && prompt.step === "review" && <div className={styles.actions}>
        <button className={styles.primary} disabled={!controller.canRequestStudio()} onClick={() => run(controller.requestStudio())}>Review my movie</button>
        {!controller.canRequestStudio() && <p className={styles.help}>Finish syncing your current photos before reviewing the movie.</p>}
      </div>}
      {!pending && active && prompt.step === "ready" && <div className={styles.actions}>
        <button className={styles.primary} disabled={state.movieLoading} onClick={() => run(controller.acceptPlayback())}>
          {state.movieLoading ? "Loading your movie..." : "Yes, let's watch"}
        </button>
        <button onClick={() => runtime.movieLater()}>Keep talking</button>
      </div>}
      {active && prompt.step === "calendar" && !pending && touch && ["idle", "draft", "failed"].includes(snapshot?.calendar.status ?? "") &&
        <CalendarAnswer controller={controller} />}
      {snapshot?.calendar.status === "uncertain" && <section className={styles.card} aria-label="Appointment recovery">
        <h2>The appointment result is uncertain.</h2>
        <p className={styles.help}>Check the same approved appointment, without sending a new invitation or changing its details.</p>
        <div className={styles.actions}><button disabled={state.busy || !controller.canRetryCalendar()}
          onClick={() => run(controller.retryCalendarConfirmation())}>Check original appointment result</button></div>
        {!controller.canRetryCalendar() && <p className={styles.help}>The operator needs to reconcile the original confirmation. Do not create a replacement invitation.</p>}
      </section>}
      {snapshot?.calendar.status === "submitting" && <p className={styles.help} role="status">Checking your approved appointment. No second invitation will be created.</p>}
      {snapshot?.studio.status === "running" && <p className={styles.help}>Studio: {snapshot.studio.stage}</p>}
      {snapshot?.studio.status === "awaiting_review" && <p className={styles.help}>The storyboard needs operator review in the creator studio before the movie can continue.</p>}
      {runtime.voiceError && <p className={styles.error} role="alert">{runtime.voiceError} Use the touch controls below.</p>}
      {state.error && <p className={styles.error} role="alert">{state.error}</p>}
      {state.playbackError && <p className={styles.error} role="alert">{state.playbackError}</p>}
      <div className={styles.secondaryActions}>
        {active && touch && !runtime.voiceReady && <button className={styles.quiet} onClick={() => setTouch(false)}>Switch to live voice</button>}
        {active && <button className={styles.quiet} onClick={() => { setTouch(true); openDrawer("answers"); }}>Touch controls & corrections</button>}
        {active && <button className={styles.quiet} onClick={() => openDrawer("photos")}>Photos & camera</button>}
      </div>
    </>
  );

  return (
    <main ref={surface} className={styles.kiosk}>
      <div className={styles.safety} aria-label="Always available safety controls">
        <button className={styles.stop} onClick={() => run(controller.stop())}>Stop robot</button>
        <button aria-pressed={runtime.micMuted || !!state.movieUrl} disabled={!runtime.voiceReady || !!state.movieUrl}
          onClick={() => runtime.setMicMuted(!runtime.micMuted)}>{state.movieUrl ? "Mic paused" : runtime.micMuted ? "Unmute mic" : "Mute mic"}</button>
        <button className={styles.end} onClick={() => run(controller.end())} disabled={state.connection === "ending" || state.connection === "unpaired"}>End session</button>
      </div>
      <div className={styles.stage}>
        {state.movieUrl ? (
          <section className={styles.movie} aria-label="Inline movie playback">
            <h1>{snapshot?.studio.status === "ready" && snapshot.studio.provenance === "mock_fixture" ? "Synthetic sample - not your likeness" : "Your showroom movie"}</h1>
            <video ref={video} src={state.movieUrl} playsInline preload="metadata" disablePictureInPicture
              controlsList="nofullscreen nodownload noremoteplayback" aria-label="Showroom movie"
              onPlaying={() => { setMoviePaused(false); controller.onPlaying(); }}
              onVolumeChange={event => setMovieMuted(event.currentTarget.muted)}
              onPause={() => setMoviePaused(true)} onEnded={() => run(controller.onEnded())}
              onError={() => controller.reportError("The movie could not play. Ask the operator or retry playback.")} />
            <div className={styles.movieControls}>
              <button className={styles.primary} onClick={() => moviePaused ? run(play()) : video.current?.pause()}>{moviePaused ? "Play movie" : "Pause movie"}</button>
              <button aria-pressed={movieMuted} onClick={() => { if (video.current) video.current.muted = !video.current.muted; }}>{movieMuted ? "Unmute movie" : "Mute movie"}</button>
              {state.playbackError && <button onClick={() => run(controller.retryPlaybackAcknowledgement())}>Retry acknowledgement</button>}
            </div>
            <p className={styles.help}>Live voice and camera are paused. Stop robot stays available.</p>
            {(state.playbackError || state.error) && <p className={styles.error} role="alert">{state.playbackError ?? state.error}</p>}
          </section>
        ) : (
          <RobotFace activity={runtime.activity} audioLevel={runtime.audioLevel} paused={pausedAnimation}
            title={pending ? "Let's check that together." : prompt.title}
            caption={runtime.caption || prompt.message}>{actions}</RobotFace>
        )}
        {drawer && (
          <aside ref={drawerRef} className={styles.drawer} aria-label={`${drawer} controls`}
            onKeyDown={event => { if (event.key === "Escape") closeDrawer(); }}>
            <div className={styles.drawerHeading}>
              <h2>{{ operator: "Operator setup", photos: "Your photos", permissions: "Your permissions", answers: "Touch controls" }[drawer]}</h2>
              <button onClick={closeDrawer}>Close</button>
            </div>
            <div className={styles.drawerContent}>
              {drawer === "operator" && <>
                <p>Enter the one-time code from the Windows operator bridge. This tablet never connects to Bluetooth directly.</p>
                <form autoComplete="off" onSubmit={event => {
                  event.preventDefault(); const code = pairingCode; setPairingCode("");
                  run(controller.pair(code).then(() => { if (controller.getState().connection === "active") closeDrawer(); }));
                }}>
                  <label className={styles.field}><span>Pairing code</span>
                    <input value={pairingCode} onChange={event => setPairingCode(event.target.value.toUpperCase())}
                      autoCapitalize="characters" autoCorrect="off" autoComplete="off" spellCheck={false} minLength={8} maxLength={8} pattern="[A-Z0-9]{8}" required />
                  </label>
                  <div className={styles.actions}><button className={styles.primary} disabled={state.connection === "connecting" || active}>Pair tablet</button></div>
                </form>
                <p className={styles.help}>The session capability stays in memory, never in a link or browser storage. Refreshing requires a new pairing code.</p>
                <p className={styles.help}>Motion starts disabled. The operator must arm the Windows bridge and confirm rear clearance, and the customer must agree.</p>
                <div className={styles.actions}>
                  <button onClick={() => run(fullscreen())}>Toggle fullscreen</button>
                  <button aria-pressed={pausedAnimation} onClick={() => setPausedAnimation(value => !value)}>{pausedAnimation ? "Resume animation" : "Pause animation"}</button>
                </div>
                <p className={styles.help}>Pause animation changes only the face. It does not stop the robot.</p>
                {fullscreenNote && <p className={styles.help} role="status">{fullscreenNote}</p>}
                {state.error && <p className={styles.error} role="alert">{state.error}</p>}
              </>}
              {drawer === "answers" && <>
                <p>You can answer or correct one topic at a time. Changes need a fresh approval.</p>
                <div className={styles.choices}>
                  {(["consent", "visitor", "context", "selection"] as const).map(topic => <button key={topic}
                    disabled={!active || !!snapshot?.acceptedStudio} onClick={() => { setEditStep(topic); setTouch(true); closeDrawer(); }}>
                    {{ consent: "Photography & likeness permission", visitor: "My name", context: "Interests & destination", selection: "Vehicle & film style" }[topic]}
                  </button>)}
                  {prompt.step === "calendar" && <button onClick={() => { setTouch(true); closeDrawer(); }}>Appointment details</button>}
                  <button onClick={() => setDrawer("permissions")}>Review or withdraw permissions</button>
                </div>
              </>}
              {drawer === "permissions" && <>
                <p>Withdrawing photo or likeness permission immediately stops local media and requests server cleanup. Confirmed appointments are not cancelled.</p>
                <div className={styles.actions}>
                  <button onClick={() => run(controller.end())}>Withdraw & end session</button>
                  {active && !snapshot?.acceptedStudio && <button onClick={() => { setEditStep("consent"); setTouch(true); closeDrawer(); }}>Change permissions</button>}
                </div>
              </>}
              {drawer === "photos" && <>
                <p>No images are read or uploaded before photography and likeness permission. Up to four different views are used for this session's movie.</p>
                <p className={styles.help} role="status">{capture.references.length} of 4 photos selected. {capture.message}</p>
                <div className={styles.photos}>
                  {capture.references.map(ref => <figure key={ref.id}>
                    {/* Local, consented blob URLs do not use the remote image optimizer. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={ref.url} alt={`${viewNames[ref.view]} reference`} />
                    <figcaption>{viewNames[ref.view]}{capture.primaryId === ref.id ? " · Primary" : ""}</figcaption>
                    <button disabled={capture.status === "frozen" || state.busy} onClick={() => run(runtime.removePhoto(ref.id))}>Remove / retake</button>
                  </figure>)}
                </div>
                <div className={styles.actions}>
                  <button disabled={!controller.canCapture() || capture.status === "frozen"}
                    onClick={() => runtime.cameraActive ? runtime.pauseCamera() : run(runtime.resumeCamera())}>
                    {runtime.cameraActive ? "Pause camera" : "Resume camera"}
                  </button>
                  {snapshot?.consent?.motion && <button disabled={!runtime.cameraActive || !snapshot.bridge?.armed || state.busy}
                    onClick={() => { run(controller.requestFraming()); closeDrawer(); }}>Review a small framing adjustment</button>}
                  {runtime.cameraError && <button disabled={state.busy || !controller.canCapture()} onClick={() => run(controller.syncPhotos())}>Retry photo sync</button>}
                </div>
                <label className={styles.field}><span>Upload a JPEG or PNG instead</span>
                  <input type="file" accept="image/jpeg,image/png" disabled={!controller.canCapture() || capture.references.length >= 4}
                    onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) run(runtime.uploadPhoto(file)); }} />
                </label>
                <p className={styles.help}>Maximum 5 MiB per photo, 20 MiB total. One clear person, even lighting and a still image are needed. Retaking never changes a confirmed movie.</p>
                {runtime.cameraError && <p className={styles.error} role="alert">{runtime.cameraError}</p>}
              </>}
            </div>
          </aside>
        )}
      </div>
      <div className={styles.statusBar}>
        <span className={styles.cameraStatus} data-active={runtime.cameraActive}>{runtime.cameraActive ? "Camera on" : "Camera off"}</span>
        {snapshot?.mode === "fixture" && <span>Synthetic fixture session</span>}
        <span role="status">{{
          unavailable: "Motion not connected", requested: "Stop requested...",
          bridge_confirmed: "Bridge reports stopped; physical motion unverified", unconfirmed: "Stop unconfirmed - ask the operator",
        }[state.stopState]}</span>
        <button className={styles.quiet} onClick={() => openDrawer("operator")}>Operator</button>
      </div>
      <video ref={cameraVideo} className={styles.srOnly} muted playsInline aria-hidden="true" />
      <audio ref={voiceAudio} aria-hidden="true" />
    </main>
  );
}

function TouchAnswer({ controller, step, onDone }: { controller: ShowroomController; step: ShowroomStep; onDone(): void }) {
  const state = controller.getState(), snapshot = state.snapshot;
  const [name, setName] = useState(snapshot?.visitor?.displayName ?? "");
  const [interests, setInterests] = useState(snapshot?.context?.signals.map(signal => signal.value).join("\n") ?? "");
  const [consent, setConsent] = useState<ShowroomConsentInput>(() => snapshot?.consent ? {
    policyVersion: snapshot.consent.policyVersion, personalization: snapshot.consent.personalization,
    capture: snapshot.consent.capture, likeness: snapshot.consent.likeness, providerTransfer: snapshot.consent.providerTransfer,
    calendar: snapshot.consent.calendar, motion: snapshot.consent.motion,
  } : { ...noConsent });
  const [selection, setSelection] = useState<StudioSelection>(snapshot?.selection ?? {
    productId: "", templateId: "DREAM_ROUTE", heroMode: "LIKENESS", productionMode: "reviewed-storyboard",
    videoProvider: "google-veo", enableHeroVideo: true, storyFormat: "four-shot", renderLayout: "video-bookends", movieDurationSeconds: 15,
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    let operation: Promise<unknown>;
    if (step === "consent") operation = controller.consent(consent);
    else if (step === "visitor") operation = controller.propose({ field: "visitor", value: { displayName: name.trim() } });
    else if (step === "context") operation = controller.propose({ field: "context", value: {
      signals: interests.split(/\r?\n/).map(value => value.trim()).filter(Boolean).map(value => ({ value, source: "manual", visualUseAllowed: true, confidence: null })),
    } });
    else operation = controller.propose({ field: "selection", value: selection });
    void operation.then(onDone).catch(error => controller.reportError(error instanceof Error ? error.message : "Please check your answer."));
  }
  return (
    <form className={styles.card} onSubmit={submit}>
      {step === "consent" && <>
        <h2>Your permission</h2>
        {([
          ["personalization", "Personalize my movie", "Use my self-reported name and approved interests for this film."],
          ["capture", "Photograph me during our conversation", "Quietly collect up to four clear photos. No video recording; review or remove photos whenever you want."],
          ["likeness", "Use my likeness in the movie", "Use these photos to generate a film featuring my appearance."],
          ["providerTransfer", "Process with the movie providers", "Send the selected photos and approved inputs to the configured generation providers. You can withdraw before or after creation."],
          ["motion", "Allow a small framing adjustment", "Only if the operator arms the bridge and confirms rear clearance. Every bounded reverse adjustment needs a separate approval."],
        ] as const).map(([key, label, help]) => <label className={styles.check} key={key}>
          <input type="checkbox" checked={consent[key]} onChange={event => setConsent({ ...consent, [key]: event.target.checked })} />
          <span>{label}<small>{help}</small></span>
        </label>)}
      </>}
      {step === "visitor" && <label className={styles.field}><span>What name should I use?</span><input value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoComplete="given-name" /></label>}
      {step === "context" && <label className={styles.field}><span>What do you enjoy? Up to three interests, one per line.</span>
        <textarea value={interests} onChange={event => setInterests(event.target.value)} maxLength={302} placeholder="Coastal drives" />
      </label>}
      {step === "selection" && <>
        <label className={styles.field}><span>Which vehicle?</span><select required value={selection.productId} onChange={event => setSelection({ ...selection, productId: event.target.value })}>
          <option value="">Choose a vehicle</option>
          {state.catalog?.products.map(product => <option key={product.id} value={product.id} disabled={!product.ready}>{product.name}{product.ready ? "" : " - references unavailable"}</option>)}
        </select></label>
        <label className={styles.field}><span>What film style?</span><select value={selection.templateId} onChange={event => {
          const template = state.catalog?.templates.find(item => item.id === event.target.value);
          if (template) setSelection({ ...selection, templateId: template.id });
        }}>{state.catalog?.templates.map(template => <option value={template.id} key={template.id}>{template.name}</option>)}</select></label>
        <p className={styles.help}>A personalized movie featuring your likeness. Vehicle references in the catalog are not a guarantee of inventory.</p>
        <details className={styles.card}>
          <summary>Film format</summary>
          <label className={styles.field}><span>Production</span><select value={selection.productionMode} onChange={event => setSelection(event.target.value === "movie-first" ? {
            ...selection, productionMode: "movie-first", enableHeroVideo: false, videoProvider: null,
            renderLayout: "storyboard", movieDurationSeconds: null,
          } : {
            ...selection, productionMode: "reviewed-storyboard", enableHeroVideo: true, videoProvider: "google-veo",
            renderLayout: "video-bookends", movieDurationSeconds: 15,
          })}>
            <option value="reviewed-storyboard">Reviewed storyboard & generated video</option>
            <option value="movie-first">Image motion only - not generated video footage</option>
          </select></label>
          {selection.productionMode === "reviewed-storyboard" && <label className={styles.field}><span>Video provider</span>
            <select value={selection.videoProvider ?? ""} onChange={event => {
              const provider = state.catalog?.videoProviders.find(item => item.id === event.target.value);
              if (provider) setSelection({ ...selection, videoProvider: provider.id });
            }}>{state.catalog?.videoProviders.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.available}>
              {provider.id === "google-veo" ? "Google Veo" : "OpenAI Sora"}{provider.available ? "" : " - unavailable"}
            </option>)}</select>
          </label>}
          <p className={styles.help}>{selection.productionMode === "reviewed-storyboard"
            ? "15 seconds with generated video and opening/closing bookends. The storyboard may need operator review before production continues."
            : "An animated-image movie from the full studio. This option does not create video-model footage."}</p>
        </details>
      </>}
      <div className={styles.actions}><button className={styles.primary} disabled={state.busy}>Read back my answer</button></div>
    </form>
  );
}

function CalendarAnswer({ controller }: { controller: ShowroomController }) {
  const [startTime, setStartTime] = useState("");
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState(false);
  const snapshot = controller.getState().snapshot;
  return <form className={styles.card} onSubmit={event => {
    event.preventDefault();
    const operation = !snapshot?.consent?.calendar && snapshot?.consent ? controller.consent({
      policyVersion: snapshot.consent.policyVersion, personalization: snapshot.consent.personalization, capture: snapshot.consent.capture,
      likeness: snapshot.consent.likeness, providerTransfer: snapshot.consent.providerTransfer, motion: snapshot.consent.motion, calendar: permission,
    }) : controller.proposeCalendar({ startTime, customerEmail: email });
    void operation.catch(error => controller.reportError(error instanceof Error ? error.message : "Appointment details could not be checked."));
  }}>
    <h2>A 60-minute appointment</h2>
    {!snapshot?.consent?.calendar ? <label className={styles.check}>
      <input type="checkbox" checked={permission} onChange={event => setPermission(event.target.checked)} required />
      <span>Allow calendar scheduling<small>Check availability and, only after a separate readback and approval, create an appointment and request attendee invitations.</small></span>
    </label> : <>
      <label className={styles.field}><span>Preferred start, including UTC offset</span><input value={startTime} onChange={event => setStartTime(event.target.value)}
        placeholder="2026-09-20T14:00:00-04:00" required spellCheck={false} /></label>
      <p className={styles.help}>Use an exact date, time and UTC offset. The confirmed summary will include the showroom timezone, end time, location and everyone invited.</p>
      <label className={styles.field}><span>Your email</span><input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" required maxLength={254} /></label>
    </>}
    <div className={styles.actions}><button className={styles.primary} disabled={controller.getState().busy}>{snapshot?.consent?.calendar ? "Check this time" : "Review calendar permission"}</button></div>
    <p className={styles.help}>Calendar availability is not a vehicle reservation. Invitations requested does not mean emails were delivered.</p>
  </form>;
}
