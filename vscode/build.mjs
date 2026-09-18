// Generates syntaxes/archcode.tmLanguage.json from the engine's vocabulary, so the
// colours never drift from the parser. Run after an engine change: node build.mjs
import { writeFileSync } from 'node:fs';
import { OBJECT_KINDS, PLACEMENT_KINDS, RESERVED_KINDS, VERBS, IFACE_VERBS, ATTR_KEYS } from '@archcode-io/engine';

const alt = set => [...set].sort((a, b) => b.length - a.length).join('|');
const grammar = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'ArchCode',
  scopeName: 'source.archcode',
  fileTypes: ['arch'],
  patterns: [{ include: '#comment' }, { include: '#pragma' }, { include: '#declaration' }, { include: '#interface' }, { include: '#relation' }, { include: '#run' }, { include: '#attribute' }, { include: '#string' }, { include: '#braces' }],
  repository: {
    comment: { match: '#.*$', name: 'comment.line.number-sign.archcode' },
    pragma: { match: '^\\s*(archcode)\\s+(\\S+)', captures: { 1: { name: 'keyword.control.directive.archcode' }, 2: { name: 'constant.numeric.version.archcode' } } },
    declaration: {
      match: `(?:^|(?<=\\{))\\s*(${alt(OBJECT_KINDS)}|${alt(PLACEMENT_KINDS)}|view|${alt(RESERVED_KINDS)})\\s+([A-Za-z_][\\w.\\-]*)`,
      captures: { 1: { name: 'storage.type.kind.archcode' }, 2: { name: 'entity.name.type.object.archcode' } },
    },
    interface: {
      match: `(?:^|\\s)(?:([A-Za-z_][\\w.\\-]*)\\s+)?(${alt(IFACE_VERBS)})\\s+([a-z][\\w-]*)(?:\\s+([a-z][\\w+.-]*://\\S+))?(?:\\s+(@\\S+))?`,
      captures: { 1: { name: 'variable.other.object.archcode' }, 2: { name: 'keyword.operator.interface.archcode' }, 3: { name: 'support.type.interface-kind.archcode' }, 4: { name: 'string.unquoted.pointer.archcode' }, 5: { name: 'constant.other.revision.archcode' } },
    },
    relation: {
      match: `(?:^|\\s)(?:([A-Za-z_][\\w.\\-]*)\\s+)?(${alt(VERBS)})\\s+([A-Za-z_][\\w.\\-]*)`,
      captures: { 1: { name: 'variable.other.object.archcode' }, 2: { name: 'keyword.operator.verb.archcode' }, 3: { name: 'variable.other.object.archcode' } },
    },
    run: { match: '(?:^|(?<=\\{))\\s*(run)\\s+([A-Za-z_][\\w.\\-]*(?:\\s*,\\s*[A-Za-z_][\\w.\\-]*)*)', captures: { 1: { name: 'keyword.control.run.archcode' }, 2: { name: 'variable.other.object.archcode' } } },
    attribute: {
      patterns: [
        { match: `(?<![\\w-])(${alt(ATTR_KEYS)}|over|via|port|spec|as|at)(?![\\w-])`, name: 'entity.other.attribute-name.archcode' },
        { match: '(?<![\\w-])x-[\\w-]+', name: 'entity.other.attribute-name.custom.archcode' },
        { match: '(?<![\\w.-])[+]?\\d[\\w.%/]*', name: 'constant.numeric.archcode' },
        { match: '@[\\w-]+', name: 'constant.other.owner.archcode' },
      ],
    },
    string: { match: '"(?:[^"\\\\]|\\\\.)*"', name: 'string.quoted.double.archcode' },
    braces: { match: '[{}]', name: 'punctuation.section.block.archcode' },
  },
};
writeFileSync(new URL('./syntaxes/archcode.tmLanguage.json', import.meta.url), JSON.stringify(grammar, null, 2) + '\n');
console.log('syntaxes/archcode.tmLanguage.json written');
