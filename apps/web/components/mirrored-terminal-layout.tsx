"use client";

import type { CSSProperties } from "react";
import type { Tab } from "./types";
import { TerminalPane } from "./terminal/terminal-pane";

type Rect = { x: number; y: number; width: number; height: number };
type LayoutPane = { pane_id: string; focused?: boolean; rect: Rect };
type HerdrLayout = {
  zoomed?: boolean;
  focused_pane_id?: string;
  area: Rect;
  panes: LayoutPane[];
};

function parseLayout(value?: string | null): HerdrLayout | null {
  if (!value) {
    return null;
  }
  try {
    const layout = JSON.parse(value) as Partial<HerdrLayout>;
    if (!layout.area || !Array.isArray(layout.panes)) {
      return null;
    }
    if (layout.area.width <= 0 || layout.area.height <= 0) {
      return null;
    }
    return layout as HerdrLayout;
  } catch {
    return null;
  }
}

function paneStyle(area: Rect, rect: Rect): CSSProperties {
  const left = ((rect.x - area.x) / area.width) * 100;
  const top = ((rect.y - area.y) / area.height) * 100;
  return {
    left: `${Math.max(0, left)}%`,
    top: `${Math.max(0, top)}%`,
    width: `${Math.min(100 - Math.max(0, left), (rect.width / area.width) * 100)}%`,
    height: `${Math.min(100 - Math.max(0, top), (rect.height / area.height) * 100)}%`,
  };
}

export function MirroredTerminalLayout({
  tabs,
  connected,
  liveTitles,
  onTitleChange,
}: {
  tabs: Tab[];
  connected: boolean;
  liveTitles: Record<string, string>;
  onTitleChange: (sessionId: string, title: string) => void;
}) {
  const layout = parseLayout(tabs[0]?.layout);
  const paneById = new Map(tabs.map(tab => [tab.runtimePaneId, tab]));
  const layoutPanes = layout?.panes.filter(pane => paneById.has(pane.pane_id)) ?? [];
  const visiblePanes =
    layout?.zoomed && layout.focused_pane_id
      ? layoutPanes.filter(pane => pane.pane_id === layout.focused_pane_id)
      : layoutPanes;

  if (!layout || visiblePanes.length !== tabs.length || tabs.length === 1) {
    const tab =
      tabs.find(item => item.runtimePaneId === layout?.focused_pane_id) ??
      tabs.find(item => item.focused) ??
      tabs[0];
    if (!tab?.session) {
      return null;
    }
    return (
      <TerminalPane
        key={tab.session.id}
        active
        sessionId={tab.session.id}
        title={liveTitles[tab.session.id] || tab.runtimePaneName || tab.name}
        status={connected ? tab.session.status : "sleeping"}
        onTitleChange={onTitleChange}
        hideHeader
      />
    );
  }

  return (
    <div className="relative min-h-0 flex-1 bg-line">
      {visiblePanes.map(pane => {
        const tab = paneById.get(pane.pane_id);
        if (!tab?.session) {
          return null;
        }
        return (
          <div
            key={pane.pane_id}
            className="absolute flex min-h-0 overflow-hidden p-px"
            style={paneStyle(layout.area, pane.rect)}
          >
            <TerminalPane
              active
              sessionId={tab.session.id}
              title={liveTitles[tab.session.id] || tab.runtimePaneName || tab.name}
              status={connected ? tab.session.status : "sleeping"}
              onTitleChange={onTitleChange}
            />
          </div>
        );
      })}
    </div>
  );
}
