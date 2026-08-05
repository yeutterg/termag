const { createTmuxStatusClassifier } = require("../../server/tmux-status");

describe("tmux status classifier", () => {
  it("uses fresh output before bell, exit, and prompt facts", () => {
    const classifier = createTmuxStatusClassifier({ workingThresholdSec: 8 });
    expect(
      classifier.classify(
        { id: "s1", status: "idle" },
        { activityAgeSec: 2, bell: true, lastExit: 1, currentCommand: "zsh" }
      )
    ).toBe("working");
    expect(classifier.classify({ id: "s1" }, { activityAgeSec: 9, bell: true })).toBe("waiting");
    expect(classifier.classify({ id: "s1" }, { activityAgeSec: 9, lastExit: 1 })).toBe("error");
    expect(
      classifier.classify({ id: "s1" }, { activityAgeSec: 9, lastExit: 0, currentCommand: "zsh" })
    ).toBe("idle");
  });

  it("does not let same-named windows cross tmux session boundaries", () => {
    const classifier = createTmuxStatusClassifier();
    const state = classifier.buildLiveState([
      { name: "other", windows: [{ name: "agent", target: "other:0" }] },
    ]);
    const session = {
      tmuxName: "wanted:agent",
      tmuxWindowName: "agent",
      project: { tmuxSessionName: "wanted" },
    };
    expect(classifier.isLive(session, state)).toBe(false);
  });

  it("uses PTY status only while fresh and actively viewed", () => {
    const ptyStatuses = new Map([["s1", { status: "working", at: 900 }]]);
    const classifier = createTmuxStatusClassifier({
      ptyStatuses,
      now: () => 1000,
      ptyFreshMs: 200,
      hasAttachedViewer: id => id === "s1",
    });
    expect(classifier.classify({ id: "s1", status: "idle" }, null)).toBe("working");
    expect(classifier.classify({ id: "s2", status: "idle" }, null)).toBe("idle");
  });
});
