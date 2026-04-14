import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void (async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();

      await Promise.all(
        registrations
          .filter((registration) => !registration.active?.scriptURL.endsWith("/sw.js"))
          .map((registration) => registration.unregister())
      );

      const cacheKeys = await caches.keys();

      await Promise.all(cacheKeys.filter((key) => key.startsWith("memory-cache-")).map((key) => caches.delete(key)));

      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
    })();
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
