import { applyLiveInventoryPatch } from "../live-inventory-patch";
import type { Project } from "../../components/types";

function project(): Project {
  return {
    id: "rp_one",
    name: "Space",
    rootKey: "Mac",
    relativePath: "",
    status: "working",
    tabs: [
      {
        id: "rt_one",
        name: "Agent",
        ordinal: 0,
        status: "working",
        runtimeTabStatus: "working",
        focused: true,
        session: { id: "rs_one", status: "working" },
      },
    ],
    deviceId: "device-1",
    runtime: "herdr",
    runtimeSessionId: "personal",
    runtimeSessionName: "Personal",
    runtimeSpaceName: "Space",
    runtimeOrdinal: 0,
    runtimeFocused: true,
  };
}

describe("live inventory patch application", () => {
  it("updates project, tab, and session status without replacing unaffected projects", () => {
    const target = project();
    const untouched = { ...project(), id: "rp_two" };
    const result = applyLiveInventoryPatch([target, untouched], {
      type: "inventory-patch",
      revision: 2,
      projects: [
        {
          id: "rp_one",
          status: "idle",
          runtimeFocused: false,
          tabs: [
            {
              id: "rt_one",
              status: "idle",
              runtimeTabStatus: "done",
              focused: false,
            },
          ],
        },
      ],
    });

    expect(result).not.toBe(target);
    expect(result[0]).toMatchObject({ status: "idle", runtimeFocused: false });
    expect(result[0].tabs[0]).toMatchObject({
      status: "idle",
      runtimeTabStatus: "done",
      focused: false,
      session: { status: "idle" },
    });
    expect(result[1]).toBe(untouched);
  });

  it("ignores malformed or irrelevant patches without triggering a render", () => {
    const projects = [project()];
    expect(applyLiveInventoryPatch(projects, { type: "other", projects: [] })).toBe(projects);
    expect(
      applyLiveInventoryPatch(projects, {
        type: "inventory-patch",
        projects: [{ id: "missing", status: "idle" }],
      })
    ).toBe(projects);
  });
});
