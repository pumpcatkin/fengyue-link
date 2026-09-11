function orderLoginCandidates(domains) {
  const unique = new Map();
  for (const item of Array.isArray(domains) ? domains : []) {
    if (!item || item.online !== true) continue;
    const origin = String(item.finalOrigin || item.origin || "").trim();
    if (!origin) continue;
    const latency = Number(item.latency);
    const candidate = {
      origin,
      latency: Number.isFinite(latency) && latency >= 0 ? latency : Number.MAX_SAFE_INTEGER
    };
    const previous = unique.get(origin);
    if (!previous || candidate.latency < previous.latency) unique.set(origin, candidate);
  }
  return [...unique.values()].sort((left, right) => left.latency - right.latency || left.origin.localeCompare(right.origin));
}

module.exports = { orderLoginCandidates };
