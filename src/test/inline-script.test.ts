// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Values the page script embeds as JS literals come from the tree (the run's slug, via
// the tab title) and from the catalogue. `JSON.stringify` makes them valid JavaScript but
// not safe inside `<script>`: the HTML parser ends the element at the first `</script>`
// whatever the JS says, so a slug carrying one would close the page's script and start
// markup of its own. Every literal goes through `scriptJson`, which escapes `<`.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { renderPage } from "../render/page";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");

describe("inline script literals", () => {
  test("a slug carrying </script> cannot end the page's script", () => {
    const m = assemble(FIXTURE);
    const evil = "</script><script>window.PWNED=1</script>";
    const html = renderPage({ ...m, identity: { ...m.identity, slug: evil } }, 0, "ko");
    // One script element, closed once — the slug stays inside its JS string.
    expect(html.match(/<script>/g)?.length).toBe(1);
    expect(html.match(/<\/script>/g)?.length).toBe(1);
    expect(html).toContain("\\u003c/script>\\u003cscript>window.PWNED=1");
  });
});
