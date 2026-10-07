/**
 * Lays out a rendered screen with Yoga, the flexbox engine React Native itself
 * uses, and reports anything a driver would have to scroll to reach.
 *
 * Input is the host tree from react-test-renderer (View, Text, TextInput,
 * RCTScrollView, Modal...). Flexbox is exact; text is not, because there are no
 * fonts in a test. Text width is estimated per character from font size and
 * weight, wrapped word by word, and given its line height. That is close enough
 * to tell a screen that fits from one that runs 200 pt off the bottom.
 *
 * WHAT COUNTS AS A PROBLEM
 *  - a ScrollView whose content is taller than its frame (the screen scrolls);
 *  - anything that ends below the bottom of the screen (it is cut off).
 * A FlatList or SectionList is a list body and may scroll; a plain ScrollView
 * never counts as one. That is the rule in driver-app/CLAUDE.md: only list
 * bodies scroll, and their headers and filters stay fixed.
 */
import { StyleSheet } from 'react-native';
import {
  loadYoga, Align, Display, Edge, FlexDirection, Gutter, Justify, MeasureMode, PositionType, Wrap,
} from 'yoga-layout/load';

let Y;
let config;
export async function initYoga() {
  if (Y) return;
  Y = await loadYoga();
  config = Y.Config.create();
}

/* ---------------------------------------------------------------- styles */

const ALIGN = {
  auto: Align.Auto, 'flex-start': Align.FlexStart, center: Align.Center, 'flex-end': Align.FlexEnd,
  stretch: Align.Stretch, baseline: Align.Baseline, 'space-between': Align.SpaceBetween,
  'space-around': Align.SpaceAround, 'space-evenly': Align.SpaceEvenly,
};
const JUSTIFY = {
  'flex-start': Justify.FlexStart, center: Justify.Center, 'flex-end': Justify.FlexEnd,
  'space-between': Justify.SpaceBetween, 'space-around': Justify.SpaceAround,
  'space-evenly': Justify.SpaceEvenly,
};
const DIRECTION = {
  row: FlexDirection.Row, column: FlexDirection.Column,
  'row-reverse': FlexDirection.RowReverse, 'column-reverse': FlexDirection.ColumnReverse,
};
const EDGES = [
  ['', Edge.All], ['Horizontal', Edge.Horizontal], ['Vertical', Edge.Vertical],
  ['Top', Edge.Top], ['Bottom', Edge.Bottom], ['Left', Edge.Left], ['Right', Edge.Right],
  ['Start', Edge.Start], ['End', Edge.End],
];

const len = (v) => typeof v === 'number' || (typeof v === 'string' && /^-?[\d.]+%$/.test(v));
const lenOrAuto = (v) => len(v) || v === 'auto';

