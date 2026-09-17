import type { ShowroomState } from "./showroom-controller";

export type ShowroomStep = "pair" | "consent" | "visitor" | "context" | "selection" | "capture" | "review" | "producing" | "ready" | "calendar" | "ended" | "offline";

export function showroomStep(state: ShowroomState): ShowroomStep {
  if (["ended", "ending", "cleanup_failed"].includes(state.connection)) return "ended";
  if (state.connection === "offline") return "offline";
  const snapshot = state.snapshot;
  if (!snapshot) return "pair";
  if (snapshot.playback.status === "ended") return "calendar";
  if (snapshot.studio.status === "ready") return "ready";
  if (snapshot.acceptedStudio) return "producing";
  if (!snapshot.consent?.personalization || !snapshot.consent.capture || !snapshot.consent.likeness || !snapshot.consent.providerTransfer) return "consent";
  if (!snapshot.captureSet?.references.length) return "capture";
  if (!snapshot.visitor) return "visitor";
  if (!snapshot.context) return "context";
  if (!snapshot.selection) return "selection";
  return "review";
}

export function showroomPrompt(state: ShowroomState) {
  const step = showroomStep(state);
  const snapshot = state.snapshot;
  const prompts: Record<ShowroomStep, { title: string; message: string }> = {
    pair: { title: "Hello, I'm here with you.", message: "Your operator will connect us. When we're connected, you can talk with me or answer by touch." },
    consent: { title: "You're in control.", message: "Before any photos, let's agree how your information and likeness may be used. You can answer yes or no out loud, or use the touch controls." },
    capture: { title: "Just be yourself.", message: "Thanks for agreeing. I'll quietly collect one to four clear photos while we keep talking; you can review or remove them at any time." },
    visitor: { title: "Nice to meet you.", message: "What name would you like me to use?" },
    context: { title: "Customer preferences.", message: "What do you enjoy, and where would you like this drive to take you?" },
    selection: { title: "Your story. Your drive.", message: "I'll use those preferences to choose the vehicle and film direction. Let's confirm the car, a few things you love, your first name and city." },
    review: { title: "Ready to create the brief.", message: "Your consent, photos and preferences are ready. Create the brief so the movie maker can review the exact inputs before production." },
    producing: { title: "Your movie is taking shape.", message: "We can keep talking while the studio prepares it. Your approved movie inputs are fixed." },
    ready: { title: "Your movie is ready.", message: "Would you like to watch it now? I'll pause the camera and live conversation for playback." },
    calendar: { title: "Shall we plan a visit?", message: "We can check a 60-minute appointment. I'll read back the time and invite recipients before you approve anything." },
    ended: { title: "Thank you for stopping by.", message: "Local camera, voice and previews are cleared. Ending this conversation does not cancel a confirmed appointment." },
    offline: { title: "Our connection paused.", message: "Camera and live voice are paused. The robot's physical stop is not confirmed; ask the operator if needed." },
  };
  if (snapshot?.studio.status === "failed" || snapshot?.studio.status === "cancelled") {
    return { step, title: "The studio couldn't finish.", message: snapshot.studio.error.message };
  }
  if (snapshot?.studio.status === "ready" && snapshot.studio.provenance === "mock_fixture") {
    return { step, title: "A synthetic sample is ready.", message: "This is a fixture, not a film of you. Would you like to watch the sample?" };
  }
  if (snapshot?.calendar.status === "scheduled") {
    return { step, title: "Your appointment is created.", message: "Calendar invitations were requested. This does not guarantee email delivery or vehicle availability." };
  }
  if (state.connection === "cleanup_failed") return { step, title: "Cleanup needs attention.", message: "Local media is cleared. Please retry server cleanup; your confirmed appointment is unchanged." };
  return { step, ...prompts[step] };
}
