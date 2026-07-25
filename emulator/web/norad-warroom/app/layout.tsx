import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NORAD SCREEN WALL",
  description: "real-wopr — the war room as a wall of synchronized monitors",
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
