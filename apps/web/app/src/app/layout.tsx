import type { Metadata } from "next";
import {
  Crimson_Text,
  Rethink_Sans,
  Roboto_Mono,
} from "next/font/google";
import "../index.css";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/utils";
import appleTouchIcon from "./apple-touch-icon-180.png";
import favicon192 from "./favicon-192.png";
import favicon48 from "./favicon-48.png";
import favicon512 from "./favicon-512.png";
import faviconDark32 from "./favicon-dark-32.png";
import faviconLight32 from "./favicon-light-32.png";

const crimsonText = Crimson_Text({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});

const rethinkSans = Rethink_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Breezify - The AI Knowledge Base",
  description:
    "Breezify turns messy Slack threads and terminal dumps into clean, permanent runbooks. It's an automated SRE on your shoulder.",
  // The same favicon files and link set breeze.com serves, so the app's tab
  // icon is identical to the marketing site's: a navy mark on light tab strips
  // and a white one on dark. The switch follows the browser/OS color scheme,
  // not the in-app theme toggle. The larger sizes have no dark variant, and a
  // light one stays last so a browser that ignores `media` on icons never
  // lands on the white mark.
  icons: {
    icon: [
      {
        url: faviconLight32.src,
        type: "image/png",
        sizes: "32x32",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: faviconDark32.src,
        type: "image/png",
        sizes: "32x32",
        media: "(prefers-color-scheme: dark)",
      },
      { url: favicon48.src, type: "image/png", sizes: "48x48" },
      { url: favicon192.src, type: "image/png", sizes: "192x192" },
      { url: favicon512.src, type: "image/png", sizes: "512x512" },
    ],
    apple: { url: appleTouchIcon.src, sizes: "180x180" },
  },
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
    },
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        crimsonText.variable,
        robotoMono.variable,
        rethinkSans.variable,
        "font-sans"
      )}
    >
      <body>
        {children}
      </body>
    </html>
  );
}
