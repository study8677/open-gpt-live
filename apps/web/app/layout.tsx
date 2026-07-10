import "./globals.css";

export const metadata = {
  title: "OpenGPT Live",
  description: "Open, interruptible realtime voice AI over WebSocket"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
