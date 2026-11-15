import fs from 'node:fs';
import { assemble } from '../src/core/asm.ts';

const source = `
  mov ax, 0x1000
  mov ds, ax
  mov bx, [si]
  add si, 2
  mov [bx], al
  mov al, [bx]
  mov [bx+2], dx
  mov dx, [bx+2]
  mov word [0x7000], ax
  mov byte [0x7001], 0
  mov word [0x7002], 5
  mov di, 0xb800
  cld
  rep stosw
  cmp ax, bx
  cmp al, 5
  add bx, 4
  sub word [0x7000], 1
  inc word [0x7000]
  dec di
  xor ax, ax
  test dx, dx
  jz 0x7000
  jnz 0x7000
  jmp 0x7000
  call 0x7000
  push ax
  pop bx
  int 0x16
  hlt
  nop
  ret
  neg ax
  not dx
  imul bx
  idiv cx
  cwd
  shl ax, 1
  shr bx, cl
  sar cx, 4
  movsb
  movsw
  stosb
  stosw
  lodsb
  lodsw
  jmp word [bx]
  jmp word [bx+si]
`;

const result = assemble(source, 0x7c00);
fs.mkdirSync('.tmp', { recursive: true });
fs.writeFileSync('.tmp/asmcheck.bin', result.bytes);
console.log(`bytes=${result.bytes.length} labels=${JSON.stringify([...result.labels])}`);
