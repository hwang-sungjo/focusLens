const counters = new Map();

const normalizeLabels = (labels) => Object.fromEntries(
  Object.entries(labels)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right)),
);

const metricKey = (name, labels) => `${name}:${JSON.stringify(normalizeLabels(labels))}`;

const recordMetric = (name, labels = {}, increment = 1) => {
  const normalizedLabels = normalizeLabels(labels);
  const key = metricKey(name, normalizedLabels);
  const current = counters.get(key) ?? { name, labels: normalizedLabels, value: 0 };
  current.value += increment;
  counters.set(key, current);
  return current.value;
};

const getMetricsSnapshot = () => Array.from(counters.values())
  .sort((left, right) => metricKey(left.name, left.labels).localeCompare(metricKey(right.name, right.labels)))
  .map((metric) => ({ ...metric }));

const logEvent = (event, fields = {}, level = 'info') => {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const writer = level === 'error' ? console.error : console.log;
  writer(JSON.stringify(payload));
};

module.exports = { recordMetric, getMetricsSnapshot, logEvent };
