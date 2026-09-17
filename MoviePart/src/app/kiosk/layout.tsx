import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Showroom robot",
  description: "A voice-led, consent-first showroom conversation.",
  manifest: "/kiosk/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Showroom", statusBarStyle: "black-translucent" },
  icons: { apple: "/kiosk/apple-icon" },
};

export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover",
  themeColor: "#202a25", interactiveWidget: "resizes-content",
};

export default function KioskLayout({ children }: { children: React.ReactNode }) {
  return children;
}
