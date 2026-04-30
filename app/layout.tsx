import type { Metadata } from "next";
import "streamdown/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "ai-sdk-demo",
  description: "AI SDK agent dev flow playground for workspace exploration and tool experiments.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
