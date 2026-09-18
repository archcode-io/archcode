/**
 * ArchCode for VS Code: a live preview beside the file, and the engine's
 * diagnostics in the Problems panel. The engine runs in the extension host
 * (Node); the webview only shows the picture and the lens buttons.
 */
const vscode = require('vscode');

let engine = null;                    // the ESM engine, loaded once on first use
const load = async () => engine ??= await import('@archcode-io/engine');

const SEVERITY = { error: 0, warning: 1, info: 2 };   // vscode.DiagnosticSeverity
const diagnostics = vscode.languages.createDiagnosticCollection('archcode');

/** parse → lower → check, as the Playground does; a broken file still yields a model. */
async function analyse(doc) {
  const { parse, lower, check } = await load();
  const src = doc.getText();
  const { doc: tree, diagnostics: ds } = parse(src);
  const model = lower(tree);
  const all = [...ds, ...check(tree, model)];
  diagnostics.set(doc.uri, all.map(d => {
    const line = Math.max(0, d.line - 1), col = Math.max(0, d.col - 1);
    const text = doc.lineAt(Math.min(line, doc.lineCount - 1)).text;
    const end = Math.max(col + 1, (text.slice(col).match(/^[\w.\-@:/"]+/) ?? [''])[0].length + col);
    const out = new vscode.Diagnostic(new vscode.Range(line, col, line, end), d.message, SEVERITY[d.severity] ?? 2);
    out.code = d.code; out.source = 'archcode';
    return out;
  }));
  return model;
}

// ---- preview -------------------------------------------------------------
const previews = new Map();           // document uri → panel
let timer = null;

async function render(model, opts) {
  const { applyLens, layout, toSvg } = await load();
  const g = applyLens(model, { lens: opts.lens, kind: opts.kind });
  const l = await layout(g);
  return toSvg(l, '', { theme: opts.theme, name: opts.name });
}

function openPreview(context, doc) {
  const key = doc.uri.toString();
  if (previews.has(key)) { previews.get(key).panel.reveal(vscode.ViewColumn.Beside, true); return; }
  const panel = vscode.window.createWebviewPanel('archcode.preview', `Preview ${doc.fileName.split(/[\\/]/).pop()}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
  const state = { panel, lens: 'logical', kind: 'model' };
  previews.set(key, state);
  panel.webview.html = shell(panel.webview);
  panel.onDidDispose(() => previews.delete(key));
  panel.webview.onDidReceiveMessage(m => {
    if (m.type === 'lens') state.lens = m.value;
    if (m.type === 'kind') state.kind = m.value;
    if (m.type === 'export') exportSvg(doc, state);
    refresh(doc);
  });
  refresh(doc);
}

async function refresh(doc) {
  const state = previews.get(doc.uri.toString());
  if (!state) return;
  try {
    const model = await analyse(doc);
    const theme = [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind) ? 'light' : 'dark';
    const svg = await render(model, { lens: state.lens, kind: state.kind, theme, name: doc.fileName });
    state.panel.webview.postMessage({ type: 'svg', svg, lens: state.lens, kind: state.kind, theme });
  } catch (err) {
    state.panel.webview.postMessage({ type: 'error', message: String(err) });
  }
}

async function exportSvg(doc, state) {
  const model = await analyse(doc);
  const svg = await render(model, { lens: state.lens, kind: state.kind, theme: 'light', name: doc.fileName });
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(doc.fileName.replace(/\.arch$/, '') + `-${state.kind}.svg`), filters: { SVG: ['svg'] } });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(svg, 'utf8'));
  vscode.window.showInformationMessage(`ArchCode: saved ${target.fsPath.split(/[\\/]/).pop()}`);
}

function shell(webview) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>
  body{margin:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
  .bar{display:flex;gap:6px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);position:sticky;top:0;background:var(--vscode-editor-background);z-index:2}
  .seg{display:inline-flex;border:1px solid var(--vscode-panel-border);border-radius:5px;overflow:hidden}
  .seg button{background:none;border:0;color:var(--vscode-foreground);padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;opacity:.7}
  .seg button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground);opacity:1}
  .grow{flex:1} .bar .x{background:none;border:1px solid var(--vscode-panel-border);border-radius:5px;color:var(--vscode-foreground);padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
  #pic{padding:12px;overflow:auto} #pic svg{max-width:100%;height:auto;display:block}
  .err{padding:12px;color:var(--vscode-errorForeground);font-family:var(--vscode-editor-font-family);white-space:pre-wrap}
</style></head><body>
<div class="bar">
  <span class="seg" data-key="kind"><button data-v="model" class="on">Model</button><button data-v="deployment">Deployment</button></span>
  <span class="seg" data-key="lens"><button data-v="logical" class="on">Logical</button><button data-v="infrastructure">Infrastructure</button></span>
  <span class="grow"></span><button class="x" id="export">Export SVG…</button>
</div>
<div id="pic"></div>
<script>
  const vscode = acquireVsCodeApi();
  for (const seg of document.querySelectorAll('.seg')) for (const b of seg.querySelectorAll('button'))
    b.onclick = () => { seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); vscode.postMessage({ type: seg.dataset.key, value: b.dataset.v }); };
  document.getElementById('export').onclick = () => vscode.postMessage({ type: 'export' });
  window.addEventListener('message', e => {
    const m = e.data, pic = document.getElementById('pic');
    if (m.type === 'svg') pic.innerHTML = m.svg;
    else if (m.type === 'error') pic.innerHTML = '<div class="err">' + m.message.replace(/</g, '&lt;') + '</div>';
  });
</script></body></html>`;
}

// ---- activation ----------------------------------------------------------
function activate(context) {
  const isArch = d => d.languageId === 'archcode' || d.fileName.endsWith('.arch');
  const schedule = doc => { clearTimeout(timer); timer = setTimeout(() => { analyse(doc).catch(() => {}); refresh(doc); }, 250); };

  context.subscriptions.push(
    diagnostics,
    vscode.commands.registerCommand('archcode.preview', () => { const ed = vscode.window.activeTextEditor; if (ed && isArch(ed.document)) openPreview(context, ed.document); }),
    vscode.workspace.onDidOpenTextDocument(d => { if (isArch(d)) analyse(d).catch(() => {}); }),
    vscode.workspace.onDidChangeTextDocument(e => { if (isArch(e.document)) schedule(e.document); }),
    vscode.workspace.onDidCloseTextDocument(d => diagnostics.delete(d.uri)),
    vscode.window.onDidChangeActiveColorTheme(() => { for (const [k] of previews) { const d = vscode.workspace.textDocuments.find(x => x.uri.toString() === k); if (d) refresh(d); } }),
  );
  for (const d of vscode.workspace.textDocuments) if (isArch(d)) analyse(d).catch(() => {});
}
function deactivate() {}
module.exports = { activate, deactivate };
