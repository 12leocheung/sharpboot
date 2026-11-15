import './styles.css';
import { compileProgram } from './core/pipeline.ts';
import type { BuildResult } from './core/pipeline.ts';
import { BytecodeVm } from './core/vm.ts';
import type { VmCell, VmState } from './core/vm.ts';
import { describeLayout } from './core/image.ts';
import { GRAPHICS_HEIGHT, GRAPHICS_WIDTH } from './core/graphics.ts';
import { SAMPLES, DEFAULT_SAMPLE } from './core/samples.ts';

const VGA_PALETTE = [
  '#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
  '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff',
];

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const editor = must<HTMLTextAreaElement>('editor');
const gutter = must<HTMLDivElement>('gutter');
const fileChip = must<HTMLSpanElement>('file-chip');
const editorMeta = must<HTMLSpanElement>('editor-meta');
const editorPanel = must<HTMLElement>('editor-panel');
const repairBtn = must<HTMLButtonElement>('repair-btn');
const sampleBtn = must<HTMLButtonElement>('sample-btn');
const samplesBox = must<HTMLDivElement>('samples');
const openBtn = must<HTMLButtonElement>('open-file');
const fileInput = must<HTMLInputElement>('file-input');

const stagesEl = must<HTMLOListElement>('stages');
const pipelineSummary = must<HTMLSpanElement>('pipeline-summary');
const repairCount = must<HTMLSpanElement>('repair-count');
const repairLog = must<HTMLDivElement>('repair-log');
const errorsEl = must<HTMLDivElement>('errors');

const screenEl = must<HTMLDivElement>('screen');
const gfxCanvas = must<HTMLCanvasElement>('gfx');
const gfxContext2d = gfxCanvas.getContext('2d');
if (!gfxContext2d) throw new Error('Canvas 2D context is unavailable');
const gfxContext: CanvasRenderingContext2D = gfxContext2d;
const gfxImage = gfxContext.createImageData(GRAPHICS_WIDTH, GRAPHICS_HEIGHT);
const screenEmpty = must<HTMLDivElement>('screen-empty');
const screenEmptyDetail = must<HTMLSpanElement>('screen-empty-detail');
const consoleStatus = must<HTMLSpanElement>('console-status');
const stdinInput = must<HTMLInputElement>('stdin');
const sendLineBtn = must<HTMLButtonElement>('send-line');
const rebootBtn = must<HTMLButtonElement>('reboot');

const downloadBtn = must<HTMLButtonElement>('download');
const copyBtn = must<HTMLButtonElement>('copy-qemu');
const buildMeta = must<HTMLSpanElement>('build-meta');
const qemuCmd = must<HTMLElement>('qemu-cmd');
const layoutEl = must<HTMLElement>('layout');

const engineStatus = must<HTMLSpanElement>('engine-status');
const engineLed = must<HTMLElement>('engine-led');
const toast = must<HTMLDivElement>('toast');

interface UiState {
  source: string;
  filename: string;
  result: BuildResult | null;
  vm: BytecodeVm | null;
  vmState: VmState | 'empty';
}

const state: UiState = {
  source: DEFAULT_SAMPLE.source,
  filename: DEFAULT_SAMPLE.filename,
  result: null,
  vm: null,
  vmState: 'empty',
};

let convertTimer = 0;
let toastTimer = 0;

function flash(message: string): void {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2400);
}

