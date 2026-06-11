import "./globals.css";

export const metadata = {
  title: "Side Kick",
  description: "Tasks that need a human — Veloka pipeline",
  manifest: "/manifest.json",
  // iOS add-to-home-screen: standalone shell + title on the home screen.
  appleWebApp: {
    capable: true,
    title: "Side Kick",
    statusBarStyle: "default",
  },
};

// theme-color drives the browser/PWA chrome color (matches --bg).
export const viewport = {
  themeColor: "#F5F3EE",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=DM+Serif+Display:ital@0;1&display=swap"
          rel="stylesheet"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
        {/* PWA installability (manifest only — NO service worker; a SW cache
            would serve stale data on this live feed). */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#F5F3EE" />
        {/* iOS add-to-home-screen metas */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Side Kick" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="apple-touch-icon" href="/icon.svg" />
      </head>
      <body>{children}</body>
    </html>
  );
}
