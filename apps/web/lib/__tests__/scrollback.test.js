// scrollback is intentionally CommonJS because it is loaded by the custom broker.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createScrollbackStore } = require("../../server/scrollback");

// `clock` fixes createdAt for every row, reproducing the case the seq column
// exists for: several flushes inside a single millisecond, where createdAt
// alone cannot order them and cuid ids are not time-sortable.
function fakePrisma({ clock = null } = {}) {
  let nextId = 1;
  const rows = [];
  return {
    rows,
    scrollbackChunk: {
      findMany: jest.fn(async args => {
        const matching = rows.filter(row => row.sessionId === args.where.sessionId);
        const terms = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
        const ordered = [...matching].sort((a, b) => {
          for (const term of terms) {
            const [field, direction] = Object.entries(term)[0];
            const delta = direction === "desc" ? b[field] - a[field] : a[field] - b[field];
            if (delta !== 0) {
              return delta;
            }
          }
          return 0;
        });
        return (args.take ? ordered.slice(0, args.take) : ordered).map(row => {
          const selected = {};
          for (const key of Object.keys(args.select)) {
            selected[key] = row[key];
          }
          return selected;
        });
      }),
      create: jest.fn(async ({ data }) => {
        const id = nextId++;
        const row = { ...data, id: `chunk-${id}`, createdAt: clock ?? id };
        rows.push(row);
        return { id: row.id };
      }),
      deleteMany: jest.fn(async ({ where }) => {
        const ids = new Set(where.id.in);
        let count = 0;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (ids.has(rows[index].id)) {
            rows.splice(index, 1);
            count += 1;
          }
        }
        return { count };
      }),
    },
  };
}

describe("bounded scrollback store", () => {
  const original = { ...process.env };

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.TERMAG_SCROLLBACK_BATCH_BYTES = "1024";
    process.env.TERMAG_SCROLLBACK_BATCH_MS = "50";
    process.env.TERMAG_SCROLLBACK_MAX_BYTES = "2048";
    process.env.TERMAG_SCROLLBACK_MAX_LINES = "100";
  });

  afterEach(() => {
    process.env = { ...original };
    jest.useRealTimers();
  });

  it("batches adjacent terminal writes into one database row", async () => {
    const prisma = fakePrisma();
    const store = createScrollbackStore(prisma);
    store.append("session-1", "hello");
    store.append("session-1", " world\n");
    await jest.advanceTimersByTimeAsync(50);
    await store.flush("session-1");

    expect(prisma.scrollbackChunk.create).toHaveBeenCalledTimes(1);
    expect(prisma.rows[0].data).toBe("hello world\n");
    await store.close();
  });

  it("evicts old chunks at the byte bound and leaves no live timers on close", async () => {
    process.env.TERMAG_SCROLLBACK_BATCH_BYTES = "4";
    process.env.TERMAG_SCROLLBACK_MAX_BYTES = "8";
    const prisma = fakePrisma();
    const store = createScrollbackStore(prisma);
    await store.append("session-1", "aaaa");
    await store.append("session-1", "bbbb");
    await store.append("session-1", "cccc");
    await store.flush("session-1");

    expect(prisma.rows.map(row => row.data)).toEqual(["bbbb", "cccc"]);
    await store.close();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("trims a single oversized write to hard byte and line bounds", async () => {
    process.env.TERMAG_SCROLLBACK_BATCH_BYTES = "100";
    process.env.TERMAG_SCROLLBACK_MAX_BYTES = "8";
    process.env.TERMAG_SCROLLBACK_MAX_LINES = "2";
    const prisma = fakePrisma();
    const store = createScrollbackStore(prisma);
    store.append("session-1", "0\n1\n2\n3\n");
    await store.flush("session-1");

    expect(Buffer.byteLength(prisma.rows[0].data)).toBeLessThanOrEqual(8);
    expect(prisma.rows[0]).toMatchObject({ data: "2\n3\n", lineCount: 2 });
    await store.close();
  });

  it("preserves UTF-8 code points split across binary terminal frames", async () => {
    const prisma = fakePrisma();
    const store = createScrollbackStore(prisma);
    const encoded = Buffer.from("a€b", "utf8");
    store.append("session-1", encoded.subarray(0, 2));
    store.append("session-1", encoded.subarray(2));
    await store.flush("session-1");

    expect(prisma.rows[0].data).toBe("a€b");
    await store.close();
  });

  it("honors a smaller replay byte budget inside the newest row", async () => {
    process.env.TERMAG_SCROLLBACK_BATCH_BYTES = "2048";
    process.env.TERMAG_SCROLLBACK_MAX_BYTES = "2048";
    const prisma = fakePrisma();
    const store = createScrollbackStore(prisma);
    store.append("session-1", "x".repeat(1500));
    await store.flush("session-1");

    const chunks = await store.read("session-1", { maxBytes: 1024 });
    expect(chunks).toHaveLength(1);
    expect(Buffer.byteLength(chunks[0])).toBe(1024);
    await store.close();
  });

  it("replays in write order when several flushes share a timestamp", async () => {
    // Every row lands on the same millisecond, so ordering by createdAt alone
    // is undefined and the replayed screen could come back scrambled.
    const prisma = fakePrisma({ clock: 1_700_000_000_000 });
    const store = createScrollbackStore(prisma);
    for (const line of ["first\n", "second\n", "third\n"]) {
      store.append("session-1", line);
      await store.flush("session-1");
    }

    expect(prisma.rows.map(row => row.seq)).toEqual([1, 2, 3]);
    expect((await store.read("session-1")).join("")).toBe("first\nsecond\nthird\n");
    await store.close();
  });

  it("continues a session's sequence across a broker restart", async () => {
    const prisma = fakePrisma({ clock: 1_700_000_000_000 });
    const first = createScrollbackStore(prisma);
    first.append("session-1", "before\n");
    await first.flush("session-1");
    await first.close();

    const second = createScrollbackStore(prisma);
    second.append("session-1", "after\n");
    await second.flush("session-1");

    expect(prisma.rows.map(row => row.seq)).toEqual([1, 2]);
    expect((await second.read("session-1")).join("")).toBe("before\nafter\n");
    await second.close();
  });
});
