// Tiny structured-ish logger. Avoids pulling in winston/pino for the MVP
// but keeps a consistent shape so swapping it out later is easy.

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = levels[process.env.LOG_LEVEL] || levels.info;

function fmt(level, scope, msg, extra) {
  const ts = new Date().toISOString();
  const base = `[${ts}] ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra && Object.keys(extra).length) {
    return `${base} ${JSON.stringify(extra)}`;
  }
  return base;
}

function make(scope) {
  return {
    debug: (msg, extra) => levels.debug >= minLevel && console.log(fmt('debug', scope, msg, extra)),
    info: (msg, extra) => levels.info >= minLevel && console.log(fmt('info', scope, msg, extra)),
    warn: (msg, extra) => levels.warn >= minLevel && console.warn(fmt('warn', scope, msg, extra)),
    error: (msg, extra) => levels.error >= minLevel && console.error(fmt('error', scope, msg, extra)),
  };
}

module.exports = { make };
