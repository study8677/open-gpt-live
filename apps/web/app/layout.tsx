import "./globals.css";

export const metadata = {
  title: "OpenGPT Live",
  description: "Text-loop MVP for OpenGPT Live"
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
