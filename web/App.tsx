/** Coquille de l'interface : navigation par ancre + état temps réel. */
import { useEffect, useState } from "react";
import { LiveProvider, useLive, lastCycleLabel } from "./live.js";
import OverviewPage from "./pages/OverviewPage.js";
import MapPage from "./pages/MapPage.js";
import PlayersPage from "./pages/PlayersPage.js";
import ContainersPage from "./pages/ContainersPage.js";
import AlertsPage from "./pages/AlertsPage.js";
import SettingsPage from "./pages/SettingsPage.js";

const TABS = [
  ["#/overview", "Vue d'ensemble"],
  ["#/map", "Carte"],
  ["#/players", "Joueurs"],
  ["#/containers", "Conteneurs"],
  ["#/alerts", "Alertes"],
  ["#/settings", "Réglages"],
] as const;

function useRoute(): string {
  const [hash, setHash] = useState(location.hash || "#/overview");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/overview");
    window.addEventListener("hashchange", on);
    if (!location.hash) location.hash = "#/overview";
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function Shell() {
  const route = useRoute();
  const live = useLive();

  let page: JSX.Element = <OverviewPage />;
  if (route.startsWith("#/map")) page = <MapPage route={route} />;
  else if (route.startsWith("#/players")) page = <PlayersPage route={route} />;
  else if (route.startsWith("#/containers")) page = <ContainersPage />;
  else if (route.startsWith("#/alerts")) page = <AlertsPage route={route} />;
  else if (route.startsWith("#/settings")) page = <SettingsPage />;

  return (
    <>
      <header className="topbar">
        <span className="brand">CoreProtect-Watcher</span>
        <nav className="tabs">
          {TABS.map(([href, label]) => (
            <a key={href} href={href} className={route.startsWith(href) ? "active" : ""}>
              {label}
              {href === "#/alerts" && live.unread > 0 ? <span className="badge">{live.unread}</span> : null}
            </a>
          ))}
        </nav>
        <span className="muted right" style={{ marginLeft: "auto" }}>
          {live.connected ? "direct" : "hors ligne"} · cycle {lastCycleLabel(live.lastCycleAt)}
        </span>
      </header>
      <main>{page}</main>
    </>
  );
}

export default function App() {
  return (
    <LiveProvider>
      <Shell />
    </LiveProvider>
  );
}
