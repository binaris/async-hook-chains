// eslint-disable-next-line import/no-unresolved
const hooks = require('async_hooks');
const _ = require('lodash');

const MAX_REGISTRY_ENTRIES = 10000;

class RequestIdRegistry {
  constructor() {
    this.trigToReqId = {};
    this.unregisterQueue = new Set();
  }

  size() {
    return Object.keys(this.trigToReqId).length;
    // TODO: get size more efficiently. keep a counter ourselves?
  }

  register(queryId) {
    if (queryId) {
      const id = hooks.executionAsyncId();
      this.trigToReqId[id] = queryId;
    }
  }

  track(id, trigger) {
    const queryId = this.lookup(trigger);
    if (queryId) {
      this.trigToReqId[id] = queryId;
    }
  }

  lookup(id) {
    return this.trigToReqId[id || hooks.executionAsyncId()];
  }

  unregister(queryId) {
    if (!queryId) {
      return;
    }
    this.unregisterQueue.add(queryId);
    if (this.size() > MAX_REGISTRY_ENTRIES) {
      this.trigToReqId = _.pickBy(this.trigToReqId, val => !this.unregisterQueue.has(val));
      this.unregisterQueue = new Set();
    }
  }

}

function nowIso() {
  return (new Date()).toISOString();
}


function uncaughtHandler(err) {
  // TODO: stack trace
  if (err.message) {
    process.stderr.write(err.message);
    process.stderr.end();
    process.stderr.on('finish', () => {
      process.exit(1);
    });
  }
}


function init() {
  const registry = new RequestIdRegistry();

  // eslint-disable-next-line
  const wrapStreamRecord = function (payload, isErr) {
    return {
      s: payload,
      timestamp: nowIso(),
      reqId: registry.lookup() || 'global',
      err: isErr,
    };
  };

  const decoratedStreamWrite = (origWrite, origStream, chunk, encoding, cb, isErr) => {
    const payload = chunk.toString(encoding);
    const wrapper = wrapStreamRecord(payload, isErr);
    origWrite.apply(origStream, [JSON.stringify(wrapper), 'utf8', cb]);
    origWrite.apply(origStream, ['\n']);
  };

  hooks.createHook({
    init: (id, type, triggerId) => {
      // When a new Async context is created, we keep track of which context caused it
      // to be created. Thus we "chain" the async IDs, or at least get them all to point
      // to the relevant request ID from the async context of the Express handler.
      registry.track(id, triggerId);
    },
  }).enable();


  const origStdoutWrite = process.stdout.write;
  function hookedStdoutWrite(chunk, encoding, cb) {
    return decoratedStreamWrite(origStdoutWrite, process.stdout, chunk, encoding, cb, false);
  }
  process.stdout.write = hookedStdoutWrite;

  const origStderrWrite = process.stderr.write;
  function hookedStderrWrite(chunk, encoding, cb) {
    return decoratedStreamWrite(origStderrWrite, process.stderr, chunk, encoding, cb, true);
  }
  process.stderr.write = hookedStderrWrite;

  process.on('uncaughtException', uncaughtHandler);
  return registry;
}

module.exports.init = init;
