/**
 * A small metrics registry in the Prometheus text format (ARCHITECTURE
 * 15.3): counters, gauges and histograms with labels, rendered for a
 * scrape. Written here rather than taken from a library because the whole
 * need is a few dozen series, and because every label value goes through
 * the same check — metrics carry no personal data (only route templates,
 * job names, channels and outcomes).
 *
 * Sampled values that only make sense at scrape time (queue depth,
 * dependency state) are registered as collectors and asked for then.
 */

export type Labels = Readonly<Record<string, string | number>>;

type MetricType = "counter" | "gauge" | "histogram";

/** Guards cardinality: one metric never grows past this many label sets. */
const MAX_SERIES_PER_METRIC = 200;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function seriesKey(labels: Labels): string {
  const names = Object.keys(labels).sort();
  return names.map((name) => `${name}=${String(labels[name])}`).join(",");
}

function renderLabels(labels: Labels, extra?: Record<string, string>): string {
  const all = { ...labels, ...extra };
  const names = Object.keys(all).sort();
  if (names.length === 0) {
    return "";
  }
  const parts = names.map(
    (name) => `${name}="${escapeLabelValue(String(all[name] as string | number))}"`,
  );
  return `{${parts.join(",")}}`;
}

interface Series {
  labels: Labels;
  value: number;
  /** Histogram only: counts per bucket and the sum of observations. */
  buckets?: number[];
  sum?: number;
}

export class Metric {
  private readonly series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly type: MetricType,
    readonly help: string,
    /** Histogram bucket bounds in ascending order (`+Inf` is implied). */
    readonly bounds: readonly number[] = [],
  ) {
    if (!NAME.test(name)) {
      throw new Error(`Invalid metric name "${name}"`);
    }
  }

  private of(labels: Labels): Series | undefined {
    const key = seriesKey(labels);
    let series = this.series.get(key);
    if (!series) {
      if (this.series.size >= MAX_SERIES_PER_METRIC) {
        return undefined;
      }
      series = {
        labels,
        value: 0,
        ...(this.type === "histogram" && { buckets: this.bounds.map(() => 0), sum: 0 }),
      };
      this.series.set(key, series);
    }
    return series;
  }

  increment(labels: Labels = {}, by = 1): void {
    const series = this.of(labels);
    if (series) {
      series.value += by;
    }
  }

  set(labels: Labels, value: number): void {
    const series = this.of(labels);
    if (series) {
      series.value = value;
    }
  }

  observe(labels: Labels, value: number): void {
    const series = this.of(labels);
    if (!series?.buckets) {
      return;
    }
    series.value += 1;
    series.sum = (series.sum ?? 0) + value;
    for (let index = 0; index < this.bounds.length; index += 1) {
      if (value <= this.bounds[index]!) {
        series.buckets[index] = (series.buckets[index] ?? 0) + 1;
      }
    }
  }

  /** Forgets every series (tests; a process never needs it). */
  clear(): void {
    this.series.clear();
  }

  render(): string[] {
    if (this.series.size === 0) {
      return [];
    }
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
    for (const series of this.series.values()) {
      if (this.type === "histogram") {
        // Buckets are counted cumulatively when observed, as the format wants.
        for (let index = 0; index < this.bounds.length; index += 1) {
          lines.push(
            `${this.name}_bucket${renderLabels(series.labels, { le: String(this.bounds[index]) })} ${String(series.buckets?.[index] ?? 0)}`,
          );
        }
        lines.push(
          `${this.name}_bucket${renderLabels(series.labels, { le: "+Inf" })} ${String(series.value)}`,
        );
        lines.push(`${this.name}_sum${renderLabels(series.labels)} ${String(series.sum ?? 0)}`);
        lines.push(`${this.name}_count${renderLabels(series.labels)} ${String(series.value)}`);
      } else {
        lines.push(`${this.name}${renderLabels(series.labels)} ${String(series.value)}`);
      }
    }
    return lines;
  }
}

/** Asked for its values when metrics are scraped (queue depth, dependencies). */
export type MetricCollector = () => Promise<void> | void;

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  private readonly collectors: MetricCollector[] = [];

  counter(name: string, help: string): Metric {
    return this.register(new Metric(name, "counter", help));
  }

  gauge(name: string, help: string): Metric {
    return this.register(new Metric(name, "gauge", help));
  }

  histogram(name: string, help: string, bounds: readonly number[]): Metric {
    return this.register(new Metric(name, "histogram", help, bounds));
  }

  /** Runs before every render; a collector that fails doesn't stop the scrape. */
  collect(collector: MetricCollector): void {
    this.collectors.push(collector);
  }

  async render(): Promise<string> {
    await Promise.all(
      this.collectors.map(async (collector) => {
        try {
          await collector();
        } catch {
          // A metric nobody could sample is simply absent from the scrape.
        }
      }),
    );
    const blocks = [...this.metrics.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((metric) => metric.render());
    return blocks.length > 0 ? `${blocks.join("\n")}\n` : "";
  }

  private register(metric: Metric): Metric {
    if (this.metrics.has(metric.name)) {
      throw new Error(`Metric ${metric.name} is registered twice`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }
}
