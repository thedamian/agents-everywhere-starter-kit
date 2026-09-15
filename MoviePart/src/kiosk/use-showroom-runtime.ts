"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import type { JsonValue, LiveVoice } from "@magicpitch/showroom-runtime/browser";
import { ShowroomCamera } from "./camera";
import { VoiceActivityMonitor } from "./voice-activity";
import type { ShowroomController } from "./showroom-controller";
import type { FaceActivity } from "../components/robot-face";

export function useShowroomRuntime(controller: ShowroomController,
  cameraVideo: RefObject<HTMLVideoElement | null>, voiceAudio: RefObject<HTMLAudioElement | null>) {
  const session = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const capture = useSyncExternalStore(controller.capture.subscribe, controller.capture.getState, controller.capture.getState);
  const camera = useRef<ShowroomCamera | null>(null);
  const voice = useRef<LiveVoice | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const monitor = useRef<VoiceActivityMonitor | null>(null);
  const generation = useRef(0);
  const voiceRoot = useRef(new AbortController());
  const mounted = useRef(true);
  const playbackPaused = useRef(false);
  const consentStarted = useRef<string | null>(null);
  const lastContext = useRef("");
  const transcript = useRef({ speaker: "", text: "", end: 0 });
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [voiceReady, setVoiceReady] = useState(false);
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [micMuted, setMuted] = useState(false);
  const [caption, setCaption] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);

  const closeVoice = useRef<() => void>(() => {});
  closeVoice.current = () => {
    const closingGeneration = generation.current;
    transcript.current = { speaker: "", text: "", end: 0 };
    lastContext.current = "";
    generation.current++;
    voiceRoot.current.abort(); voiceRoot.current = new AbortController();
    microphone.current?.getTracks().forEach(track => track.stop()); microphone.current = null;
    monitor.current?.stop(); monitor.current = null;
    const current = voice.current; voice.current = null;
    if (mounted.current) {
      setVoiceReady(false); setVoiceConnecting(false); setCaption(""); setAudioLevel(0);
    }
    if (current) {
      void current.close().catch(() => { if (mounted.current) setVoiceError("Live voice cleanup could not be confirmed."); });
      void controller.closeVoice(closingGeneration).catch(() => {
        if (mounted.current) setVoiceError("Microphone stopped locally; server voice cleanup needs attention.");
      });
    }
  };

  useEffect(() => {
    mounted.current = true;
    if (!cameraVideo.current) return;
    camera.current = new ShowroomCamera(controller.capture, {
      video: cameraVideo.current,
      permitted: controller.canCapture, robotStopped: controller.robotStopped,
      onUnsafe: () => { void controller.stop("disconnect"); },
      onStatus: active => { if (mounted.current) setCameraActive(active); },
      onError: message => { if (mounted.current) setCameraError(message); },
    });
    controller.setTrackingProvider(() => camera.current?.tracking() ?? null);
    controller.setCaptureStopHandler(() => camera.current?.stop());
    controller.setSuspendHandler(() => { camera.current?.stop(); closeVoice.current(); });
    controller.setPlaybackHandler(paused => {
      playbackPaused.current = paused;
      if (paused) camera.current?.stop();
      voice.current?.setPlaybackPaused(paused);
      if (paused) { setAudioLevel(0); setCaption(""); }
      else voice.current?.instruct("The browser confirmed the movie ended. Ask whether the customer would like to check a 60-minute appointment. Do not claim any appointment or email exists.");
    });
    const hide = () => {
      if (!document.hidden) return;
      camera.current?.stop(); closeVoice.current();
      controller.capture.pause("Tablet hidden. Resume camera and voice deliberately after returning.");
      void controller.stop("disconnect");
    };
    const pagehide = () => { camera.current?.stop(); closeVoice.current(); void controller.stop("disconnect"); };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", pagehide);
    return () => {
      document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", pagehide);
      camera.current?.stop(); camera.current = null;
      closeVoice.current(); mounted.current = false;
      void controller.stop("disconnect");
      controller.dispose();
    };
  }, [controller, cameraVideo]);

  useEffect(() => {
    const consentId = session.snapshot?.consent?.consentId;
    if (!controller.canCapture()) {
      camera.current?.stop();
      if (!session.snapshot?.consent?.capture) consentStarted.current = null;
      return;
    }
    if (consentId && consentStarted.current !== consentId && !document.hidden && capture.status === "collecting") {
      consentStarted.current = consentId;
      setCameraError(null);
      void camera.current?.start().catch(error => setCameraError(error instanceof Error ? error.message : "Camera unavailable."));
    }
  }, [controller, session.snapshot?.consent?.consentId, session.connection, session.snapshot?.acceptedStudio, capture.status]);

  useEffect(() => {
    if (!controller.canCapture() || !capture.references.length) return;
    const timer = setTimeout(() => {
      void controller.syncPhotos().catch(error => {
        if (mounted.current) setCameraError(error instanceof Error ? error.message : "Photo upload failed. Retry before creating a movie.");
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [controller, capture.revision]);

  useEffect(() => {
    if (!voice.current?.ready || playbackPaused.current || !session.snapshot) return;
    const snapshot = session.snapshot;
    const key = `${snapshot.inputRevision}:${snapshot.pendingAction?.pendingActionId ?? ""}:${snapshot.studio.status}:${snapshot.playback.status}:${snapshot.calendar.status}`;
    if (lastContext.current === key) return;
    lastContext.current = key;
    setCaption("");
    voice.current.context(JSON.stringify(snapshot));
    if (snapshot.pendingAction) voice.current.instruct(`Read this pending summary verbatim, then wait for an explicit answer. Never approve it yourself: ${snapshot.pendingAction.readback}`);
    else if (snapshot.studio.status === "ready") voice.current.movieReady();
  }, [session.snapshot, voiceReady]);

  async function startVoice() {
    if (!voiceAudio.current || voiceConnecting || voiceReady) return;
    if (controller.getState().connection !== "active" || document.hidden) throw new Error("Connect this visible tablet before starting live voice.");
    const sessionId = controller.getState().snapshot!.sessionId;
    const run = Math.max(Date.now(), generation.current + 1);
    generation.current = run;
    const root = voiceRoot.current;
    setVoiceConnecting(true); setVoiceError(null); setCaption(""); setMuted(false);
    const current = () => mounted.current && generation.current === run && !root.signal.aborted &&
      controller.getState().snapshot?.sessionId === sessionId;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
      microphone.current = stream;
      const { LiveVoice: Voice } = await import("@magicpitch/showroom-runtime/browser");
      if (!current()) return;
      const audio = voiceAudio.current;
      const runtime = new Voice({
        audioElement: audio,
        sessionFactory: ({ sdp, signal }) => controller.openVoice(sdp, run, signal),
        allowedTools: ["showroom_state", "showroom_catalog", "showroom_action", "showroom_playback"],
        greetingContext: "Inspect the current showroom session and naturally ask one missing question. Explain permissions before requesting them; the customer may say yes or no out loud. After affirmative consent, keep the conversation natural while the camera quietly collects one to four approved photos; do not hide that this was consented. Ask customer preferences only after the photos are synced. Use only self-reported answers and the approved catalog.",
        readyContext: "The actual studio movie is ready. Ask whether the customer wants to watch; only explicit acceptance may call showroom_playback.",
        isCurrent: current,
        onStatus: status => {
          if (!current()) return;
          setVoiceReady(status === "ready"); setVoiceConnecting(status === "connecting");
          if (status === "closed") {
            setVoiceError("Live voice disconnected. Reconnect voice or continue by touch.");
            closeVoice.current();
          }
        },
        onError: () => {
          if (!current()) return;
          setVoiceError("Live voice is unavailable. Your microphone has been stopped.");
          closeVoice.current();
        },
        onTranscript: value => {
          if (!current() || playbackPaused.current) return;
          if (transcript.current.speaker !== value.speaker || value.start_ms > transcript.current.end + 1200) {
            transcript.current = { speaker: value.speaker, text: "", end: value.end_ms };
          }
          transcript.current.text = `${transcript.current.text}${value.delta}`.slice(-600);
          transcript.current.end = value.end_ms;
          if (value.speaker === "assistant") setCaption(transcript.current.text);
        },
        onTool: async (name, args) => {
          if (!current() || playbackPaused.current) throw new Error("This live voice run is no longer active.");
          let result: unknown;
          if (name === "showroom_state") result = controller.getState().snapshot;
          else if (name === "showroom_catalog") result = controller.getState().catalog;
          else if (name === "showroom_action") result = await controller.voiceAction(args.action);
          else if (name === "showroom_playback") {
            const ready = controller.getState().snapshot?.studio;
            if (ready?.status !== "ready" || args.jobId !== ready.jobId || args.assetId !== ready.assetId ||
              !["play", "later"].includes(String(args.decision))) throw new Error("Only the current ready movie can be offered.");
            if (args.decision === "play") await controller.acceptPlayback();
            result = { accepted: args.decision === "play", playbackStarted: false };
          } else throw new Error("This tool is not available in the showroom.");
          if (!current()) throw new Error("This voice run was replaced.");
          return JSON.parse(JSON.stringify(result)) as JsonValue;
        },
      });
      voice.current = runtime;
      monitor.current = new VoiceActivityMonitor(audio, level => {
        if (current()) setAudioLevel(playbackPaused.current ? 0 : level);
      }, message => { if (current()) setVoiceError(message); });
      await monitor.current.start();
      await runtime.connect({ identity: { sessionId }, microphone: stream });
      if (!current()) { await runtime.close(); return; }
      setVoiceReady(true); setVoiceConnecting(false);
      lastContext.current = "";
      runtime.greet();
    } catch {
      if (!current()) return;
      closeVoice.current();
      setVoiceError("Live voice could not start. Check microphone permission and the configured voice service, or continue by touch.");
    }
  }

  const activity: FaceActivity = audioLevel > 0.015 && !playbackPaused.current ? "speaking"
    : voiceConnecting || session.busy ? "thinking"
    : voiceReady && !micMuted ? "listening"
    : session.connection === "offline" ? "offline" : "idle";

  return {
    cameraActive, cameraError, voiceReady, voiceConnecting, voiceError, micMuted, caption, audioLevel, activity,
    startVoice,
    setMicMuted: (muted: boolean) => {
      microphone.current?.getAudioTracks().forEach(track => { track.enabled = !muted; });
      voice.current?.setMicrophoneMuted(muted); setMuted(muted);
    },
    movieLater: () => { voice.current?.context("The customer wants to keep talking before watching. Do not start playback."); },
    pauseCamera: () => { camera.current?.stop(); controller.capture.pause(); },
    resumeCamera: async () => { setCameraError(null); await camera.current?.start(); },
    uploadPhoto: async (file: File) => { setCameraError(null); camera.current?.stop(); await camera.current?.upload(file); await controller.syncPhotos(); },
    removePhoto: async (id: string) => { await controller.removePhoto(id); },
  };
}
