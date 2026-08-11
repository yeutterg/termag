const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { createBroker } = require("../../server/broker");
const { runtimeSessionId } = require("../../server/runtime-id");

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(String(payload)));
  }

  close(code, reason) {
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close");
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

describe("multi-machine broker registry", () => {
  test("keeps every uniquely named agent connected under one web user", async () => {
    const laptopToken = `tmag_${"a".repeat(43)}`;
    const workstationToken = `tmag_${"b".repeat(43)}`;
    const records = new Map([
      [hashToken(laptopToken), { id: "device-1", userId: "user-1", name: "laptop" }],
      [hashToken(workstationToken), { id: "device-2", userId: "user-1", name: "workstation" }],
    ]);
    const prisma = {
      agentToken: {
        findFirst: jest.fn(async ({ where }) => records.get(where.tokenHash) || null),
        update: jest.fn(async () => ({})),
      },
    };
    const broker = createBroker({ prisma, wss: { clients: new Set() } });
    const laptop = new FakeSocket();
    const workstation = new FakeSocket();

    await broker.registerAgent(laptop, laptopToken);
    await broker.registerAgent(workstation, workstationToken);

    expect(broker.connectedDevices("user-1").map(device => device.name)).toEqual([
      "laptop",
      "workstation",
    ]);
    expect(laptop.readyState).toBe(1);
    expect(workstation.readyState).toBe(1);
    expect(laptop.sent.at(-1)).toMatchObject({ type: "hello", deviceName: "laptop" });
    expect(workstation.sent.at(-1)).toMatchObject({ type: "hello", deviceName: "workstation" });
  });

  test("acknowledges confirmed browser input only after the agent accepts it", async () => {
    const token = `tmag_${"c".repeat(43)}`;
    const record = { id: "device-1", userId: "user-1", name: "workstation" };
    const prisma = {
      agentToken: {
        findFirst: jest.fn(async ({ where }) =>
          where.tokenHash === hashToken(token) ? record : null
        ),
        update: jest.fn(async () => ({})),
      },
    };
    const broker = createBroker({ prisma, wss: { clients: new Set() } });
    const agent = new FakeSocket();
    await broker.registerAgent(agent, token);
    agent.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "inventory.snapshot",
          protocolVersion: 2,
          capabilities: { inventorySnapshots: true, fileUploads: true },
          inventory: {
            revision: 1,
            roots: [
              { key: "projects", path: "/Users/test/Projects", writable: true },
              { key: "hermes-space", path: "/Users/test/.hermes-space", writable: true },
            ],
            runtimes: [
              {
                kind: "herdr",
                available: true,
                sessions: [
                  {
                    id: "herdr-1",
                    name: "Herdr",
                    spaces: [
                      {
                        id: "space-1",
                        name: "hermes-space",
                        tabs: [
                          {
                            id: "tab-1",
                            name: "hermes",
                            panes: [
                              {
                                id: "pane-1",
                                terminalId: "terminal-1",
                                name: "Codex",
                                cwd: "/Users/test",
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        })
      ),
      false
    );
    await nextTurn();

    const sessionId = runtimeSessionId({
      deviceId: record.id,
      runtime: "herdr",
      runtimeSessionId: "herdr-1",
      spaceId: "space-1",
      tabId: "tab-1",
      paneId: "pane-1",
      terminalId: "terminal-1",
    });
    const browser = new FakeSocket();
    const register = broker.registerBrowser(
      browser,
      { headers: { authorization: `Bearer ${token}` } },
      new URL(`https://terminalz.test/api/ws/terminal?sessionId=${sessionId}`)
    );
    await nextTurn();
    const attach = agent.sent.find(message => message.type === "terminal-attach");
    expect(attach.requestId).toBeTruthy();
    agent.emit(
      "message",
      Buffer.from(JSON.stringify({ requestId: attach.requestId, data: {} })),
      false
    );
    await register;

    const inputId = "d".repeat(32);
    browser.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "input", inputId, data: "'/tmp/file.txt' " }))
    );
    await nextTurn();
    const input = agent.sent.find(message => message.type === "terminal-input");
    expect(input).toMatchObject({ streamId: attach.streamId, data: "'/tmp/file.txt' " });
    expect(input.requestId).toBeTruthy();
    expect(browser.sent).not.toContainEqual({ type: "terminal-input-complete", inputId });

    agent.emit(
      "message",
      Buffer.from(JSON.stringify({ requestId: input.requestId, data: {} })),
      false
    );
    await nextTurn();
    expect(browser.sent).toContainEqual({ type: "terminal-input-complete", inputId });

    const uploadId = "e".repeat(32);
    browser.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "file-upload-chunk",
          uploadId,
          fileName: "image.png",
          offset: 0,
          data: "aGVsbG8=",
        })
      )
    );
    await nextTurn();
    const upload = agent.sent.find(message => message.type === "file.upload-chunk");
    expect(upload).toMatchObject({
      rootKey: "hermes-space",
      relativeDirectory: "",
      containerName: "hermes-space",
      fileName: "image.png",
    });
    agent.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          requestId: upload.requestId,
          data: { path: "/opt/data/.terminalz-uploads/image.png" },
        })
      ),
      false
    );
    await nextTurn();
    expect(browser.sent).toContainEqual({
      type: "file-upload-complete",
      uploadId,
      offset: 0,
      path: "/opt/data/.terminalz-uploads/image.png",
    });
  });
});
