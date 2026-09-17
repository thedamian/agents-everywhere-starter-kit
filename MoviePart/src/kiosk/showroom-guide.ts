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
  if (!snapshot.visitor) return "visitor";
  if (!snapshot.context) return "context";
  if (!snapshot.selection) return "selection";
  if (!snapshot.captureSet?.references.length) return "capture";
  return "review";
}

export function showroomPrompt(state: ShowroomState) {
  const step = showroomStep(state);
  const snapshot = state.snapshot;
  const prompts: Record<ShowroomStep, { title: string; message: string }> = {
    pair: { title: "Hello, I'm here with you.", message: "Your operator will connect us. Are you interested in a Car??? Let's talk." },
    consent: { title: "You're in control.", message: "Before any photos, let's agree how your information and likeness may be used. You can say no." },
    visitor: { title: "Nice to meet you.", message: "What name would you like me to use?" },
    context: { title: "Let's make it yours.", message: "What do you enjoy, or where would you like this drive to take you?" },
    selection: { title: "Your story. Your drive.", message: "Which vehicle and film style would you like to explore?" },
    capture: { title: "Just be yourself.", message: "With your permission, I'll collect a few clear photos while we talk. One useful photo is enough." },
    review: { title: "Here's what I understood.", message: "Let's review the vehicle, your interests and the photos before creating your movie." },
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
