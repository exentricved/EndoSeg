/* eslint-disable react-refresh/only-export-components */
import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "PULSE v3 - Liver",
  description: "Hosted liver annotation and multi-review workspace.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
