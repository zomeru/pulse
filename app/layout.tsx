import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pulse — everyone is here",
  description:
    "A living world of anonymous strangers. Tap a light, say hello, and talk. No accounts, no history, nothing stored.",
  applicationName: "Pulse",
  openGraph: {
    title: "Pulse — everyone is here",
    description:
      "A living world of anonymous strangers. Tap a light, say hello, and talk.",
  },
};

export const viewport: Viewport = {
  themeColor: "#03050b",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  // Needed so `env(safe-area-inset-*)` resolves for notched devices. We never
  // disable pinch zoom — that would be an accessibility regression.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full bg-void text-ink">{children}</body>
    </html>
  );
}