function applyStyle(node, s) {
  if (s.display === 'none') node.setDisplay(Display.None);
  if (s.flexDirection) node.setFlexDirection(DIRECTION[s.flexDirection]);
  if (s.justifyContent) node.setJustifyContent(JUSTIFY[s.justifyContent]);
  if (s.alignItems) node.setAlignItems(ALIGN[s.alignItems]);
  if (s.alignSelf) node.setAlignSelf(ALIGN[s.alignSelf]);
  if (s.alignContent) node.setAlignContent(ALIGN[s.alignContent]);
  if (s.flexWrap) node.setFlexWrap(s.flexWrap === 'wrap' ? Wrap.Wrap : Wrap.NoWrap);
  if (typeof s.flex === 'number') node.setFlex(s.flex);
  if (typeof s.flexGrow === 'number') node.setFlexGrow(s.flexGrow);
  if (typeof s.flexShrink === 'number') node.setFlexShrink(s.flexShrink);
  if (lenOrAuto(s.flexBasis)) node.setFlexBasis(s.flexBasis);
  if (lenOrAuto(s.width)) node.setWidth(s.width);
  if (lenOrAuto(s.height)) node.setHeight(s.height);
  if (len(s.minWidth)) node.setMinWidth(s.minWidth);
  if (len(s.minHeight)) node.setMinHeight(s.minHeight);
  if (len(s.maxWidth)) node.setMaxWidth(s.maxWidth);
  if (len(s.maxHeight)) node.setMaxHeight(s.maxHeight);
  if (typeof s.aspectRatio === 'number') node.setAspectRatio(s.aspectRatio);
  for (const [suffix, edge] of EDGES) {
    if (lenOrAuto(s[`margin${suffix}`])) node.setMargin(edge, s[`margin${suffix}`]);
    if (len(s[`padding${suffix}`])) node.setPadding(edge, s[`padding${suffix}`]);
    const b = suffix ? s[`border${suffix}Width`] : s.borderWidth;
    if (typeof b === 'number') node.setBorder(edge, b);
  }
  if (s.position === 'absolute') node.setPositionType(PositionType.Absolute);
  for (const [key, edge] of [['top', Edge.Top], ['bottom', Edge.Bottom],
    ['left', Edge.Left], ['right', Edge.Right]]) {
    if (len(s[key])) node.setPosition(edge, s[key]);
  }
  if (len(s.gap)) node.setGap(Gutter.All, s.gap);
  if (len(s.rowGap)) node.setGap(Gutter.Row, s.rowGap);
  if (len(s.columnGap)) node.setGap(Gutter.Column, s.columnGap);
}

/* ------------------------------------------------------------------ text */

const NARROW = new Set([...'iljtfrI.,:;\'!|()[]']);
const WIDE = new Set([...'mwMW@%']);

/** Width of one character in ems, for a system sans-serif. */
function em(ch) {
  if (ch === ' ') return 0.27;
  if (NARROW.has(ch)) return 0.3;
  if (WIDE.has(ch)) return 0.85;
  if (/[0-9]/.test(ch)) return 0.57;
  if (/[A-Z]/.test(ch)) return 0.66;
  return 0.53;
}

const BOLD = new Set(['600', '700', '800', '900', 'bold']);

export function textSize(text, style = {}, maxWidth = Infinity, numberOfLines = 0) {
  const fontSize = style.fontSize ?? 14;
  const lineHeight = style.lineHeight ?? fontSize * 1.2;
  const weight = BOLD.has(String(style.fontWeight)) ? 1.06 : 1;
  const spacing = style.letterSpacing ?? 0;
  const str = style.textTransform === 'uppercase' ? text.toUpperCase() : text;
  const width = (s) => [...s].reduce((a, ch) => a + em(ch) * fontSize * weight + spacing, 0);

  let lines = 0;
  let widest = 0;
  for (const para of str.split('\n')) {
    let line = '';
    for (const word of para.split(/(?<=\s)/)) {
      const w = width(word.trimEnd());
      if (line && width(line + word.trimEnd()) > maxWidth) {
        widest = Math.max(widest, width(line.trimEnd()));
        lines += 1;
        line = '';
      }
      // A single word wider than the line wraps onto extra lines by itself.
      if (!line && w > maxWidth) lines += Math.ceil(w / maxWidth) - 1;
      line += word;
    }
    widest = Math.max(widest, Math.min(width(line.trimEnd()), maxWidth));
    lines += 1;
  }
  if (numberOfLines > 0) lines = Math.min(lines, numberOfLines);
  return { width: Math.min(widest, maxWidth), height: lines * lineHeight };
}

const textOf = (children) => (children ?? [])
  .map((c) => (typeof c === 'string' ? c : textOf(c?.children)))
  .join('');

const flat = (style) => StyleSheet.flatten(style) ?? {};

/* ------------------------------------------------------------------ tree */

const isListBody = (el) =>
  el.props.data !== undefined || el.props.sections !== undefined || el.props.getItem !== undefined;

function leaf(measure) {
  const node = Y.Node.create(config);
  node.setMeasureFunc((width, widthMode) => {
    const max = widthMode === MeasureMode.Undefined ? Infinity : width;
    const size = measure(max);
    return {
      width: widthMode === MeasureMode.Exactly ? width : Math.min(size.width, max),
      height: size.height,
    };
  });
  return node;
}

