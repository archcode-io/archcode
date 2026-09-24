/** Vocabulary frozen for grammar v0.1 (spec §4, amended by D-126 and D-136). */

export const OBJECT_KINDS = new Set([
  // L1 context
  'system', 'external', 'actor',
  // L2 container — `container` is the generic one, for a sketch or a Structurizr import (D-368)
  'container', 'service', 'webapp', 'app', 'gateway', 'broker', 'datastore', 'cache', 'function', 'job',
  // L3 component
  'component',
  // channels and contracts — first class since D-126 / D-129
  'topic', 'contract',
  // model-level blocks
  'arch', 'env', 'cluster', 'node', 'managed', 'segment', 'decision', 'rule', 'view', 'board', 'profile',
]);

/**
 * Attributes that are complete on their own (`{ transit }`). Inside a one-line
 * body or an inline declaration they never swallow the next word as a value.
 */
export const FLAG_ATTRS = new Set(['transit']);

export const VERBS = new Set([
  'calls', 'publishes', 'subscribes', 'reads', 'writes', 'uses', 'streams', 'depends_on',
  // sugar (spec §4.2)
  'emits', 'listens',
]);

/** Interface statements (spec §4.3): `exposes http openapi://…`, `stores schema sql://…`. Not relations — nothing on the other end. */
export const IFACE_VERBS = new Set(['exposes', 'stores']);

/** Canonical form for the two sugar verbs. */
export const VERB_SUGAR: Record<string, string> = { emits: 'publishes', listens: 'subscribes' };

/** Words that introduce a modifier inside a relation: `over SQL`, `via rabbit`. */
export const RELATION_MODIFIERS = new Set(['over', 'via', 'spec', 'as', 'port']);

/**
 * Attribute keys the language knows (spec §5, §6.2, §6.7). Any other key is
 * still kept verbatim; this list exists so that `capacity calls 20000/day`
 * reads as an attribute even though `calls` is a verb.
 */
export const ATTR_KEYS = new Set([
  'tech', 'owner', 'tags', 'criticality', 'retention', 'pii', 'stage', 'description', 'repo', 'domain',
  'capacity', 'availability', 'rto', 'rpo', 'backup', 'phase', 'scope', 'code',
  'replicas', 'count', 'nodes', 'cpu', 'mem', 'disk', 'gpu', 'host', 'ip', 'os', 'agent', 'region', 'dc', 'vlan',
  'data', 'manifest', 'role', 'auth', 'ratelimit', 'transit', 'owned_by', 'publisher', 'subscriber', 'via',
]);

/**
 * Reserved in v0.2 (D-305/A4): the parser keeps the block byte for byte and
 * says so; nothing inside is read as objects or relations.
 */
export const RESERVED_KINDS = new Set(['decision', 'rule', 'board', 'profile']);
/** Blocks whose body is not model statements: kept raw, never lowered. */
export const OPAQUE_KINDS = new Set([...RESERVED_KINDS, 'view']);

/**
 * Keys that end the value list before them on a shared line (`dc dc1  vlan 3076`).
 * `data` is out: it is a sub-key of `disk` (`disk system 30Gi data 200Gi`).
 */
export const PAIR_KEYS = new Set([...ATTR_KEYS].filter(k => k !== 'data'));

/** Blocks that describe where things run (spec §6). They are frames, never cards. */
export const PLACEMENT_KINDS = new Set(['env', 'cluster', 'managed', 'segment', 'node']);

/** `run checkout replicas 6 cpu 2 mem 4Gi` — a placement statement inside a placement block. */
export const RUN = 'run';
/** What a `run` line may carry inline: its sizing and its phase. */
export const RUN_KEYS = new Set(['replicas', 'count', 'nodes', 'cpu', 'mem', 'disk', 'gpu', 'phase', 'at']);