function imageName(result: BuildResult): string {
  const base = result.filename.replace(/\.(cs|txt)$/i, '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  return `sharpboot-${base || 'program'}.img`;
}

function updateMeta(): void {
  const lines = state.source.split('\n').length;
  const bytes = new TextEncoder().encode(state.source).length;
  editorMeta.textContent = `${lines} lines · ${bytes} bytes`;
  fileChip.textContent = state.filename;

  const numbers: string[] = [];
  for (let i = 1; i <= lines; i++) numbers.push(String(i));
  gutter.textContent = numbers.join('\n');
}

function setStatus(ok: boolean): void {
  engineStatus.textContent = ok ? 'ready' : 'blocked';
  engineLed.className = ok ? 'led' : 'led bad';
}

function renderStages(result: BuildResult): void {
  stagesEl.replaceChildren();
  for (const stage of result.stages) {
    const item = el('li', `stage ${stage.status}`);
    item.append(
      el('span', 'stage-dot'),
      el('span', 'stage-label', stage.label),
      el('span', 'stage-detail', stage.detail),
      el('span', 'stage-ms', stage.ms >= 1 ? `${Math.round(stage.ms)} ms` : '<1 ms'),
    );
    stagesEl.append(item);
  }
  pipelineSummary.textContent = result.ok
    ? `${result.stats.bytecodeBytes} B bytecode · build ${result.buildId}`
    : 'conversion blocked';
}

function renderRepairs(result: BuildResult): void {
  repairLog.replaceChildren();
  repairCount.textContent = result.repairs.length === 0
    ? 'clean'
    : `${result.repairs.length} entr${result.repairs.length === 1 ? 'y' : 'ies'}`;

  if (result.repairs.length === 0) {
    const empty = el('div', 'log-empty');
    empty.append(el('span', 'tick', '✓'), el('span', undefined, 'No repairs needed — the source compiled cleanly.'));
    repairLog.append(empty);
    return;
  }

  for (const repair of result.repairs.slice(0, 80)) {
    const item = el('div', 'log-item');
    const badgeClass = repair.phase === 'source' ? 'fix' : repair.phase === 'runtime' ? 'patch' : 'note';
    const badgeText = repair.phase === 'source' ? 'FIX' : repair.phase === 'runtime' ? 'PATCH' : 'NOTE';
    const body = el('div', 'log-body');
    body.append(el('div', 'log-title', repair.title));
    if (repair.detail) body.append(el('div', 'log-detail', repair.detail));
    item.append(el('span', `badge ${badgeClass}`, badgeText), body, el('span', 'log-line', repair.line ? `L${repair.line}` : ''));
    repairLog.append(item);
  }
}

function renderDiagnostics(result: BuildResult): void {
  errorsEl.replaceChildren();
  if (result.diagnostics.length === 0) {
    errorsEl.hidden = true;
    return;
  }

  errorsEl.hidden = false;
  for (const diagnostic of result.diagnostics) {
    const item = el('div', 'error-item');
    const body = el('div');
    body.append(el('div', 'error-message', diagnostic.message));
    if (diagnostic.hint) body.append(el('div', 'error-hint', diagnostic.hint));
    item.append(
      el('span', `badge ${diagnostic.severity === 'error' ? 'patch' : 'note'}`, diagnostic.severity === 'error' ? 'ERR' : 'WARN'),
      body,
      el('span', 'error-line', diagnostic.line ? `L${diagnostic.line}` : ''),
    );
    errorsEl.append(item);
  }
}

function cellSpan(text: string, attr: number): HTMLSpanElement {
  const span = el('span', undefined, text);
  span.style.color = VGA_PALETTE[attr & 0x0f];
  span.style.backgroundColor = VGA_PALETTE[(attr >> 4) & 0x0f];
  return span;
}

function fitScreen(): void {
  const crt = screenEl.parentElement;
  if (!crt) return;
  const width = crt.clientWidth - 22;
  const height = crt.clientHeight - 22;
  if (width <= 0 || height <= 0) return;
  const size = Math.min(width / 50, height / 26);
  screenEl.style.fontSize = `${Math.max(4.6, Math.min(16, size))}px`;
}

function renderScreen(cells: VmCell[]): void {
  const fragment = document.createDocumentFragment();
  for (let row = 0; row < 25; row++) {
    const rowEl = el('div', 'row');
    let text = '';
    let currentAttr = -1;
    for (let col = 0; col < 80; col++) {
      const cell = cells[row * 80 + col];
      if (cell.attr !== currentAttr) {
        if (text.length > 0) rowEl.append(cellSpan(text, currentAttr));
        text = '';
        currentAttr = cell.attr;
      }
      text += cell.ch;
    }
    if (text.length > 0) rowEl.append(cellSpan(text, currentAttr));
    fragment.append(rowEl);
  }

  screenEl.replaceChildren(fragment);
  screenEl.style.visibility = '';
  screenEmpty.hidden = true;
  fitScreen();
}

function renderGraphics(pixels: Uint8Array, palette: Uint8Array): void {
  const data = gfxImage.data;
  for (let index = 0, offset = 0; index < pixels.length; index++, offset += 4) {
    const entry = pixels[index] * 3;
    data[offset] = palette[entry];
    data[offset + 1] = palette[entry + 1];
    data[offset + 2] = palette[entry + 2];
    data[offset + 3] = 255;
  }
  gfxContext.putImageData(gfxImage, 0, 0);
  gfxCanvas.hidden = false;
  screenEl.style.visibility = 'hidden';
  screenEmpty.hidden = true;
}

function renderDisplay(vm: BytecodeVm): void {
  if (vm.graphicsActive()) {
    renderGraphics(vm.graphicsPixels(), vm.palette());
    return;
  }
  gfxCanvas.hidden = true;
  renderScreen(vm.screenCells());
}

function runLabel(vm: BytecodeVm, vmState: UiState['vmState']): string {
  if (vmState === 'waiting-line') return 'waiting for a line';
  if (vmState === 'waiting-key') return 'waiting for a key';
  if (vmState === 'halted') return 'halted';
  if (vmState === 'error') return `runtime error: ${vm.errorMessage}`;
  if (vmState === 'running') return 'running';
  return 'not running';
}

function renderRuntime(): void {
  const vm = state.vm;
  const waitingLine = state.vmState === 'waiting-line';
  const waitingKey = state.vmState === 'waiting-key';
  consoleStatus.textContent = vm ? runLabel(vm, state.vmState) : 'no program loaded';
  consoleStatus.className = `console-status ${state.vmState}`;
  stdinInput.disabled = !waitingLine;
  sendLineBtn.disabled = !waitingLine;
  stdinInput.placeholder = waitingLine
    ? 'type a line and press Enter'
    : waitingKey
      ? 'waiting for ReadKey — click the screen, then press a key'
      : 'stdin is available when the program calls ReadLine';
  rebootBtn.disabled = !state.result?.compiled;
}

function pump(): void {
  const vm = state.vm;
  if (!vm) return;
  try {
    state.vmState = vm.run();
  } catch (err) {
    state.vmState = 'error';
    consoleStatus.textContent = `runtime error: ${err instanceof Error ? err.message : String(err)}`;
    consoleStatus.className = 'console-status error';
    return;
  }
  renderDisplay(vm);
  renderRuntime();
}

function stopVm(): void {
  state.vm = null;
  state.vmState = 'empty';
  screenEl.replaceChildren();
  gfxCanvas.hidden = true;
  screenEl.style.visibility = 'hidden';
  screenEmpty.hidden = false;
  renderRuntime();
}

function startVm(result: BuildResult): void {
  if (!result.compiled) {
    stopVm();
    screenEmptyDetail.textContent = 'fix the diagnostics to boot the image';
    return;
  }
  state.vm = new BytecodeVm(result.compiled);
  state.vmState = 'running';
  screenEmptyDetail.textContent = 'booting the bytecode VM';
  stdinInput.value = '';
  pump();
}

function renderBuild(result: BuildResult): void {
  downloadBtn.disabled = !(result.ok && result.image);
  copyBtn.disabled = !result.ok;
  buildMeta.textContent = result.ok
    ? `1.44 MB · ${result.stats.methods} method${result.stats.methods === 1 ? '' : 's'} · ${result.buildId}`
    : 'image not generated';
  qemuCmd.textContent = `qemu-system-i386 -fda ${imageName(result)}`;

  layoutEl.replaceChildren();
  if (!result.layout) return;
  for (const row of describeLayout(result.layout)) {
    const wrapper = el('div');
    wrapper.append(el('dt', undefined, row.label), el('dd', undefined, row.value));
    layoutEl.append(wrapper);
  }
}

function renderResult(result: BuildResult): void {
  renderStages(result);
  renderRepairs(result);
  renderDiagnostics(result);
  renderBuild(result);
  setStatus(result.ok);

  const sourceRepairs = result.repairs.filter((repair) => repair.phase === 'source').length;
  repairBtn.disabled = sourceRepairs === 0;
  repairBtn.textContent = sourceRepairs > 0
    ? `Apply ${sourceRepairs} repair${sourceRepairs === 1 ? '' : 's'}`
    : 'No repairs to apply';

  if (result.ok && result.compiled) {
    startVm(result);
    return;
  }

  stopVm();
  const error = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  screenEmptyDetail.textContent = error
    ? `${error.message}${error.line ? ` (line ${error.line})` : ''}`
    : 'fix the diagnostics to boot the image';
}

function convert(): void {
  window.clearTimeout(convertTimer);
  state.source = editor.value;
  try {
    const result = compileProgram(state.source, state.filename);
    state.result = result;
    renderResult(result);
  } catch (err) {
    stopVm();
    engineStatus.textContent = 'engine error';
    engineLed.className = 'led bad';
    const detail = err instanceof Error ? err.message : String(err);
    screenEmptyDetail.textContent = detail;
    flash(`Conversion engine error: ${detail}`);
  }
}

function scheduleConvert(): void {
  window.clearTimeout(convertTimer);
  convertTimer = window.setTimeout(convert, 280);
}

function applyRepairs(): void {
  const result = state.result;
  if (!result) return;
  state.source = result.repairedSource;
  editor.value = state.source;
  updateMeta();
  convert();
  flash('Repairs applied to the source');
}

function loadSource(source: string, filename: string, message?: string): void {
  state.source = source;
  state.filename = filename;
  editor.value = source;
  samplesBox.hidden = true;
  sampleBtn.setAttribute('aria-expanded', 'false');
  updateMeta();
  convert();
  if (message) flash(message);
}

function loadFile(file: File): void {
  if (file.size > 2_000_000) {
    flash('That file is larger than 2 MB — too big for this editor.');
    return;
  }
  file
    .text()
    .then((text) => {
      loadSource(text, file.name || 'Program.cs', `Loaded ${file.name}`);
    })
    .catch(() => {
      flash('Could not read that file.');
    });
}

function buildSampleMenu(): void {
  for (const sample of SAMPLES) {
    const button = el('button', 'sample');
    button.type = 'button';
    button.append(el('span', 'sample-label', sample.label), el('span', 'sample-hint', sample.hint));
    button.addEventListener('click', () => loadSource(sample.source, sample.filename, `Loaded ${sample.label}`));
    samplesBox.append(button);
  }
}

function sendLine(): void {
  if (!state.vm || state.vmState !== 'waiting-line') return;
  state.vm.feedLine(stdinInput.value);
  stdinInput.value = '';
  pump();
}

function feedKey(ch: string): void {
  if (!state.vm || state.vmState !== 'waiting-key') return;
  state.vm.feedKey(ch);
  pump();
}

editor.value = state.source;
updateMeta();
buildSampleMenu();

editor.addEventListener('input', () => {
  state.source = editor.value;
  updateMeta();
  scheduleConvert();
});

editor.addEventListener('scroll', () => {
  gutter.scrollTop = editor.scrollTop;
});

editor.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.value = `${editor.value.slice(0, start)}    ${editor.value.slice(end)}`;
  editor.selectionStart = start + 4;
  editor.selectionEnd = start + 4;
  state.source = editor.value;
  updateMeta();
  scheduleConvert();
});