/** Builds a Yoga node for one rendered element. Returns null for things that are not in the flow. */
function build(el, ctx) {
  if (el == null || typeof el === 'string') return null;
  const style = flat(el.props.style);
  let node;

  switch (el.type) {
    case 'Modal':
      // A modal draws over the whole screen, not inside its parent. It is
      // measured on its own (see findModals).
      return null;

    case 'Text': {
      const text = textOf(el.children);
      node = leaf((max) => textSize(text, style, max, el.props.numberOfLines));
      break;
    }

    case 'TextInput': {
      const fontSize = style.fontSize ?? 14;
      const lines = el.props.multiline ? Math.max(1, el.props.numberOfLines ?? 1) : 1;
      node = leaf((max) => ({
        width: Number.isFinite(max) ? max : 120,
        height: (style.lineHeight ?? fontSize * 1.2) * lines,
      }));
      break;
    }

    case 'ActivityIndicator': {
      const size = el.props.size === 'large' ? 36 : 20;
      node = leaf(() => ({ width: size, height: size }));
      break;
    }

    case 'RCTScrollView':
      if (el.props.horizontal) {
        node = Y.Node.create(config);
        applyStyle(node, { flexDirection: 'row', ...style });
        addChildren(node, el.children?.[0]?.children ?? el.children, ctx);
        ctx.elements.set(node, el);
        return node;
      }
      node = scrollNode(el, style, ctx);
      break;

    default:
      node = Y.Node.create(config);
      applyStyle(node, style);
      addChildren(node, el.children, ctx);
      ctx.elements.set(node, el);
      return node;
  }

  applyStyle(node, style);
  ctx.elements.set(node, el);
  return node;
}

// Child lists are kept here as well as in Yoga: Yoga's getChild() returns a new
// wrapper object each time, which would not match the element map.
function addChildren(node, children, ctx) {
  const kids = [];
  for (const child of children ?? []) {
    const c = build(child, ctx);
    if (c) { node.insertChild(c, node.getChildCount()); kids.push(c); }
  }
  ctx.kids.set(node, kids);
}

/**
 * A vertical ScrollView is a leaf here: it wants its content's height but, like
 * React Native's own ScrollView (flexGrow 1, flexShrink 1), gives way to what
 * the screen has room for. Whether its content then fits is checked afterwards.
 */
function scrollNode(el, style, ctx) {
  // The content container; a pull-to-refresh control renders beside it.
  const inner = (el.children ?? []).find((c) => c && typeof c !== 'string' && c.type !== 'RCTRefreshControl');
  const containerStyle = { ...flat(inner?.props?.style), ...flat(el.props.contentContainerStyle) };
  const contentChildren = inner?.children ?? [];
  const cache = new Map();
  const contentHeight = (width) => {
    if (!cache.has(width)) {
      const sub = { scrolls: [], elements: new Map(), kids: new Map() };
      const root = Y.Node.create(config);
      applyStyle(root, containerStyle);
      addChildren(root, contentChildren, sub);
      root.calculateLayout(width, undefined);
      cache.set(width, root.getComputedHeight());
      root.freeRecursive();
    }
    return cache.get(width);
  };

  const node = leaf((max) => ({
    width: Number.isFinite(max) ? max : 0,
    height: Number.isFinite(max) ? contentHeight(max) : 0,
  }));
  node.setFlexGrow(1);
  node.setFlexShrink(1);
  ctx.scrolls.push({ node, el, listBody: isListBody(el), contentHeight });
  return node;
}

/* ---------------------------------------------------------------- report */

const edges = (node, get) => get.call(node, Edge.Top) + get.call(node, Edge.Bottom);
const sides = (node, get) => get.call(node, Edge.Left) + get.call(node, Edge.Right);

function describe(el) {
  const text = textOf(el?.children).replace(/\s+/g, ' ').trim();
  return text ? `"${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"` : (el?.type ?? 'element');
}

