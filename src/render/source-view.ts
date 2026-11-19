// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The source viewer's body: an artifact's text, one element per line, each dressed by
// what the line IS — and still the SOURCE.
//
// NOT A MARKDOWN RENDERER. Every byte of the file is on the page, in order: markers
// (`##`, `**`, backticks, `>`) stay on screen, only dimmed; nothing is hidden, reordered,
// joined or rewritten, line endings included (each line's own LF, CRLF or CR is inside its
// element, a CR as `&#13;` because an HTML parser turns a literal one into LF). What
// changes is presentation: a line is classified on the line a reader SEES (visible-lines:
// a tag in a fence or comment is example text) and output from the raw line (heading,
// question heading, `[Answer]:` tag, option, block quote, example text, plain), inline
// code and bold spans get a class, and every piece of text that reaches
// the page goes through `esc()` — a classifier's output is a CLASS NAME from a fixed
// set, never markup built from the file. That is the line the 2026-10 design drew
// ("No markdown renderer", AGENTS.md): what the reader wants is the blank tag and the
// raw feedback, and this page still shows exactly that; it only stops making them hard
// to find. `src/test/view-page.test.ts` holds both halves (escaped, byte-for-byte).
//
// THE READING RULES ARE THE BLOCKER COUNT'S, NOT A SECOND SET. Which tag is blank, which
// heading is a question and which lines are example text come from scan/questions.ts
// (`parseQuestionsFile`, `isBlankAnswer`, its own heading and tag regexes) and
// scan/visible-lines.ts — so the outline's blank count is the number the dashboard's
// questions panel counts for this file, checked on the reference fixture's files. A tag
// line's state is the state of the ask that READ it (`located[].tags`), not of the
// nearest heading above: the reader joins a `### Q7 answer` continuation's tags to the first
// Q7, a new Plan Approval discards the last one's, and a loose span mixing blank and
// filled tags is no ask — a tag no ask read gets no badge (found in review, reproduced).
// A truncated view parses only the prefix it shows, so it states no count.
//
// LINE NUMBERS ARE CSS, so they are not text: `data-n` + `::before`, which a copy does
// not pick up and `textContent` does not hold. The "no answer yet" badge is the same —
// a reader selecting the file's text gets the file's text.

import { ANSWER_RE, ATX_RE, isBlankAnswer, parseQuestionsFile } from "../scan/questions";
import type { QuestionEntry } from "../scan/questions";
import { codeSpans, visibleLines } from "../scan/visible-lines";
import { esc } from "./common";
import type { Strings } from "./i18n";

export interface SourceView {
  /** The `<pre>` holding one `<span class="l …">` per line. */
  pre: string;
  /** The question outline, or "" when the file has no asks (or is not markdown). */
  outline: string;
  /** Asks with a blank answer, and all asks — the reader's own counts. */
  blank: number;
  total: number;
  /** A fence or comment was never closed and was read as text (visible-lines.ts). */
  unclosed: boolean;
}

export function isMarkdown(rel: string): boolean {
  return /\.(md|markdown)$/i.test(rel);
}

type Kind = "p" | "h1" | "h2" | "h3" | "q" | "ans" | "opt" | "bq" | "x";

interface LineOut {
  kind: Kind;
  /** A modifier class from a fixed set ("blank" | "answered" | "filled" | "spent"). */
  mod?: string;
  inner: string;
  badge?: string;
  title?: string;
}

/** A line ending as the page must carry it: a literal CR would reach the DOM as LF. */
function sepHtml(sep: string): string {
  return sep.replace(/\r/g, "&#13;");
}

function lineHtml(n: number, o: LineOut, sep: string): string {
  const cls = `l k-${o.kind}${o.mod ? ` ${o.mod}` : ""}`;
  const badge = o.badge ? ` data-badge="${esc(o.badge)}"` : "";
  const title = o.title ? ` title="${esc(o.title)}"` : "";
  return `<span class="${cls}" id="L${n}" data-n="${n}"${badge}${title}>${o.inner}${sepHtml(sep)}</span>`;
}

/** Lines and the ending each one had — LF, CRLF or a bare CR, as visible-lines splits. */
function splitLines(text: string): { lines: string[]; seps: string[] } {
  const lines: string[] = [];
  const seps: string[] = [];
  let at = 0;
  for (const m of text.matchAll(/\r\n|\r|\n/g)) {
    const i = m.index ?? 0;
    lines.push(text.slice(at, i));
    seps.push(m[0]);
    at = i + m[0].length;
  }
  lines.push(text.slice(at));
  seps.push("");
  return { lines, seps };
}

/** Bold and "recommended" spans inside text that holds no code span (`권장` is "recommended" in a Korean record). */
function plainInline(text: string): string {
  const re = /(\*\*)([^*]+?)(\*\*)|(\((?:권장|recommended)[^)]*\))/gi;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    out += esc(text.slice(last, at));
    if (m[1] !== undefined) {
      out += `<span class="b"><span class="m">${esc(m[1])}</span>${esc(m[2])}<span class="m">${esc(
        m[3],
      )}</span></span>`;
    } else {
      out += `<span class="rec">${esc(m[4])}</span>`;
    }
    last = at + m[0].length;
  }
  return out + esc(text.slice(last));
}

