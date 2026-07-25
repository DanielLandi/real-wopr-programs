import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "W.O.P.R.",
  description: "real-wopr — the cabinet itself",
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
