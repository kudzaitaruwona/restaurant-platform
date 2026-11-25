// An effect's return value is its cleanup, and React calls it on unmount. An
// expression-bodied arrow (`() => el?.scrollIntoView()`) returns whatever the
// call does: scrollIntoView returns a Promise in current Chrome, and React dev
// crashes the page with "This page couldn't load" (#105). Effects return
// nothing, or a cleanup function.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const EFFECTS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
// Calls known to return an unsubscribe function.
const CLEANUP_FACTORIES = new Set(["clearOnOtherSend"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function isCleanup(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return isCleanup(e.expression);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
  if (ts.isIdentifier(e)) return true; // a named cleanup
  return (
    ts.isCallExpression(e) && ts.isIdentifier(e.expression) && CLEANUP_FACTORIES.has(e.expression.text)
  );
}

function offences(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const where = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      EFFECTS.has(n.expression.text)
    ) {
      const fn = n.arguments[0];
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        if (!ts.isBlock(fn.body)) {
          if (!isCleanup(fn.body)) found.push(where(fn));
        } else {
          const scan = (m: ts.Node) => {
            if (m !== fn && ts.isFunctionLike(m)) return; // a nested function's returns are its own
            if (ts.isReturnStatement(m) && m.expression && !isCleanup(m.expression)) {
              found.push(where(m));
            }
            ts.forEachChild(m, scan);
          };
          ts.forEachChild(fn.body, scan);
        }
      } else if (fn) {
        found.push(where(fn)); // a reference we can't inspect: wrap it in a block
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("effects return nothing or a cleanup", () => {
  it("no effect in src returns an expression's value", () => {
    expect(sources("src").flatMap(offences)).toEqual([]);
  });

  it("catches the #105 shape", () => {
    const sf = ts.createSourceFile(
      "x.tsx",
      "useEffect(() => ref.current?.scrollIntoView({}), []);",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const call = (sf.statements[0] as ts.ExpressionStatement).expression as ts.CallExpression;
    const body = (call.arguments[0] as ts.ArrowFunction).body as ts.Expression;
    expect(isCleanup(body)).toBe(false);
  });
});
