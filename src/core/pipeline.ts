import type { Diagnostic, Repair } from './types.ts';
import { repairSource } from './repair.ts';
import { parse, flatMethods } from './parser.ts';
import type { Program } from './parser.ts';
import { compileToBytecode } from './compiler.ts';
import type { CompiledProgram } from './compiler.ts';
import { buildImage, IMAGE_SIZE } from './image.ts';
import type { ImageLayout } from './image.ts';

export interface Stage {
  id: string;
  label: string;
  detail: string;
  ms: number;
  status: 'ok' | 'warn' | 'error' | 'skipped';
}

export interface BuildStats {
  sourceLines: number;
  sourceBytes: number;
  classes: number;
  methods: number;
  bytecodeBytes: number;
  stringBytes: number;
  globals: number;
  kernelBytes: number;
  sectorCount: number;
  imageBytes: number;
  sourceRepairs: number;
}

export interface BuildResult {
  ok: boolean;
  filename: string;
  originalSource: string;
  repairedSource: string;
  repairs: Repair[];
  diagnostics: Diagnostic[];
  image?: Uint8Array;
  layout?: ImageLayout;
  compiled?: CompiledProgram;
  buildId: string;
  stages: Stage[];
  stats: BuildStats;
  elapsedMs: number;
}

const now = (): number => performance.now();

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function cleanFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'Program.cs';
  return base.trim().slice(0, 64) || 'Program.cs';
}

function stageId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export function compileProgram(rawSource: string, rawFilename: string): BuildResult {
  const started = now();
  const filename = cleanFilename(rawFilename);

  const repairs: Repair[] = [];
  const diagnostics: Diagnostic[] = [];
  const stages: Stage[] = [];

  const addStage = (label: string, detail: string, ms: number, status: Stage['status'] = 'ok'): void => {
    stages.push({ id: stageId(label), label, detail, ms, status });
  };
  const skipStages = (labels: string[]): void => {
    for (const label of labels) addStage(label, 'not reached', 0, 'skipped');
  };

  const stats: BuildStats = {
    sourceLines: rawSource.split('\n').length,
    sourceBytes: new TextEncoder().encode(rawSource).length,
    classes: 0,
    methods: 0,
    bytecodeBytes: 0,
    stringBytes: 0,
    globals: 0,
    kernelBytes: 0,
    sectorCount: 0,
    imageBytes: IMAGE_SIZE,
    sourceRepairs: 0,
  };

  const result: BuildResult = {
    ok: false,
    filename,
    originalSource: rawSource,
    repairedSource: rawSource,
    repairs,
    diagnostics,
    buildId: '00000000',
    stages,
    stats,
    elapsedMs: 0,
  };

  if (rawSource.trim().length === 0) {
    diagnostics.push({
      severity: 'error',
      message: 'The source file is empty',
      hint: 'Load one of the samples or paste a C# program with a static Main() method.',
    });
    addStage('Normalize + repair', 'no input', 0, 'error');
    skipStages(['Parse C#', 'Compile to bytecode', 'Link boot image']);
    return result;
  }

  const repairStarted = now();
  const repaired = repairSource(rawSource, parse);
  const repairMs = now() - repairStarted;
  repairs.push(...repaired.repairs);
  result.repairedSource = repaired.source;
  const sourceRepairs = repairs.filter((repair) => repair.phase === 'source').length;
  stats.sourceRepairs = sourceRepairs;
  result.buildId = fnv1a(repaired.source).toString(16).padStart(8, '0').slice(0, 8);

  addStage(
    'Normalize + repair',
    sourceRepairs === 0 ? 'source already clean' : `${sourceRepairs} fix${sourceRepairs === 1 ? '' : 'es'} applied`,
    repairMs,
    sourceRepairs > 0 ? 'warn' : 'ok',
  );

  const parseStarted = now();
  const parsed = parse(repaired.source);
  const parseMs = now() - parseStarted;

  if (!parsed.program) {
    const error = parsed.error ?? { severity: 'error' as const, message: 'Unable to parse the file' };
    diagnostics.push(error);
    addStage('Parse C#', `failed${error.line ? ` at line ${error.line}` : ''}`, parseMs, 'error');
    skipStages(['Compile to bytecode', 'Link boot image']);
    result.elapsedMs = now() - started;
    return result;
  }

  const program: Program = parsed.program;
  const methods = flatMethods(program);
  stats.classes = program.classes.length;
  stats.methods = methods.length;

  addStage(
    'Parse C#',
    `${program.classes.length} class · ${methods.length} method${methods.length === 1 ? '' : 's'}`,
    parseMs,
    'ok',
  );

  const compileStarted = now();
  const compiled = compileToBytecode(program);
  const compileMs = now() - compileStarted;
  diagnostics.push(...compiled.diagnostics);

  stats.bytecodeBytes = compiled.stats.bytecodeBytes;
  stats.stringBytes = compiled.stats.stringBytes;
  stats.globals = compiled.stats.globals;
  stats.methods = compiled.stats.methods;

  if (compiled.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    addStage('Compile to bytecode', 'compile errors', compileMs, 'error');
    skipStages(['Link boot image']);
    result.compiled = compiled;
    result.elapsedMs = now() - started;
    return result;
  }

  addStage(
    'Compile to bytecode',
    `${compiled.stats.bytecodeBytes} B · ${compiled.stats.methods} methods · ${compiled.stats.globals} globals`,
    compileMs,
    'ok',
  );

  result.buildId = fnv1a(repaired.source + '\u0000' + compiled.stats.bytecodeBytes).toString(16).padStart(8, '0').slice(0, 8);

  const linkStarted = now();
  try {
    const layout = buildImage(compiled);
    result.image = layout.image;
    result.layout = layout;
    result.compiled = compiled;
    stats.kernelBytes = layout.kernelBytes;
    stats.sectorCount = layout.sectorCount;
    addStage(
      'Link boot image',
      `${layout.kernelBytes} B kernel · ${layout.codeBytes} B bytecode · 1.44 MB floppy`,
      now() - linkStarted,
      'ok',
    );
    result.ok = true;
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      message: err instanceof Error ? err.message : 'Image assembly failed',
      hint: 'This is a linker limit, not a C# error.',
    });
    addStage('Link boot image', 'assembly failed', now() - linkStarted, 'error');
    result.compiled = compiled;
  }

  result.elapsedMs = now() - started;
  return result;
}
