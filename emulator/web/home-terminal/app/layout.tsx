import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IMSAI 8080",
  description: "real-wopr — David Lightman's bedroom, dial-up at 300 baud",
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