/** Visible modals anywhere in the tree, including inside scroll content. */
function findModals(children, out = []) {
  for (const el of children ?? []) {
    if (el == null || typeof el === 'string') continue;
    if (el.type === 'Modal') out.push(el);
    else findModals(el.children, out);
  }
  return out;
}

// What a driver reads or taps. Backgrounds may run under the navigation bar;
// these may not.
const CONTENT = new Set(['Text', 'TextInput', 'Image']);

function measureRoot(children, width, height, where, reserveBottom = 0) {
  const ctx = { scrolls: [], elements: new Map(), kids: new Map() };
  const root = Y.Node.create(config);
  root.setWidth(width);
  root.setHeight(height);
  addChildren(root, children, ctx);
  root.calculateLayout(width, height);

  const findings = [];

  for (const s of ctx.scrolls) {
    if (s.listBody) continue;
    const innerWidth = s.node.getComputedWidth()
      - sides(s.node, s.node.getComputedPadding) - sides(s.node, s.node.getComputedBorder);
    const frame = s.node.getComputedHeight()
      - edges(s.node, s.node.getComputedPadding) - edges(s.node, s.node.getComputedBorder);
    const content = s.contentHeight(innerWidth);
    if (content > frame + 0.5) {
      findings.push({
        where, kind: 'scrolls', overflow: Math.round(content - frame),
        detail: `ScrollView content is ${Math.round(content)} pt in a ${Math.round(frame)} pt frame`,
      });
    }
  }

  // Anything past the bottom of the screen is cut off, and so is anything
  // pushed above the top (a bottom sheet taller than the screen). Report the worst.
  let worst = null;
  let underBar = null;
  const walk = (node, top) => {
    const t = top + node.getComputedTop();
    const bottom = t + node.getComputedHeight();
    const below = bottom - height;
    const above = -t;
    const over = Math.max(below, above);
    const el = ctx.elements.get(node);
    if (over > 0.5 && node !== root && (!worst || over > worst.over)) {
      worst = { over, side: below >= above ? 'below' : 'above', el };
    }
    // Text, inputs and images must stay clear of the phone's navigation bar.
    const intoBar = bottom - (height - reserveBottom);
    if (reserveBottom && below <= 0.5 && intoBar > 0.5 && CONTENT.has(el?.type)
      && (!underBar || intoBar > underBar.over)) {
      underBar = { over: intoBar, el };
    }
    for (const kid of ctx.kids.get(node) ?? []) walk(kid, t);
  };
  walk(root, 0);
  if (worst) {
    findings.push({
      where, kind: 'cut off', overflow: Math.round(worst.over),
      detail: `${describe(worst.el)} runs ${Math.round(worst.over)} pt ${worst.side} the screen`,
    });
  }
  if (underBar) {
    findings.push({
      where, kind: 'under the navigation bar', overflow: Math.round(underBar.over),
      detail: `${describe(underBar.el)} sits ${Math.round(underBar.over)} pt under the phone's navigation bar`,
    });
  }

  root.freeRecursive();
  return findings;
}

/**
 * Measures a rendered screen.
 * @param json     renderer.toJSON()
 * @param width    screen width in pt
 * @param height   height left for the screen (below status bar and header)
 * @param modalHeight  height a modal gets (the whole screen below the status bar)
 * @param reserveBottom  the phone's navigation bar: the last pt of the screen
 *                 (and of a modal) that text, inputs and images must stay out of
 */
export function measureScreen(json, { width, height, modalHeight = height, reserveBottom = 0 }) {
  const top = Array.isArray(json) ? json : [json];
  const findings = measureRoot(top, width, height, 'screen', reserveBottom);
  const modals = findModals(top);
  modals.forEach((m, i) => {
    const label = modals.length > 1 ? `modal ${i + 1}` : 'modal';
    findings.push(...measureRoot(m.children, width, modalHeight, label, reserveBottom));
  });
  return { findings };
}
