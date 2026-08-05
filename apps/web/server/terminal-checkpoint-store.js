const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FULL_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TAIL_BYTES = 1024 * 1024;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Owns the replayable terminal state for mirrored runtimes. A checkpoint and
 * its ANSI tail are valid only while every sequence number is contiguous.
 */
function createTerminalCheckpointStore(options = {}) {
  const maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
  const maxFullBytes = options.maxFullBytes ?? DEFAULT_MAX_FULL_BYTES;
  const maxTailBytes = options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const activeSessionIds = options.activeSessionIds ?? (() => new Set());
  const sequences = new Map();
  const checkpoints = new Map();
  const requests = new Map();
  let bytes = 0;

  function clearCheckpoint(sessionId) {
    const checkpoint = checkpoints.get(sessionId);
    if (!checkpoint) {
      return;
    }
    bytes = Math.max(0, bytes - checkpoint.fullBytes - checkpoint.tailBytes);
    checkpoints.delete(sessionId);
  }

  function trim(exemptSessionId) {
    while (bytes > maxCacheBytes) {
      let oldest = null;
      for (const [sessionId, checkpoint] of checkpoints) {
        if (sessionId === exemptSessionId) {
          continue;
        }
        if (!oldest || checkpoint.at < oldest.checkpoint.at) {
          oldest = { sessionId, checkpoint };
        }
      }
      if (!oldest) {
        break;
      }
      clearCheckpoint(oldest.sessionId);
    }
  }

  function ingest(sessionId, frame) {
    const timestamp = now();
    const previous = sequences.get(sessionId);
    const expected = previous
      ? previous.sequence === 0xffffffff
        ? 1
        : previous.sequence + 1
      : frame.sequence;
    if (!frame.full && previous && frame.sequence !== expected) {
      clearCheckpoint(sessionId);
      sequences.set(sessionId, { sequence: frame.sequence, at: timestamp });
      return { gap: true };
    }
    sequences.set(sessionId, { sequence: frame.sequence, at: timestamp });

    let checkpoint = checkpoints.get(sessionId);
    if (frame.full) {
      requests.delete(sessionId);
      clearCheckpoint(sessionId);
      const data = Buffer.from(frame.data);
      checkpoint = {
        full: [data],
        fullBytes: data.length,
        building: !frame.checkpointEnd,
        tail: [],
        tailBytes: 0,
        sequence: frame.sequence,
        at: timestamp,
      };
      checkpoints.set(sessionId, checkpoint);
      bytes += data.length;
    } else if (frame.checkpointContinuation) {
      if (checkpoint?.building) {
        const data = Buffer.from(frame.data);
        checkpoint.full.push(data);
        checkpoint.fullBytes += data.length;
        bytes += data.length;
        checkpoint.sequence = frame.sequence;
        checkpoint.at = timestamp;
        checkpoint.building = !frame.checkpointEnd;
      } else {
        clearCheckpoint(sessionId);
        checkpoint = null;
      }
      if (checkpoint?.fullBytes > maxFullBytes) {
        clearCheckpoint(sessionId);
        checkpoint = null;
      }
    } else if (checkpoint?.building) {
      clearCheckpoint(sessionId);
      checkpoint = null;
    } else if (checkpoint) {
      const data = Buffer.from(frame.data);
      checkpoint.tail.push(data);
      checkpoint.tailBytes += data.length;
      bytes += data.length;
      checkpoint.sequence = frame.sequence;
      checkpoint.at = timestamp;
      if (checkpoint.tailBytes > maxTailBytes) {
        clearCheckpoint(sessionId);
        checkpoint = null;
      }
    }
    trim(sessionId);
    return { gap: false, checkpoint: checkpoint ?? null };
  }

  function replay(sessionId) {
    const checkpoint = checkpoints.get(sessionId);
    if (!checkpoint) {
      return null;
    }
    return {
      sequence: checkpoint.sequence,
      chunks: [...checkpoint.full, ...checkpoint.tail],
    };
  }

  function claimCheckpointRequest(sessionId, cooldownMs = 5000) {
    if (checkpoints.has(sessionId)) {
      return false;
    }
    const timestamp = now();
    const previous = requests.get(sessionId);
    if (previous !== undefined && timestamp - previous <= cooldownMs) {
      return false;
    }
    requests.set(sessionId, timestamp);
    return true;
  }

  function drop(sessionId) {
    clearCheckpoint(sessionId);
    sequences.delete(sessionId);
    requests.delete(sessionId);
  }

  function sweep() {
    const cutoff = now() - ttlMs;
    const active = activeSessionIds();
    for (const [sessionId, state] of sequences) {
      if (state.at < cutoff && !active.has(sessionId)) {
        sequences.delete(sessionId);
      }
    }
    for (const [sessionId, state] of checkpoints) {
      if (state.at < cutoff && !active.has(sessionId)) {
        clearCheckpoint(sessionId);
      }
    }
    for (const [sessionId, requestedAt] of requests) {
      if (requestedAt < cutoff && !active.has(sessionId)) {
        requests.delete(sessionId);
      }
    }
  }

  return {
    ingest,
    replay,
    has: sessionId => checkpoints.has(sessionId),
    claimCheckpointRequest,
    releaseCheckpointRequest: sessionId => requests.delete(sessionId),
    clearCheckpoint,
    drop,
    sweep,
    stats: () => ({ bytes, checkpoints: checkpoints.size, sequences: sequences.size }),
  };
}

module.exports = { createTerminalCheckpointStore };
