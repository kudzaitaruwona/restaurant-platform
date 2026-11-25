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

function isCleanup(e: ts.Expression, body?: ts.Node): boolean {
  if (ts.isParenthesizedExpression(e)) return isCleanup(e.expression, body);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
  // A cleanup named in the effect itself. Any other name could hold anything.
  if (ts.isIdentifier(e)) {
    return (
      body !== undefined &&
      ts.isBlock(body) &&
      body.statements.some(
        (s) =>
          (ts.isFunctionDeclaration(s) && s.name?.text === e.text) ||
          (ts.isVariableStatement(s) &&
            s.declarationList.declarations.some(
              (d) =>
                ts.isIdentifier(d.name) && d.name.text === e.text && d.initializer && isCleanup(d.initializer),
            )),
      )
    );
  }
  return (
    ts.isCallExpression(e) && ts.isIdentifier(e.expression) && CLEANUP_FACTORIES.has(e.expression.text)
  );
}

const offencesIn = (file: string) => offences(file, readFileSync(file, "utf8"));

function offences(file: string, text: string): string[] {
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
            if (ts.isReturnStatement(m) && m.expression && !isCleanup(m.expression, fn.body)) {
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
    expect(sources("src").flatMap(offencesIn)).toEqual([]);
  });

  it.each([
    "useEffect(() => ref.current?.scrollIntoView({}), []);",
    "useEffect(() => { return ref.current?.scrollIntoView({}); }, []);",
    "useEffect(() => { if (on) return load(); }, []);",
    "useEffect(() => { const done = load(); return done; }, []);",
    "useEffect(() => { return outside; }, []);",
    "useEffect(load, []);",
  ])("catches %s", (source) => {
    expect(offences("x.tsx", source)).toEqual(["x.tsx:1"]);
  });

  it.each([
    "useEffect(() => { void ref.current?.scrollIntoView({}); }, []);",
    "useEffect(() => { if (off) return; return () => stop(); }, []);",
    "useEffect(() => { const stop = () => {}; return stop; }, []);",
    "useEffect(() => { items.map((item) => { return item.id; }); }, []);",
    "useEffect(() => clearOnOtherSend(self, clear), []);",
  ])("allows %s", (source) => {
    expect(offences("x.tsx", source)).toEqual([]);
  });
});
