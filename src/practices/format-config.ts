import { parse, type Expression, type Identifier, type Literal } from "acorn";
import { z } from "zod";

class StaticObject {
  readonly properties = new Map<string, StaticValue>();
  shared = false;
}

const FORMAT_FACTORY = Symbol("Oxforge format helper");

type StaticValue = string | number | boolean | null | StaticObject | StaticValue[];

type Binding = StaticValue | typeof FORMAT_FACTORY;

export interface FormatInspection {
  state: "pass" | "fail" | "unknown";
  detail: string;
}

function unsupported(): never {
  throw new Error("Unsupported static format configuration");
}

function name(node: Identifier | Literal): string {
  if (node.type === "Identifier") {
    return node.name;
  }

  return String(node.value);
}

function sharedConfig(tailwind: boolean): StaticObject {
  const config = new StaticObject();
  config.shared = true;

  if (tailwind) {
    config.properties.set("sortTailwindcss", new StaticObject());
  }

  return config;
}

function imported(source: string, exported: string): Binding {
  if (source === "@aranlucas/oxforge/format" && ["default", "format"].includes(exported)) {
    return FORMAT_FACTORY;
  }

  if (source === "@aranlucas/oxforge/format-tailwind" && exported === "default") {
    return sharedConfig(true);
  }

  if (source === "@aranlucas/oxforge/format-config" && exported === "default") {
    return sharedConfig(false);
  }

  return unsupported();
}

function merge(target: StaticObject, source: StaticValue): void {
  if (!(source instanceof StaticObject)) {
    unsupported();
  }

  target.shared ||= source.shared;

  for (const [key, value] of source.properties) {
    target.properties.set(key, value);
  }
}

function evaluate(
  node: Expression,
  bindings: ReadonlyMap<string, Binding>,
  depth = 0,
): StaticValue {
  if (depth > 32) {
    return unsupported();
  }

  const child = (value: Expression) => evaluate(value, bindings, depth + 1);

  switch (node.type) {
    case "Literal":
      return z.union([z.string(), z.boolean(), z.number(), z.null()]).parse(node.value);
    case "Identifier": {
      const value = bindings.get(node.name);

      if (value !== undefined && value !== FORMAT_FACTORY) {
        return value;
      }

      break;
    }

    case "ObjectExpression": {
      const object = new StaticObject();

      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          merge(object, child(property.argument));
        } else if (
          !property.computed &&
          !property.method &&
          property.kind === "init" &&
          (property.key.type === "Identifier" || property.key.type === "Literal")
        ) {
          object.properties.set(name(property.key), child(property.value));
        } else {
          unsupported();
        }
      }

      return object;
    }

    case "ArrayExpression":
      return node.elements.map((element) => {
        if (!element || element.type === "SpreadElement") {
          return unsupported();
        }

        return child(element);
      });
    case "MemberExpression": {
      if (node.object.type === "Super") {
        return unsupported();
      }

      const object = child(node.object);

      if (object instanceof StaticObject && !node.computed && node.property.type === "Identifier") {
        const value = object.properties.get(node.property.name);

        if (value !== undefined) {
          return value;
        }
      }

      break;
    }

    case "CallExpression": {
      if (
        node.callee.type !== "Identifier" ||
        bindings.get(node.callee.name) !== FORMAT_FACTORY ||
        node.arguments.length > 1
      ) {
        break;
      }

      const config = sharedConfig(false);
      const options = node.arguments[0];

      if (options) {
        if (options.type === "SpreadElement") {
          return unsupported();
        }

        merge(config, child(options));
      }

      return config;
    }

    case "ArrowFunctionExpression":
    case "AssignmentExpression":
    case "AwaitExpression":
    case "BinaryExpression":
    case "ChainExpression":
    case "ClassExpression":
    case "ConditionalExpression":
    case "FunctionExpression":
    case "ImportExpression":
    case "LogicalExpression":
    case "MetaProperty":
    case "NewExpression":
    case "ParenthesizedExpression":
    case "SequenceExpression":
    case "TaggedTemplateExpression":
    case "TemplateLiteral":
    case "ThisExpression":
    case "UnaryExpression":
    case "UpdateExpression":
    case "YieldExpression":
      break;
  }

  return unsupported();
}

function readConfig(text: string): StaticValue | undefined {
  const program = parse(text, { ecmaVersion: "latest", sourceType: "module" });
  const bindings = new Map<string, Binding>();
  let config: StaticValue | undefined;

  for (const statement of program.body) {
    switch (statement.type) {
      case "ImportDeclaration":
        for (const specifier of statement.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            unsupported();
          }

          const exported =
            specifier.type === "ImportDefaultSpecifier" ? "default" : name(specifier.imported);

          bindings.set(specifier.local.name, imported(String(statement.source.value), exported));
        }

        if (!statement.specifiers.length) {
          unsupported();
        }

        break;
      case "VariableDeclaration":
        if (statement.kind !== "const") {
          unsupported();
        }

        for (const declaration of statement.declarations) {
          if (declaration.id.type !== "Identifier" || !declaration.init) {
            unsupported();
          }

          bindings.set(declaration.id.name, evaluate(declaration.init, bindings));
        }

        break;
      case "ExportDefaultDeclaration":
        if (
          statement.declaration.type === "FunctionDeclaration" ||
          statement.declaration.type === "ClassDeclaration"
        ) {
          unsupported();
        }

        config = evaluate(statement.declaration, bindings);
        break;
      case "ExportNamedDeclaration":
        if (
          !statement.source ||
          statement.specifiers.length !== 1 ||
          name(statement.specifiers[0].exported) !== "default"
        ) {
          unsupported();
        }

        {
          const value = imported(
            String(statement.source.value),
            name(statement.specifiers[0].local),
          );

          if (value === FORMAT_FACTORY) {
            unsupported();
          }

          config = value;
        }

        break;
      case "EmptyStatement":
        break;
      case "BlockStatement":
      case "BreakStatement":
      case "ClassDeclaration":
      case "ContinueStatement":
      case "DebuggerStatement":
      case "DoWhileStatement":
      case "ExportAllDeclaration":
      case "ExpressionStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "ForStatement":
      case "FunctionDeclaration":
      case "IfStatement":
      case "LabeledStatement":
      case "ReturnStatement":
      case "SwitchStatement":
      case "ThrowStatement":
      case "TryStatement":
      case "WhileStatement":
      case "WithStatement":
        unsupported();
    }
  }

  return config;
}

/** Interpret only immutable static config expressions; never import or run repository code. */
export function inspectFormatConfig(text: string, needsTailwind: boolean): FormatInspection {
  try {
    const config = readConfig(text);

    if (!(config instanceof StaticObject) || !config.shared) {
      return { state: "fail", detail: "Inherit the shared Oxforge format configuration." };
    }

    const sorting = config.properties.get("sortTailwindcss");

    if (needsTailwind && sorting !== true && !(sorting instanceof StaticObject)) {
      return {
        state: "fail",
        detail:
          'tailwindcss is declared in package.json; enable sortTailwindcss using Oxforge format-tailwind or format({ sortTailwindcss: { stylesheet: "app/globals.css" } }). Adapt the stylesheet path to this project.',
      };
    }

    return {
      state: "pass",
      detail: needsTailwind
        ? "Shared Oxforge formatting and Tailwind sorting are configured with static project overrides."
        : "Shared Oxforge formatting is configured; package.json does not require Tailwind sorting.",
    };
  } catch {
    return {
      state: "unknown",
      detail:
        "Dynamic, malformed or unsupported format configuration requires review; repository code was not executed.",
    };
  }
}
