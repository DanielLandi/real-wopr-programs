import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NORAD TERMINAL",
  description: "real-wopr — operator console, leased line at 9600 baud",
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
