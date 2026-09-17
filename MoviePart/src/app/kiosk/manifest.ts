import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Showroom robot", short_name: "Showroom", start_url: "/kiosk", scope: "/kiosk",
    display: "standalone", orientation: "any", background_color: "#202a25", theme_color: "#202a25",
    icons: [{ src: "/kiosk/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
