/**
 * A Sentry-compatible DSN (`https://<key>@<host>/<project>`) and the
 * envelope endpoint it points at. Nothing binds the platform to a
 * particular vendor: moving to a self-hosted receiver in Kazakhstan is a
 * change of this one address in the configuration (ARCHITECTURE 15.3).
 */
export interface MonitoringTarget {
  /** Where an event is posted. */
  endpoint: string;
  /** The public key the receiver authenticates with. */
  publicKey: string;
  projectId: string;
  /** The DSN without its key — safe to log and to put in an envelope header. */
  publicDsn: string;
}

export class MonitoringDsnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitoringDsnError";
  }
}

export function parseMonitoringDsn(dsn: string): MonitoringTarget {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new MonitoringDsnError("Must be a URL like https://<key>@host/<project>");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MonitoringDsnError("Must use http or https");
  }
  const projectId = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!url.username || !projectId) {
    throw new MonitoringDsnError("Must be a URL like https://<key>@host/<project>");
  }
  return {
    endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
    publicKey: url.username,
    projectId,
    publicDsn: `${url.protocol}//${url.host}/${projectId}`,
  };
}
