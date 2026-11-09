/**
 * The `HEALTHCHECK` of the `api` image (TASK-055): `GET /health` of the API
 * process in this container. Exits 0 when it answers 200, 1 otherwise —
 * within three seconds, so a hung process counts as unhealthy.
 */
const port = process.env.PORT ?? "3000";

fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
  .then((response) => {
    process.exit(response.ok ? 0 : 1);
  })
  .catch(() => {
    process.exit(1);
  });
