import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Humline — Voice to MIDI",
  description: "Record a melody with your voice, edit its notes in a piano roll, and export MIDI. Audio is processed on your device.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
