const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { createBroker } = require("../../server/broker");

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
});
