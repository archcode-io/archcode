export { lex } from './lexer.js';
export { parse, type ParseResult } from './parser.js';
export { serialize } from './serialize.js';
export { lower, type Model, type ModelObject, type ModelRelation, type Interface, type Placement } from './model.js';
export type { Doc, Decl, Attr, Rel, Run, Iface, Raw, Blank, Node } from './cst.js';
export type { Token, TokenKind } from './tokens.js';
export type { Diagnostic, Severity } from './diagnostics.js';
export { OBJECT_KINDS, VERBS, IFACE_VERBS, PLACEMENT_KINDS, RESERVED_KINDS, ATTR_KEYS } from './vocab.js';
export { check, LANGUAGE_VERSIONS } from './check.js';
export { toCompiled, toJSON, toYAML, type Compiled } from './compiled.js';

import { parse } from './parser.js';
import { serialize } from './serialize.js';

/** True when `parse → serialize` reproduces the input byte for byte. */
export function roundTrips(src: string): boolean {
  return serialize(parse(src).doc) === src;
}
export { applyLens, metaLine, footerOf, AGENT_ROW, type Lens, type RenderGraph, type RenderNode, type RenderEdge } from './lens.js';
export * from './layout/ortho.js';
export { layout, layoutLayered, type Layout, type LayoutOptions, type Positioned, type RoutedEdge } from './layout/elk.js';
export { layoutTwoPhase, type BalanceOptions } from './layout/balance.js';
export { routeSimple, routeAround, routeAll, simplify, type Pt, type Rect, type Side } from './layout/route.js';
export { toSvg, metaFits, THEMES } from './render/svg.js';
export { configureElk, elkInstance, useElkWorker } from './layout/host.js';
export type { ElkLike } from './layout/host.js';
export type { Theme, ThemeName } from './render/svg.js';
export { capacityTable, toGiB, toCpu, fmt, FIGURE_KEYS, effectiveSizing, hostLoad, SIZING_KEYS, type HostLoad, type CapacityTable, type CapacityEnv, type CapacityRow, type Figures } from './capacity.js';
export { labelAnchor, labelBox, fractionAlong, flippedSide, roundedPath } from './layout/label.js';
export { textWidth, nodeBox } from './layout/measure.js';
export {
  addObject, deleteObject, renameObject, setDisplayName, setAttribute,
  addRelation, deleteRelation, retargetRelation, setRelationVerb, setRelationAttr, moveInto, moveOut,
  insertStatement, addRun, deleteRun, setRunSizing,
} from './edit.js';
