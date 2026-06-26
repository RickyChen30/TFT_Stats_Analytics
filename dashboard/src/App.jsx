import React, { useEffect, useState } from "react";
import TierList from "./pages/TierList.jsx";
import EntityAnalysis from "./pages/EntityAnalysis.jsx";
import PlayerProfile from "./pages/PlayerProfile.jsx";
import TeamBuilder from "./pages/TeamBuilder.jsx";

const ChampionAnalysis = () => (
  <EntityAnalysis
    entityType="champion"
    title="Champion Analysis"
    subtitle="Win rate, average placement and play rate per champion"
  />
);
const AugmentAnalysis = () => (
  <EntityAnalysis
    entityType="augment"
    title="Augment Analysis"
    subtitle="Win rate, average placement and play rate per silver, gold and prismatic augment"
    augmentCategory="standard"
    highlightTraps
  />
);
const GodAugmentAnalysis = () => (
  <EntityAnalysis
    entityType="augment"
    title="God Augments"
    subtitle="Set 17 God Augments and boon choices"
    augmentCategory="god"
  />
);
const ItemAnalysis = () => (
  <EntityAnalysis
    entityType="item"
    title="Item Analysis"
    subtitle="Win rate, average placement and play rate per item"
  />
);

const PAGES = [
  { id: "tierlist", label: "Meta Tier List", component: TierList },
  { id: "champions", label: "Champion Analysis", component: ChampionAnalysis },
  { id: "augments", label: "Augment Analysis", component: AugmentAnalysis },
  { id: "god-augments", label: "God Augments", component: GodAugmentAnalysis },
  { id: "items", label: "Item Analysis", component: ItemAnalysis },
  { id: "builder", label: "Team Builder", component: TeamBuilder },
  { id: "player", label: "Player Search", component: PlayerProfile },
];

const DEFAULT_PAGE = "tierlist";
const isPage = (id) => PAGES.some((p) => p.id === id);
const pageFromHash = () => {
  const id = window.location.hash.replace(/^#\/?/, "");
  return isPage(id) ? id : DEFAULT_PAGE;
};

export default function App() {
  // Active page is mirrored in the URL hash so a reload restores the same page
  // (and pages are deep-linkable). The logo navigates back to the front page.
  const [active, setActive] = useState(pageFromHash);

  useEffect(() => {
    const onHash = () => setActive(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (id) => {
    setActive(id);
    const next = `#/${id}`;
    if (window.location.hash !== next) window.location.hash = next;
  };

  const Current = (PAGES.find((p) => p.id === active) || PAGES[0]).component;

  return (
    <div className="app app-topnav">
      <header className="topbar">
        <div className="brand" role="button" tabIndex={0} onClick={() => go(DEFAULT_PAGE)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && go(DEFAULT_PAGE)}>
          TFT <span>Meta</span> Analytics
        </div>
        <nav className="topnav">
          {PAGES.map((p) => (
            <div
              key={p.id}
              className={`topnav-item ${active === p.id ? "active" : ""}`}
              onClick={() => go(p.id)}
            >
              {p.label}
            </div>
          ))}
        </nav>
      </header>
      <main className="main">
        <Current />
      </main>
    </div>
  );
}
