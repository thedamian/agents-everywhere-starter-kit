import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createFaceScanner } from "./lib/face-detector.js";
import { createRobot } from "./lib/robot.js";
import { LiveVoice } from "./lib/voice.js";
import "./styles.css";

const uuid = () => crypto.randomUUID();
const initialClient = sessionStorage.getItem("robot-client") || uuid();
sessionStorage.setItem("robot-client", initialClient);

async function acquireMedia() {
  // Clean up any previously opened streams
  const tryCombined = async (constraints) => {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      console.warn("Combined getUserMedia failed:", constraints, e);
      return null;
    }
  };

  // Attempt 1: High quality user-facing camera + mic
  let stream = await tryCombined({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true,
  });

  // Attempt 2: Basic video + mic
  if (!stream) {
    stream = await tryCombined({ video: true, audio: true });
  }

  // Attempt 3: Separate video and audio streams
  if (!stream) {
    let videoStream = null;
    let audioStream = null;

    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch {
      try {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
      } catch (videoErr) {
        console.warn("Separate video acquisition failed:", videoErr);
        // Try device enumeration fallback
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoDevs = devices.filter((d) => d.kind === "videoinput");
          if (videoDevs.length > 0) {
            videoStream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: videoDevs[0].deviceId } },
            });
          }
        } catch {}
      }
    }

    if (!videoStream) {
      const err = new Error(
        "Could not start camera. Another app (Teams, Zoom, Windows Camera, or another browser tab) may be using the camera, or Camera access is turned off in Windows 11 Settings (Privacy & security > Camera)."
      );
      err.name = "NotReadableError";
      throw err;
    }

    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (audioErr) {
      videoStream.getTracks().forEach((t) => t.stop());
      const err = new Error(
        "Could not start microphone. Please check Microphone permissions in Chrome and Windows 11 Settings."
      );
      err.name = "NotAllowedError";
      throw err;
    }

    stream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioStream.getAudioTracks(),
    ]);
  }

  return stream;
}

