import { useState, useEffect, useCallback, createContext, useContext } from "react";
import { useMentraAuth } from "@mentra/react";
import HomePage from "./pages/home/HomePage";

// Theme Context
interface ThemeContextValue {
  theme: "light" | "dark";
  isDarkMode: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  isDarkMode: false,
  toggleTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

/**
 * Dev-only bypass for the MentraOS auth flow.
 *
 * The MentraOS webview opens the registered Public URL on the phone, which
 * goes phone → ngrok → laptop. At a venue with slow Wi-Fi that's painful for
 * the JS bundle + every SSE reconnect. So in development, you can open
 * `http://localhost:3000/` directly in a regular browser tab and we skip
 * the auth handshake using BUN_PUBLIC_DEV_DEFAULT_USER_ID from .env.
 * A `?userId=…` query param overrides the env default if present.
 *
 * "Dev mode" is detected via NODE_ENV=development OR hostname=localhost.
 * The override is unreachable on a production host with NODE_ENV=production.
 */
function useDevUserOverride(): string | null {
  if (typeof window === "undefined") return null;

  // Bun's HTML bundler exposes BUN_PUBLIC_* env vars on `process.env` at
  // build time (not `import.meta.env`, which is undefined in this bundler
  // version). Read defensively — both objects may be missing depending on
  // the bundler / runtime combination.
  const env =
    (typeof process !== "undefined" && (process as any).env) || ({} as Record<string, string | undefined>);
  const isDev =
    env.NODE_ENV === "development" ||
    // Fallback: localhost is always treated as dev for this escape hatch.
    /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(window.location.hostname);
  if (!isDev) return null;

  const params = new URLSearchParams(window.location.search);

  // Block the override if the real auth tokens are present — those are still
  // the authoritative source when the page was opened from the MentraOS app.
  if (params.has("aos_signed_user_token") || params.has("aos_temp_token")) {
    return null;
  }

  // Priority: explicit ?userId=… > BUN_PUBLIC_DEV_DEFAULT_USER_ID from .env.
  const queryUser = params.get("userId");
  if (queryUser) return queryUser;

  const envUser = env.BUN_PUBLIC_DEV_DEFAULT_USER_ID;
  if (typeof envUser === "string" && envUser.length > 0) return envUser;

  return null;
}

export default function App() {
  const auth = useMentraAuth();
  const devUser = useDevUserOverride();

  // If a dev override is present (localhost + ?userId=…), short-circuit the
  // Mentra auth states. Treat the user as authenticated so HomePage mounts
  // and the SSE / capture flows start.
  const userId = devUser ?? auth.userId;
  const isLoading = devUser ? false : auth.isLoading;
  const error = devUser ? null : auth.error;
  const isAuthenticated = devUser ? true : auth.isAuthenticated;

  // Theme state with localStorage persistence
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("theme");
      if (saved === "dark" || saved === "light") return saved;
    }
    return "light";
  });

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      localStorage.setItem("theme", next);
      return next;
    });
  }, []);

  // Apply dark class to document root
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // Sync theme with backend when user authenticates
  useEffect(() => {
    if (isAuthenticated && userId) {
      fetch(`/api/theme-preference?userId=${encodeURIComponent(userId)}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.theme === "dark" || data.theme === "light") {
            setTheme(data.theme);
            localStorage.setItem("theme", data.theme);
          }
        })
        .catch(() => {});
    }
  }, [isAuthenticated, userId]);

  // Save theme to backend on change
  useEffect(() => {
    if (isAuthenticated && userId) {
      fetch("/api/theme-preference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, theme }),
      }).catch(() => {});
    }
  }, [theme, isAuthenticated, userId]);

  // Keyboard shortcut: Cmd+Shift+D to toggle theme
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "d" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        toggleTheme();
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [toggleTheme]);

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-foreground" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center p-8 max-w-md">
          <h2 className="text-destructive text-lg font-semibold mb-2">
            Authentication Error
          </h2>
          <p className="text-destructive/80 text-sm mb-4">{error}</p>
          <p className="text-muted-foreground text-xs">
            Please ensure you are opening this page from the MentraOS app.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ThemeContext.Provider
      value={{ theme, isDarkMode: theme === "dark", toggleTheme }}
    >
      <div className="font-sans bg-background text-foreground min-h-screen">
        <HomePage userId={userId || ""} />
      </div>
    </ThemeContext.Provider>
  );
}