/** A line's text with its inline spans classed — every character kept, all escaped. */
function inline(text: string): string {
  let out = "";
  let last = 0;
  for (const [s, e] of codeSpans(text)) {
    out += plainInline(text.slice(last, s));
    out += `<span class="c">${esc(text.slice(s, e))}</span>`;
    last = e;
  }
  return out + plainInline(text.slice(last));
}

function headingKind(depth: number): Kind {
  return depth <= 1 ? "h1" : depth === 2 ? "h2" : "h3";
}

/** `raw` split at the end of its leading match `m`: marker, then the rest. */
function split(raw: string, m: RegExpExecArray | null): [string, string] {
  const len = m?.[0].length ?? 0;
  return [raw.slice(0, len), raw.slice(len)];
}

export function renderSource(text: string, rel: string, s: Strings): SourceView {
  const t = s.viewer;
  const { lines: raw, seps } = splitLines(text);
  if (!isMarkdown(rel)) {
    const pre = raw
      .map((r, i) => lineHtml(i + 1, { kind: "p", inner: esc(r) }, seps[i] ?? ""))
      .join("");
    return {
      pre: `<pre class="src plain">${pre}</pre>`,
      outline: "",
      blank: 0,
      total: 0,
      unclosed: false,
    };
  }

  const visible = visibleLines(text);
  const parsed = parseQuestionsFile(text);
  // The two readers split the same way; if a future change made them disagree, a
  // misaligned classification would dress the wrong line, so fall back to plain.
  const aligned = visible.lines.length === raw.length;
  const asks = [...parsed.located].sort((a, b) => a.line - b.line);
  const askAt = new Map<number, QuestionEntry>(asks.map((a) => [a.line, a.entry]));
  const readBy = new Map<number, QuestionEntry>();
  for (const a of asks) for (const l of a.tags) readBy.set(l, a.entry);

  const lines = raw.map((r, i): LineOut => {
    const v = aligned ? (visible.lines[i] ?? "") : r;
    if (aligned && v.trim() === "" && r.trim() !== "") {
      return { kind: "x", inner: esc(r), title: t.exampleTip };
    }
    const h = ATX_RE.exec(v);
    if (h) {
      const ask = askAt.get(i);
      const [mark, rest] = split(r, /^ {0,3}#{1,6}[ \t]*/.exec(r));
      const inner = `<span class="m">${esc(mark)}</span>${inline(rest)}`;
      if (ask) return { kind: "q", mod: ask.answered ? "answered" : "blank", inner };
      return { kind: headingKind(h[1]?.length ?? 1), inner };
    }
    const a = ANSWER_RE.exec(v);
    if (a) {
      const [tag, rest] = split(r, /^\[Answer\]:/.exec(r));
      const inner = `<span class="tag">${esc(tag)}</span><span class="av">${esc(rest)}</span>`;
      const filled = !isBlankAnswer((a[1] ?? "").trim());
      const ask = readBy.get(i);
      // No ask read this tag (a replaced Plan Approval, a mixed loose span): no claim.
      if (!ask) return { kind: "ans", mod: filled ? "filled" : "free", inner };
      if (ask.invalidTags !== undefined) {
        return {
          kind: "ans",
          mod: "invalid",
          inner,
          badge: s.blockers.invalidTags(ask.invalidTags),
        };
      }
      if (filled) return { kind: "ans", mod: "filled", inner };
      // A blank placeholder of an ask answered elsewhere is spent, not waiting.
      return ask.answered
        ? { kind: "ans", mod: "spent", inner }
        : { kind: "ans", mod: "blank", inner, badge: t.badgeBlank };
    }
    const o = /^ {0,3}[A-Z][.)](?=[ \t])/.exec(v);
    if (o) {
      const [letter, rest] = split(r, /^ {0,3}[A-Z][.)]/.exec(r));
      return { kind: "opt", inner: `<span class="o">${esc(letter)}</span>${inline(rest)}` };
    }
    if (/^ {0,3}>/.test(v)) {
      const [mark, rest] = split(r, /^ {0,3}>[ \t]?/.exec(r));
      return { kind: "bq", inner: `<span class="m">${esc(mark)}</span>${inline(rest)}` };
    }
    return { kind: "p", inner: inline(r) };
  });

  const pre = `<pre class="src">${lines.map((o, i) => lineHtml(i + 1, o, seps[i] ?? "")).join("")}</pre>`;
  const blank = parsed.questions.filter((q) => !q.answered).length;
  const total = parsed.questions.length;
  const outline =
    asks.length === 0
      ? ""
      : `<nav class="outline" aria-label="${esc(t.outlineHeading)}"><h2>${esc(
          t.outlineHeading,
        )}</h2><ol>${asks
          .map(
            (q) =>
              `<li class="ol-item ${q.entry.answered ? "answered" : "blank"}"><a href="#L${
                q.line + 1
              }"><span class="dot" aria-hidden="true"></span><span class="ol-text">${esc(
                q.entry.heading || t.untitledAsk,
              )}${
                q.entry.invalidTags !== undefined
                  ? `<span class="ol-why">${esc(s.blockers.invalidTags(q.entry.invalidTags))}</span>`
                  : ""
              }</span><span class="sr">${esc(
                q.entry.answered ? t.stateAnswered : t.badgeBlank,
              )}</span></a></li>`,
          )
          .join("")}</ol></nav>`;
  return { pre, outline, blank, total, unclosed: parsed.unclosed };
}