function App() {
  const video = useRef(null), canvas = useRef(null), audio = useRef(null);
  const robot = useRef(createRobot());
  const scanner = useRef(null), stream = useRef(null), voice = useRef(null), socket = useRef(null);
  const [status, setStatus] = useState("Connect the robot to begin");
  const [phase, setPhase] = useState("connect");
  const [customerId, setCustomerId] = useState(null);
  const [face, setFace] = useState(null);
  const [movie, setMovie] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [transcript, setTranscript] = useState([]);
  const [slots, setSlots] = useState([]);
  const generation = useRef(0);
  const captured = useRef(false);
  const voiceStarting = useRef(false);
  // React state updates are asynchronous. The voice and scanner callbacks must
  // instead read the session identity synchronously, or START will validate the
  // new voice session against the previous render's null customer ID.
  const customerIdRef = useRef(null);
  const phaseRef = useRef("connect");

  const setCurrentCustomerId = (id) => {
    customerIdRef.current = id;
    setCustomerId(id);
  };
  const setCurrentPhase = (nextPhase) => {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
  };

  const isCurrent = (id, token) => id === customerIdRef.current && token === generation.current;
  // Robot movement is helpful, but voice and capture must never wait on a
  // BLE command: a connected robot can still have a delayed or stuck write.
  const queueRobot = (operation) => {
    Promise.resolve().then(operation).catch((error) => {
      console.warn("Robot command did not complete:", error);
    });
  };
  const tool = async (name, args) => {
    const activeCustomerId = customerIdRef.current;
    if (!activeCustomerId) return { ok: false, error: "No active customer." };
    const response = await fetch("/api/tools/" + name, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: initialClient, customerId: activeCustomerId, args }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "That showroom action is unavailable.");
    if (result.slots) setSlots(result.slots);
    if (result.uiAction === "show_movie") { await robot.current.stop(); setPlaying(true); setCurrentPhase("movie"); }
    if (result.uiAction === "follow_customer") await robot.current.follow(result.destination);
    if (result.uiAction === "stop_following") await robot.current.stop();
    if (result.uiAction === "booked") setCurrentPhase("booked");
    return result;
  };

  const connectRobot = async () => {
    try { await robot.current.connect(); setCurrentPhase("ready"); setStatus("Robot connected — press START when a visitor is facing the camera"); }
    catch (error) { setStatus(error.message || "Bluetooth connection failed"); }
  };

  const connectVoice = async (id, token) => {
    if (!isCurrent(id, token) || voiceStarting.current || voice.current) return;
    voiceStarting.current = true;
    const session = new LiveVoice({
      audioElement: audio.current,
      onStatus: (value) => setStatus(value === "ready" ? "Voice connected — say hello" : `Voice ${value}`),
      onTranscript: (entry) => setTranscript((items) => [...items.slice(-8), entry]),
      onError: (error) => setStatus(error.message),
      onTool: tool,
      isCurrent: () => isCurrent(id, token),
    });
    voice.current = session;
    try {
      await session.connect({ clientId: initialClient, customerId: id, microphone: stream.current });
      if (!isCurrent(id, token)) return;
      session.greet();
      setCurrentPhase("conversation");
    } catch (error) {
      if (voice.current === session) {
        await session.close();
        voice.current = null;
      }
      throw error;
    } finally {
      voiceStarting.current = false;
    }
  };

  const start = async () => {
    try {
      setStatus("Starting camera and local face detection…");
      if (stream.current) {
        stream.current.getTracks().forEach((track) => track.stop());
        stream.current = null;
      }
      stream.current = await acquireMedia();
      if (video.current) {
        video.current.srcObject = stream.current;
        await video.current.play().catch((err) => console.warn("Video auto-play warning:", err));
      }
      scanner.current = await createFaceScanner();
      setCurrentPhase("scanning"); setStatus("Looking for a visitor…");
      const id = uuid();
      const token = generation.current + 1;
      generation.current = token;
      setCurrentCustomerId(id);
      captured.current = false;
      // Listen before uploading the face: that upload schedules the movie event.
      socket.current = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?clientId=${initialClient}`);
      socket.current.onmessage = (event) => { const message = JSON.parse(event.data); if (message.customerId !== id) return; if (message.type === "movie.ready") { setMovie(message.movieUrl); voice.current?.movieReady(id); setStatus("Your private demo video is ready"); } };
      scanLoop();
    } catch (error) { await stopDemo(); setStatus(error.message || "Camera or voice setup failed"); }
  };

  const scanLoop = async () => {
    if (phaseRef.current !== "scanning" && phaseRef.current !== "ready") return;
    if (video.current?.readyState >= 2 && scanner.current) {
      const detections = scanner.current.detect(video.current);
      const found = detections[0];
      if (found) {
        found.boundingBox.frameWidth = video.current.videoWidth;
        setFace(found);
        queueRobot(() => robot.current.scan(found));
        if (!customerIdRef.current) return;
        if (found.boundingBox.width > video.current.videoWidth * 0.32 && !captured.current) await capture(found);
      } else { setFace(null); queueRobot(() => robot.current.stop()); }
    }
    requestAnimationFrame(scanLoop);
  };

  const capture = async () => {
    const activeCustomerId = customerIdRef.current;
    if (!activeCustomerId || !canvas.current || !video.current) return;
    const token = generation.current;
    captured.current = true;
    try {
      const context = canvas.current.getContext("2d");
      if (!context) throw new Error("Could not capture the camera frame.");
      canvas.current.width = video.current.videoWidth;
      canvas.current.height = video.current.videoHeight;
      context.drawImage(video.current, 0, 0);
      const blob = await new Promise((resolve) => canvas.current.toBlob(resolve, "image/jpeg", 0.88));
      if (!blob) throw new Error("Could not capture the camera frame.");
      const form = new FormData();
      form.set("image", blob, `${activeCustomerId}.jpg`);
      form.set("clientId", initialClient);
      form.set("customerId", activeCustomerId);
      setStatus("I found you — saving your visitor profile…");
      const response = await fetch("/newCustomerFace", { method: "POST", body: form });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Could not create the visitor session.");
      if (!isCurrent(activeCustomerId, token)) return;
      setStatus("I found you — connecting voice…");
      queueRobot(() => robot.current.stop());
      await connectVoice(activeCustomerId, token);
    } catch (error) {
      if (isCurrent(activeCustomerId, token)) {
        captured.current = false;
        setStatus(error.message || "Could not start the visitor session. Please try again.");
      }
    }
  };

  const stopDemo = async () => {
    generation.current += 1; captured.current = false; voiceStarting.current = false; await robot.current.stop(); await voice.current?.close(); scanner.current?.close(); stream.current?.getTracks().forEach((track) => track.stop()); socket.current?.close();
    robot.current = createRobot(); scanner.current = null; voice.current = null; socket.current = null; setCurrentCustomerId(null); setFace(null); setMovie(null); setPlaying(false); setCurrentPhase("connect"); setStatus("Demo stopped safely");
  };

  const onMovieEnded = async () => { setPlaying(false); await tool("movie_finished", {}); voice.current?.context("The visitor's demo video has finished. Ask whether they liked it."); setCurrentPhase("conversation"); };

  useEffect(() => () => { stopDemo(); }, []);
  const faceBox = face?.boundingBox;
  return <main>
    <header><div><span className="eyebrow">SHOWROOM / AI SALES ROBOT</span><h1>Meet your next Tesla.</h1><p>One helpful robot. Every question answered.</p></div><div className={`status ${phase}`}><span />{status}</div></header>
    <section className="stage">
      <div className="camera card"><video ref={video} muted playsInline /><canvas ref={canvas} hidden />{faceBox && <div className="face-box" style={{ left: `${faceBox.originX / (video.current?.videoWidth || 1) * 100}%`, top: `${faceBox.originY / (video.current?.videoHeight || 1) * 100}%`, width: `${faceBox.width / (video.current?.videoWidth || 1) * 100}%`, height: `${faceBox.height / (video.current?.videoHeight || 1) * 100}%` }} />}{!video.current?.srcObject && <div className="camera-placeholder"><strong>CAMERA FEED</strong><span>Face detection stays on this tablet</span></div>}</div>
      <aside className="controls card"><div className="kicker">MISSION CONTROL</div><div className="step"><b>01</b><span>Connect robot</span><i className={robot.current.connected ? "done" : ""}>●</i></div><div className="step"><b>02</b><span>Find a visitor</span><i className={phase !== "connect" && phase !== "ready" ? "done" : ""}>●</i></div><div className="step"><b>03</b><span>Welcome & assist</span><i className={phase === "conversation" || phase === "movie" || phase === "booked" ? "done" : ""}>●</i></div><button className="primary" onClick={phase === "connect" ? connectRobot : start} disabled={phase === "scanning" || phase === "conversation" || phase === "movie"}>{phase === "connect" ? "CONNECT ROBOT" : "START"}</button><button className="stop" onClick={stopDemo}>STOP ROBOT</button><small>Bluetooth pairing opens from this button. Keep a clear path in front of the robot.</small></aside>
    </section>
    <section className="lower"><div className="card conversation"><div className="kicker">LIVE CONVERSATION <span className="live-dot" /></div><div className="transcript">{transcript.length ? transcript.map((item, index) => <p key={index} className={item.speaker}><b>{item.speaker === "assistant" ? "ROBOT" : "VISITOR"}</b>{item.delta}</p>) : <p className="empty">The robot will greet visitors after START.</p>}</div><audio ref={audio} autoPlay controls /></div><div className="card movie-card">{playing ? <video src={movie} controls autoPlay onEnded={onMovieEnded} /> : <><div className="movie-icon">▶</div><h2>{movie ? "Personalized demo ready" : "Your showroom story"}</h2><p>{movie ? "The robot will naturally ask before showing the video." : "A private Model 3 experience appears here when ready."}</p></>}</div></section>
    {slots.length > 0 && <div className="slot-strip card"><b>Tomorrow · Eastern Time</b>{slots.map((slot) => <span key={slot.id}>{slot.label}</span>)}</div>}
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
