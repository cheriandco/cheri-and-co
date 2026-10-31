import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Inter } from "next/font/google";
import "./globals.css";

const serif = Cormorant_Garamond({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-serif", display: "swap" });
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Cheri & Co.", template: "%s · Cheri & Co." },
  description: "AI Commerce & Business Operations Platform",
};
export const viewport: Viewport = { themeColor: "#2b2224", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>
        <div className="demo-banner" role="status">
          <span>DEMO ENVIRONMENT</span><i aria-hidden>·</i><span>SAMPLE DATA</span><i aria-hidden>·</i><span>NOT CONNECTED TO LIVE BUSINESS SYSTEMS</span>
        </div>
        {children}
      </body>
    </html>
  );
}
