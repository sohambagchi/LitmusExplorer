import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query and return whether it currently matches.
 *
 * This hook is intentionally small and dependency-free so it can be used in
 * layout primitives (like the App shell) without pulling in extra libraries.
 *
 * @param query - A media query string (example: "(min-width: 1024px)").
 * @param defaultValue - Used during the first render before `matchMedia` exists.
 */
export const useMediaQuery = (query: string, defaultValue = false) => {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return defaultValue;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQueryList = window.matchMedia(query);

    const handleChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };

    // Sync in case the query changed between renders.
    setMatches(mediaQueryList.matches);

    if (typeof mediaQueryList.addEventListener === "function") {
      mediaQueryList.addEventListener("change", handleChange);
      return () => {
        mediaQueryList.removeEventListener("change", handleChange);
      };
    }

    mediaQueryList.addListener(handleChange);
    return () => {
      mediaQueryList.removeListener(handleChange);
    };
  }, [query]);

  return matches;
};

