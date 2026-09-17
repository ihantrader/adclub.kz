const path = require("node:path");

const WORKSPACE_ROOTS = ["packages", "apps"];

/**
 * Identifies which workspace package/app a path belongs to, as
 * `"packages/domain"` or `"apps/api"`, from its absolute path segments.
 * Returns `null` for a path outside `packages/*` or `apps/*` (should not
 * happen for files this rule is scoped to, but resolution is defensive).
 */
function workspaceIdentity(segments) {
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (WORKSPACE_ROOTS.includes(segments[i])) {
      return `${segments[i]}/${segments[i + 1]}`;
    }
  }
  return null;
}

function toPosixSegments(filePath) {
  return filePath.split(path.sep).join("/").split("/").filter(Boolean);
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A relative import may not cross into another workspace package's src (ARCHITECTURE 4) — import the package's public entry point instead.",
    },
    schema: [],
    messages: {
      crossPackageRelativeImport:
        "'{{specifier}}' reaches into '{{target}}' through a relative path. Import it as a package (e.g. '@adclub/{{targetName}}'), not a relative path.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const fromIdentity = workspaceIdentity(toPosixSegments(filename));

    function check(node, specifier) {
      if (typeof specifier !== "string" || !specifier.startsWith(".")) {
        return;
      }

      const resolved = path.posix.normalize(
        `${path.posix.dirname(filename.split(path.sep).join("/"))}/${specifier}`,
      );
      const toIdentity = workspaceIdentity(resolved.split("/").filter(Boolean));

      if (!fromIdentity || !toIdentity || fromIdentity === toIdentity) {
        return;
      }

      context.report({
        node,
        messageId: "crossPackageRelativeImport",
        data: { specifier, target: toIdentity, targetName: toIdentity.split("/")[1] },
      });
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source?.value);
      },
      ExportNamedDeclaration(node) {
        check(node, node.source?.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source?.value);
      },
      ImportExpression(node) {
        if (node.source?.type === "Literal") {
          check(node, node.source.value);
        }
      },
    };
  },
};

module.exports = rule;
