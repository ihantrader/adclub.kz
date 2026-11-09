import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { apiRoutes, type ApiRouteDefinition } from "@adclub/contracts";
import { z } from "zod";

/**
 * The contract snapshots of published app versions (ARCHITECTURE 7.2, 4.81;
 * TASK-056): for every version of the mobile app still served, the API
 * document (`apps/api/openapi.json`) as it was when that version was
 * released. CI compares the server with each of them
 * (`openapi:compat --snapshots`) — the server must keep every supported
 * version working, not only the last `main`.
 *
 * The list of supported versions (`supported.json`) is written by the
 * release command (`pnpm release:mobile:snapshot <version>`); a version
 * leaves it only after `client_min_version_*` of both platforms has passed
 * it (the procedure — ARCHITECTURE 4.81).
 *
 * A snapshot holds the part of the contract the app can call
 * (`mobileContractOf`, I894): the routes open to guests or serving the
 * `user` context, without the web sign-in steps and the partner form, and
 * only the components they reference. The admin panel and the supplier
 * cabinet ship together with the server, so a change to their routes must
 * never be held back by a published app version.
 */

type JsonObject = Record<string, unknown>;

/** The routes only the web clients call, although they need no session. */
const WEB_ONLY_PATHS = [/^\/auth\/sign-in\//, /^\/supplier-leads$/];

/** `METHOD /path` of every route the mobile app may call. */
export function mobileOperations(): Set<string> {
  const operations = new Set<string>();
  for (const route of Object.values(apiRoutes) as ApiRouteDefinition[]) {
    const forGuests = route.auth === undefined || route.auth === "optional";
    const forUsers = route.contexts?.includes("user") ?? false;
    if (!forGuests && !forUsers) continue;
    if (WEB_ONLY_PATHS.some((pattern) => pattern.test(route.path))) continue;
    operations.add(`${route.method.toUpperCase()} ${route.path}`);
  }
  return operations;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every `#/components/<section>/<name>` reference inside `value`, recursively. */
function collectRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, into);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === "$ref" && typeof inner === "string" && inner.startsWith("#/components/")) {
      into.add(inner.slice("#/components/".length));
    } else {
      collectRefs(inner, into);
    }
  }
}

/**
 * The OpenAPI document reduced to what the mobile app can call (see above):
 * the operations of `mobileOperations()`, the components they reach
 * (transitively), the security schemes as they are; everything else of the
 * document stays. A pure function of the document — the release command
 * writes its result, the compatibility check reduces the current document
 * the same way before comparing.
 */
export function mobileContractOf<T extends JsonObject>(document: T): T {
  const wanted = mobileOperations();
  const paths = isObject(document.paths) ? document.paths : {};
  const keptPaths: JsonObject = {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    const kept: JsonObject = {};
    for (const [key, operation] of Object.entries(item)) {
      const isMethod = /^[a-z]+$/.test(key) && key !== "parameters";
      if (!isMethod || wanted.has(`${key.toUpperCase()} ${path}`)) kept[key] = operation;
    }
    if (Object.keys(kept).some((key) => key !== "parameters")) keptPaths[path] = kept;
  }

  const components = isObject(document.components) ? document.components : {};
  const reached = new Set<string>();
  collectRefs(keptPaths, reached);
  // Components reference components: follow until nothing new is reached.
  for (;;) {
    const before = reached.size;
    for (const ref of [...reached]) {
      const [section, name] = ref.split("/");
      const sectionObject = section ? components[section] : undefined;
      if (isObject(sectionObject) && name !== undefined) collectRefs(sectionObject[name], reached);
    }
    if (reached.size === before) break;
  }
  const keptComponents: JsonObject = {};
  for (const [section, members] of Object.entries(components)) {
    if (section === "securitySchemes" || !isObject(members)) {
      keptComponents[section] = members;
      continue;
    }
    const keptMembers: JsonObject = {};
    for (const [name, member] of Object.entries(members)) {
      if (reached.has(`${section}/${name}`)) keptMembers[name] = member;
    }
    if (Object.keys(keptMembers).length > 0) keptComponents[section] = keptMembers;
  }
  return { ...document, paths: keptPaths, components: keptComponents };
}

/** The text of a snapshot: the reduced document, 2-space indented, one trailing newline. */
export function mobileSnapshotText(documentText: string): string {
  const document = JSON.parse(documentText) as JsonObject;
  return `${JSON.stringify(mobileContractOf(document), null, 2)}\n`;
}

export const SNAPSHOTS_DIR = resolve(__dirname, "..", "..", "contract-snapshots", "mobile");
export const SUPPORTED_FILE = "supported.json";
export const SNAPSHOT_SUFFIX = ".openapi.json";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const supportedVersionSchema = z.object({
  version: z.string().regex(SEMVER),
  /** The day the version went to the stores (or to internal testing), `YYYY-MM-DD`. */
  releasedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  platforms: z.array(z.enum(["ios", "android"])).min(1),
});

export const supportedListSchema = z.object({
  versions: z.array(supportedVersionSchema),
});

export type SupportedVersion = z.infer<typeof supportedVersionSchema>;
export type SupportedList = z.infer<typeof supportedListSchema>;

export function snapshotFileOf(version: string): string {
  return `${version}${SNAPSHOT_SUFFIX}`;
}

/** `-1`, `0`, `1` — the order of two `MAJOR.MINOR.PATCH` versions. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function readSupported(dir = SNAPSHOTS_DIR): SupportedList {
  const raw = JSON.parse(readFileSync(join(dir, SUPPORTED_FILE), "utf8")) as unknown;
  return supportedListSchema.parse(raw);
}

/**
 * What is wrong with the folder: a listed version without its snapshot, a
 * snapshot nobody lists, versions out of order or repeated, a snapshot that
 * is not an OpenAPI document. Empty — consistent.
 */
export function snapshotProblems(dir = SNAPSHOTS_DIR): string[] {
  const problems: string[] = [];
  let list: SupportedList;
  try {
    list = readSupported(dir);
  } catch (error) {
    return [`${SUPPORTED_FILE} is unreadable: ${error instanceof Error ? error.message : "?"}`];
  }
  const listed = new Set<string>();
  list.versions.forEach((entry, index) => {
    if (listed.has(entry.version)) problems.push(`${entry.version} is listed twice`);
    listed.add(entry.version);
    const previous = list.versions[index - 1];
    if (previous && compareVersions(previous.version, entry.version) >= 0) {
      problems.push(`${entry.version} comes after ${previous.version}: versions must increase`);
    }
    const file = join(dir, snapshotFileOf(entry.version));
    if (!existsSync(file)) {
      problems.push(`${entry.version} has no snapshot ${snapshotFileOf(entry.version)}`);
      return;
    }
    try {
      const document = JSON.parse(readFileSync(file, "utf8")) as { openapi?: unknown };
      if (typeof document.openapi !== "string") {
        problems.push(`${snapshotFileOf(entry.version)} is not an OpenAPI document`);
      }
    } catch {
      problems.push(`${snapshotFileOf(entry.version)} is not JSON`);
    }
  });
  for (const name of readdirSync(dir)) {
    if (name === SUPPORTED_FILE) continue;
    if (!name.endsWith(SNAPSHOT_SUFFIX)) {
      problems.push(`${name} does not belong in the snapshot folder`);
      continue;
    }
    const version = name.slice(0, -SNAPSHOT_SUFFIX.length);
    if (!listed.has(version)) problems.push(`${name} is not in ${SUPPORTED_FILE}`);
  }
  return problems;
}