must<HTMLButtonElement>('guide-demo').addEventListener('click', () => {
  const sample = SAMPLES.find((entry) => entry.id === 'graphics');
  if (!sample) return;
  loadSource(sample.source, sample.filename, 'Graphics demo loaded');
  screenEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

sampleBtn.addEventListener('click', () => {
  const open = samplesBox.hidden;
  samplesBox.hidden = !open;
  sampleBtn.setAttribute('aria-expanded', String(open));
});

repairBtn.addEventListener('click', applyRepairs);

openBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
  fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  editorPanel.addEventListener(type, (event) => {
    event.preventDefault();
    editorPanel.classList.add('dragover');
  });
}

for (const type of ['dragleave', 'drop']) {
  editorPanel.addEventListener(type, (event) => {
    event.preventDefault();
    editorPanel.classList.remove('dragover');
  });
}

editorPanel.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

rebootBtn.addEventListener('click', () => {
  if (!state.result?.compiled) return;
  stopVm();
  startVm(state.result);
  flash('VM rebooted from bytecode');
});

sendLineBtn.addEventListener('click', sendLine);

stdinInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  sendLine();
});

screenEl.addEventListener('click', () => {
  if (state.vmState === 'waiting-key') screenEl.focus();
});

gfxCanvas.addEventListener('click', () => screenEl.focus());

window.addEventListener('keydown', (event) => {
  if (state.vmState !== 'waiting-key') return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('textarea, input, select, button, a')) return;

  if (event.key.length === 1) {
    event.preventDefault();
    feedKey(event.key);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    feedKey('\r');
  } else if (event.key === 'Escape') {
    event.preventDefault();
    feedKey('\x1b');
  } else if (event.key === 'Backspace') {
    event.preventDefault();
    feedKey('\b');
  }
});

downloadBtn.addEventListener('click', () => {
  const result = state.result;
  if (!result?.image) return;
  const bytes = new Uint8Array(result.image.length);
  bytes.set(result.image);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = imageName(result);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  flash(`Downloaded ${imageName(result)}`);
});

copyBtn.addEventListener('click', () => {
  const command = qemuCmd.textContent ?? '';
  if (!navigator.clipboard) {
    flash('Clipboard unavailable — select the command below');
    return;
  }
  navigator.clipboard.writeText(command).then(
    () => flash('QEMU command copied'),
    () => flash('Copy failed — select the command below'),
  );
});

const crtElement = screenEl.parentElement;
if (crtElement) {
  new ResizeObserver(() => fitScreen()).observe(crtElement);
}
window.addEventListener('resize', fitScreen);

convert();
fitScreen();
