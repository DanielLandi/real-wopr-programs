import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NORAD BIG BOARD",
  description: "real-wopr — the war-room command display",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
