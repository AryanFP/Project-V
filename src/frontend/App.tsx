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
 * the auth handshake using DEV_DEFAULT_USER_ID from .env (read via
 * /api/dev/user — see api/dev.ts).
 *
 * A `?userId=…` query param overrides the env default if present.
 *
 * The endpoint returns null when NODE_ENV=production, so the override is
 * unreachable in prod.
 *
 * Returns: { userId: string | null, loading: boolean }
 *   - loading: the env fetch is in-flight (very brief; one localhost call)
 *   - userId:  the resolved override, or null if not applicable
 */
function useDevUserOverride(): { userId: string | null; loading: boolean } {
  const [state, setState] = useState<{ userId: string | null; loading: boolean }>({
    userId: null,
    loading: true,
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      setState({ userId: null, loading: false });
      return;
    }

    const params = new URLSearchParams(window.location.search);

    // Real auth tokens take priority — never override the production path.
    if (params.has("aos_signed_user_token") || params.has("aos_temp_token")) {
      setState({ userId: null, loading: false });
      return;
    }

    // Explicit ?userId=… wins over the env default. No fetch needed.
    const queryUser = params.get("userId");
    if (queryUser) {
      setState({ userId: queryUser, loading: false });
      return;
    }

    let cancelled = false;
    fetch("/api/dev/user")
      .then((res) => res.json())
      .then((data: { userId: string | null }) => {
        if (cancelled) return;
        setState({
          userId: typeof data?.userId === "string" && data.userId ? data.userId : null,
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ userId: null, loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export default function App() {
  const auth = useMentraAuth();
  const { userId: devUserId, loading: devUserLoading } = useDevUserOverride();

  // If a dev override is present, short-circuit the Mentra auth states.
  // Treat the user as authenticated so HomePage mounts and the SSE /
  // capture flows start. The dev fetch is on localhost so loading is brief.
  const userId = devUserId ?? auth.userId;
  const isLoading = devUserId ? false : devUserLoading || auth.isLoading;
  const error = devUserId ? null : auth.error;
  const isAuthenticated = devUserId ? true : auth.isAuthenticated;

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
