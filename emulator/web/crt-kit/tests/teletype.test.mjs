import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadTeletype() {
  const source = readFileSync(join(import.meta.dirname, "../src/Teletype.tsx"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });

  const module = { exports: {} };
  vm.runInNewContext(outputText, { exports: module.exports, module, require });
  return module.exports.Teletype;
}

function loadCrtScreen() {
  const source = readFileSync(join(import.meta.dirname, "../src/CRTScreen.tsx"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });

  const module = { exports: {} };
  vm.runInNewContext(outputText, { exports: module.exports, module, require });
  return module.exports;
}

test("cursorless teletype does not render the output cursor", () => {
  const Teletype = loadTeletype();
  const html = renderToStaticMarkup(
    React.createElement(Teletype, { text: "LINE 1\nLINE 2\n", cursor: false }),
  );

  assert.doesNotMatch(html, /crt-cursor/);
});

test("terminal viewport scrolls only when content grows by a line", () => {
  const { scrollToTerminalBottom } = loadCrtScreen();
  const viewport = { scrollHeight: 240, scrollTop: 0 };

  const firstHeight = scrollToTerminalBottom(viewport, -1);
  assert.equal(firstHeight, 240);
  assert.equal(viewport.scrollTop, 240);

  viewport.scrollTop = 120;
  const unchangedHeight = scrollToTerminalBottom(viewport, 240);
  assert.equal(unchangedHeight, 240);
  assert.equal(viewport.scrollTop, 120);

  viewport.scrollHeight = 270;
  const nextHeight = scrollToTerminalBottom(viewport, 240);
  assert.equal(nextHeight, 270);
  assert.equal(viewport.scrollTop, 270);
});
