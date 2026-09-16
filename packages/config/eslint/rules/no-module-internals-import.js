const path = require("node:path");

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js"];

/**
 * Resolves a relative import specifier against the file that imports it,
 * without touching the filesystem, and returns the path segments (posix
 * style) so they can be compared against `modules/<name>/...`.
 */
function resolveSegments(fromFile, specifier) {
  const resolved = path.posix.normalize(
    `${path.posix.dirname(fromFile.split(path.sep).join("/"))}/${specifier}`,
  );
  return resolved.split("/").filter(Boolean);
}

function moduleNameAndRestFromSegments(segments) {
  const modulesIndex = segments.lastIndexOf("modules");
  if (modulesIndex === -1 || modulesIndex === segments.length - 1) {
    return null;
  }
  return {
    name: segments[modulesIndex + 1],
    rest: segments.slice(modulesIndex + 2),
  };
}

function stripExtension(segment) {
  for (const ext of SOURCE_EXTENSIONS) {
    if (segment.endsWith(ext)) {
      return segment.slice(0, -ext.length);
    }
  }
  return segment;
}

function isPublicEntryOnly(rest) {
  if (rest.length === 0) {
    return true;
  }
  if (rest.length === 1 && stripExtension(rest[0]) === "index") {
    return true;
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A domain module (src/modules/<name>) may only be imported through its index.ts — never a path into its internals (ARCHITECTURE 4).",
    },
    schema: [],
    messages: {
      deepImport:
        "Import '{{name}}' module through its public entry point (e.g. '../{{name}}'), not an internal path ('{{specifier}}'). Move what you need into {{name}}/index.ts if it should be public.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();

    function check(node, specifier) {
      if (typeof specifier !== "string" || !specifier.startsWith(".")) {
        return;
      }

      const fromModule = moduleNameAndRestFromSegments(
        filename.split(path.sep).join("/").split("/").filter(Boolean),
      );
      const targetSegments = resolveSegments(filename, specifier);
      const toModule = moduleNameAndRestFromSegments(targetSegments);

      if (!toModule) {
        return;
      }
      if (fromModule && fromModule.name === toModule.name) {
        return;
      }
      if (isPublicEntryOnly(toModule.rest)) {
        return;
      }

      context.report({
        node,
        messageId: "deepImport",
        data: { name: toModule.name, specifier },
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