/*
 * The dressing. Tones are the dashboard's (tokens.ts): warn for a tag still waiting, ok
 * for an answer, mute for markers and example text, accent for the protocol's
 * "(recommended: …)", in either language. Line numbers sit in a gutter the text never wraps under.
 */
export const SOURCE_CSS = `
.src { margin:0; padding:14px 0; border:1px solid var(--line); border-radius:9px; background:var(--panel);
  white-space:pre-wrap; overflow-wrap:anywhere; font:14px/1.75 var(--sans); }
.src .l { display:block; position:relative; padding:0 20px 0 62px; min-height:1.75em; }
.src .l::before { content:attr(data-n); position:absolute; left:0; width:44px; text-align:right;
  color:var(--mute); opacity:.55; font:11px/2.4 var(--mono); user-select:none; }
.src .l:target { background:color-mix(in srgb, var(--accent) 13%, transparent); }
.src .m { color:var(--mute); }
.src .c { font-family:var(--mono); font-size:.9em; background:var(--raised); border-radius:4px; padding:1px 4px; }
.src .b { font-weight:650; }
.src .rec { color:var(--accent); }
.src .k-h1 { font-size:21px; font-weight:700; line-height:1.5; margin:.2em 0 .5em; }
.src .k-h2 { font-size:17px; font-weight:650; line-height:1.55; margin-top:.5em; }
.src .k-h3 { font-size:15px; font-weight:650; margin-top:.35em; }
.src .k-q { font-size:16px; font-weight:650; line-height:1.55; margin-top:1.1em; padding-top:.7em;
  border-top:1px solid var(--line); }
.src .k-q::after { content:""; position:absolute; left:50px; top:calc(.7em + .62em); width:7px; height:7px;
  border-radius:50%; }
.src .k-q.blank::after { background:var(--warn); }
.src .k-q.answered::after { background:var(--ok); }
.src .k-ans { font-family:var(--mono); font-size:13px; margin:.2em 0; }
.src .k-ans .tag { font-weight:650; }
.src .k-ans.blank { background:color-mix(in srgb, var(--warn) 11%, transparent); }
.src .k-ans.blank::after { content:attr(data-badge); margin-left:12px; padding:1px 9px; font:600 11px/1.6 var(--sans);
  color:var(--warn); border:1px solid currentColor; border-radius:999px; white-space:nowrap; }
.src .k-ans.filled .av { color:var(--ok); font-weight:650; }
.src .k-ans.spent, .src .k-ans.free { color:var(--mute); }
.src .k-ans.invalid { background:color-mix(in srgb, var(--warn) 11%, transparent); }
.src .k-ans.invalid::after { content:attr(data-badge); margin-left:12px; padding:1px 9px; font:600 11px/1.6 var(--sans);
  color:var(--warn); border:1px solid currentColor; border-radius:999px; white-space:nowrap; }
.src .k-opt .o { display:inline-block; min-width:1.7em; margin-right:3px; padding:0 5px; text-align:center;
  font-weight:650; font-size:12.5px; line-height:1.55; border:1px solid var(--line); border-radius:5px;
  background:var(--raised); }
.src .k-bq { color:var(--mute); }
.src .k-x { font-family:var(--mono); font-size:12.5px; color:var(--mute); background:var(--raised); }
.src.plain { font:12.5px/1.7 var(--mono); }
.outline h2 { margin:0 0 8px; font-size:11px; font-weight:650; letter-spacing:.06em; text-transform:uppercase;
  color:var(--mute); }
.outline ol { list-style:none; margin:0; padding:0; display:grid; gap:2px; }
.outline a { display:flex; gap:9px; align-items:flex-start; padding:6px 9px; border-radius:7px;
  color:var(--fg); text-decoration:none; font-size:13px; line-height:1.45; }
.outline a:hover { background:var(--raised); }
.outline .dot { flex:none; width:8px; height:8px; margin-top:6px; border-radius:50%; }
.outline .blank .dot { background:var(--warn); }
.outline .answered .dot { background:var(--ok); }
.outline .answered a { color:var(--mute); }
.outline .ol-why { display:block; color:var(--warn); font-size:11.5px; }
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
`;
