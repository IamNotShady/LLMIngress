import "./globals.css";
import type { Metadata } from "next";
import { DM_Mono, Open_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { THEME_BOOTSTRAP_SCRIPT } from "./_ui/theme";

const sans = Open_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-open-sans",
  display: "swap",
});

// DM Mono ships no weight above 500; asking for 600 makes the browser
// synthesise a fake bold, so 500 is the ceiling everywhere in this console.
const mono = DM_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--font-dm-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "LLMIngress Console",
  description: "LLMIngress management console",
  icons: {
    icon: "/llmingress-icon.svg",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* Stamps data-theme before first paint so a stored preference never flashes. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: the theme bootstrap must run before paint
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
