/**
 * SharpBoot bare-metal runtime kernel.
 *
 * A 16-bit real-mode bytecode interpreter with VGA text and mode 13h graphics, a garbage-collected
 * object heap and BIOS keyboard input. Assembled by src/core/asm.ts and placed at
 * 0x1000:0x0200 by the boot sector.
 *
 * Program header (offsets in the loaded segment at 0x1000):
 *   0x0000 'S' 'B' version flags
 *   0x0004 entry method index
 *   0x0006 method count
 *   0x0008 bytecode start
 *   0x000A bytecode end / static string start
 *   0x000C global count
 *   0x0010 method table: [code offset:word][local count:word]
 */

export const KERNEL_ORIGIN = 0x0200;
export const CODE_START = 0x3000;
export const STRING_START = 0x4800;
export const GLOBAL_START = 0x5800;
export const VM_STACK_TOP = 0x7000;
export const VM_STACK_LOW = 0x6000;
export const HEAP_START = 0x8000;
export const HEAP_LIMIT = 0xf000;
export const MAX_GLOBALS = 512;
export const MAX_CODE_BYTES = STRING_START - CODE_START;
export const MAX_STRING_BYTES = GLOBAL_START - STRING_START;

import { FONT_8X8 } from './graphics.ts';

const FONT_LINES = Array.from({ length: FONT_8X8.length / 16 }, (_, row) =>
  `  db ${FONT_8X8.slice(row * 16, row * 16 + 16).map((byte) => `0x${byte.toString(16).padStart(2, '0')}`).join(',')}`,
).join('\n');

export const KERNEL_SOURCE = String.raw`
; ---------------------------------------------------------------- constants
VGA          equ 0xB800
GLOBAL_BASE  equ 0x5800
STACK_TOP    equ 0x7000
STACK_LOW    equ 0x6000
HEAP_BASE    equ 0x8000
HEAP_MAX     equ 0xF000
HEAP_SIZE    equ 0x7000
GC_ROOTS     equ 7

OP_HALT      equ 0
OP_PUSHI     equ 1
OP_PUSHS     equ 2
OP_LOAD      equ 3
OP_STORE     equ 4
OP_LOADG     equ 5
OP_STOREG    equ 6
OP_ADD       equ 7
OP_SUB       equ 8
OP_MUL       equ 9
OP_DIV       equ 10
OP_MOD       equ 11
OP_NEG       equ 12
OP_EQ        equ 13
OP_NE        equ 14
OP_LT        equ 15
OP_LE        equ 16
OP_GT        equ 17
OP_GE        equ 18
OP_AND       equ 19
OP_OR        equ 20
OP_NOT       equ 21
OP_CONCAT    equ 22
OP_PRINT     equ 23
OP_PRINTLN   equ 24
OP_NEWLINE   equ 25
OP_CLEAR     equ 26
OP_JMP       equ 27
OP_JZ        equ 28
OP_JNZ       equ 29
OP_CALL      equ 30
OP_RET       equ 31
OP_READLINE  equ 32
OP_READKEY   equ 33
OP_TOSTR     equ 34
OP_LEN       equ 35
OP_PARSE     equ 36
OP_DUP       equ 37
OP_POP       equ 38
OP_ABS       equ 39
OP_MIN       equ 40
OP_MAX       equ 41
OP_UPPER     equ 42
OP_LOWER     equ 43
OP_GINIT     equ 44
OP_GEND      equ 45
OP_GCLEAR    equ 46
OP_GPIXEL    equ 47
OP_GFILLRECT equ 48
OP_GRECT     equ 49
OP_GLINE     equ 50
OP_GFILLCIRCLE equ 51
OP_GCIRCLE   equ 52
OP_RGB       equ 53
OP_NEWARR    equ 54
OP_AGET      equ 55
OP_ASET      equ 56
OP_GPALETTE  equ 57
OP_GSPRITE   equ 58
OP_GTEXT     equ 59
OP_COUNT     equ 60

; ---------------------------------------------------------------- entry
start:
  mov ax, 0x1000
  mov ds, ax
  mov ax, VGA
  mov es, ax
  mov ax, 0x9000
  mov ss, ax
  mov sp, 0xFFFE
  cld

  mov word [row], 0
  mov word [col], 0
  mov word [cur_off], 0
  mov byte [cur_attr], 0x0F
  mov di, HEAP_BASE
  mov word [di], HEAP_SIZE
  mov word [di+2], 0
  mov word [vsp], STACK_TOP

  call clear_screen

  ; zero the globals area
  push es
  mov ax, ds
  mov es, ax
  mov di, GLOBAL_BASE
  mov cx, [0x000C]
  shl cx, 1
  xor ax, ax
  rep stosw
  pop es

  mov di, msg_boot
  call print_string

  mov bx, [0x0004]
  shl bx, 1
  shl bx, 1
  add bx, 0x0010
  mov si, [bx]
  mov bp, STACK_TOP
  jmp run

; ---------------------------------------------------------------- dispatch
run:
  cmp si, [0x000A]
  jae fault_code
  mov bl, [si]
  xor bh, bh
  inc si
  cmp bx, OP_COUNT
  jae fault_op
  shl bx, 1
  add bx, jt
  jmp word [bx]

fault_code:
  mov di, msg_code
  jmp fatal
fault_op:
  mov di, msg_op
  jmp fatal
fault_array:
  mov di, msg_arr
  jmp fatal
stack_overflow:
  mov di, msg_stack
  jmp fatal
oom:
  mov di, msg_oom
fatal:
  call warn
halt_now:
  mov byte [cur_attr], 0x08
  mov di, msg_halted
  call print_string
  mov byte [cur_attr], 0x0F
halt_loop:
  cli
  hlt
  jmp halt_loop

; ---------------------------------------------------------------- stack helpers
; push AL=type, DX=value
push_val:
  mov bx, [vsp]
  sub bx, 4
  mov [vsp], bx
  mov [bx], al
  mov byte [bx+1], 0
  mov [bx+2], dx
  ret

; pop -> AL=type, DX=value
pop_val:
  mov bx, [vsp]
  mov al, [bx]
  mov dx, [bx+2]
  add word [vsp], 4
  ret

; ---------------------------------------------------------------- console
clear_screen:
  mov di, 0
  mov cx, 2000
  mov ax, 0x0F20
  cld
  rep stosw
  mov word [row], 0
  mov word [col], 0
  mov word [cur_off], 0
  call set_cursor
  ret

scroll:
  push si
  push ds
  mov ax, es
  mov ds, ax
  mov si, 160
  xor di, di
  mov cx, 1920
  cld
  rep movsw
  pop ds
  pop si
  mov di, 3840
  mov cx, 80
  mov ax, 0x0F20
  rep stosw
  ret

set_cursor:
  push ax
  push bx
  push dx
  mov ah, 2
  xor bh, bh
  mov dh, [row]
  mov dl, [col]
  int 0x10
  pop dx
  pop bx
  pop ax
  ret

recompute_off:
  mov ax, [row]
  mov bx, ax
  shl ax, 1
  shl ax, 1
  shl ax, 1
  shl ax, 1
  shl ax, 1
  shl ax, 1
  shl ax, 1
  shl bx, 1
  shl bx, 1
  shl bx, 1
  shl bx, 1
  shl bx, 1
  add ax, bx
  mov [cur_off], ax
  ret

newline:
  mov word [col], 0
  inc word [row]
  cmp word [row], 25
  jb newline_ok
  call scroll
  mov word [row], 24
newline_ok:
  call recompute_off
  call set_cursor
  ret

; print AL through the console
putchar:
  cmp byte [gfx_on], 0
  jne putchar_gfx
  cmp al, 10
  je putchar_lf
  cmp al, 13
  je putchar_cr
  cmp al, 8
  je putchar_bs
  mov di, [cur_off]
  stosb
  push ax
  mov al, [cur_attr]
  stosb
  pop ax
  add word [cur_off], 2
  inc word [col]
  cmp word [col], 80
  jb putchar_cursor
  mov word [col], 0
  inc word [row]
  cmp word [row], 25
  jb putchar_cursor
  call scroll
  mov word [row], 24
  mov word [cur_off], 3840
  jmp putchar_cursor
putchar_lf:
  call newline
  ret
putchar_cr:
  mov word [col], 0
  call recompute_off
  call set_cursor
  ret
putchar_bs:
  cmp word [col], 0
  je putchar_cursor
  dec word [col]
  sub word [cur_off], 2
  mov di, [cur_off]
  mov al, ' '
  stosb
  push ax
  mov al, [cur_attr]
  stosb
  pop ax
putchar_cursor:
  call set_cursor
  ret
putchar_gfx:
  ret

print_string:
  mov [ps_ptr], di
  mov cx, [di]
  add word [ps_ptr], 2
print_string_loop:
  test cx, cx
  jz print_string_done
  mov di, [ps_ptr]
  mov al, [di]
  call putchar
  inc word [ps_ptr]
  dec cx
  jmp print_string_loop
print_string_done:
  ret

warn:
  push di
  mov byte [cur_attr], 0x0E
  call print_string
  mov byte [cur_attr], 0x0F
  pop di
  ret

print_value:
  cmp al, 1
  je print_value_str
  cmp al, 2
  je print_value_bool
  mov [pv_val], dx
  call itoa
  call print_string
  ret
print_value_str:
  mov di, dx
  call print_string
  ret
print_value_bool:
  test dx, dx
  jz print_value_false
  mov di, msg_true
  call print_string
  ret
print_value_false:
  mov di, msg_false
  call print_string
  ret

; AX -> DI (length-prefixed scratch string at numstr)
itoa:
  mov ax, [pv_val]
  xor cx, cx
  test ax, ax
  jns itoa_positive
  mov cx, 1
  neg ax
itoa_positive:
  mov di, numbuf_end
  mov word [numlen], 0
  test ax, ax
  jnz itoa_digits
  dec di
  mov byte [di], '0'
  inc word [numlen]
  jmp itoa_sign
itoa_digits:
  mov bx, 10
itoa_div:
  xor dx, dx
  div bx
  add dl, '0'
  dec di
  mov [di], dl
  inc word [numlen]
  test ax, ax
  jnz itoa_div
itoa_sign:
  test cx, cx
  jz itoa_copy
  dec di
  mov byte [di], '-'
  inc word [numlen]
itoa_copy:
  mov cx, [numlen]
  mov [numstr], cx
  mov bx, numstr+2
  test cx, cx
  jz itoa_done
itoa_copy_loop:
  mov al, [di]
  mov [bx], al
  inc di
  inc bx
  dec cx
  jnz itoa_copy_loop
itoa_done:
  mov di, numstr
  ret

; ---------------------------------------------------------------- heap / strings
; CX bytes -> DI. Blocks carry a 4-byte header: size, type, mark.
; Type 0 is free, type 1 is a string and type 3 is an array.
alloc:
  push ax
  push bx
  push cx
  push dx
  push si
  push bp
  mov byte [gc_retry], 0
  mov ax, cx
  add ax, 4
  jc alloc_fail
  add ax, 1
  and ax, 0xFFFE
  jc alloc_fail
  mov cx, ax
alloc_scan:
  mov di, HEAP_BASE
alloc_walk:
  cmp di, HEAP_MAX
  jae alloc_full
  mov bx, [di]
  test bx, bx
  jz alloc_full
  cmp byte [di+2], 0
  jne alloc_next
  cmp bx, cx
  jb alloc_next
  mov ax, bx
  sub ax, cx
  cmp ax, 8
  jb alloc_take
  mov [di], cx
  mov bx, di
  add bx, cx
  mov [bx], ax
  mov word [bx+2], 0
alloc_take:
  mov word [di+2], 1
  add di, 4
  pop bp
  pop si
  pop dx
  pop cx
  pop bx
  pop ax
  ret
alloc_next:
  add di, bx
  jmp alloc_walk
alloc_full:
  cmp byte [gc_retry], 0
  jne alloc_fail
  mov byte [gc_retry], 1
  call gc_collect
  jmp alloc_scan
alloc_fail:
  pop bp
  pop si
  pop dx
  pop cx
  pop bx
  pop ax
  jmp oom

; ---------------------------------------------------------------- garbage collector
; Conservative mark/sweep. Roots are globals, the value stack (including the
; Main locals at 0x7000-0x7fff) and a few string temporaries used by routines
; that allocate while their operands are out of the VM stack.
gc_collect:
  push ax
  push bx
  push cx
  push dx
  push si
  push di
  push bp

  mov di, HEAP_BASE
gc_clear:
  cmp di, HEAP_MAX
  jae gc_mark
  mov ax, [di]
  test ax, ax
  jz gc_mark
  mov byte [di+3], 0
  cmp byte [di+2], 0
  jne gc_clear_next
gc_clear_merge:
  mov bx, di
  add bx, ax
  cmp bx, HEAP_MAX
  jae gc_clear_next
  cmp byte [bx+2], 0
  jne gc_clear_next
  add ax, [bx]
  mov [di], ax
  jmp gc_clear_merge
gc_clear_next:
  add di, ax
  jmp gc_clear

gc_mark:
  mov cx, [0x000C]
  mov di, GLOBAL_BASE
gc_mark_globals:
  test cx, cx
  jz gc_mark_stack
  push cx
  push di
  mov al, [di]
  mov dx, [di+2]
  call gc_mark_val
  pop di
  pop cx
  add di, 4
  dec cx
  jmp gc_mark_globals

gc_mark_stack:
  mov di, [vsp]
gc_mark_stack_loop:
  cmp di, HEAP_BASE
  jae gc_mark_temps
  push di
  mov al, [di]
  mov dx, [di+2]
  call gc_mark_val
  pop di
  add di, 4
  jmp gc_mark_stack_loop

gc_mark_temps:
  mov di, gc_roots
  mov cx, GC_ROOTS
gc_mark_temps_loop:
  test cx, cx
  jz gc_sweep
  push cx
  push di
  mov dx, [di]
  call gc_mark_ptr
  pop di
  pop cx
  add di, 2
  dec cx
  jmp gc_mark_temps_loop

gc_sweep:
  mov di, HEAP_BASE
gc_sweep_loop:
  cmp di, HEAP_MAX
  jae gc_done
  mov ax, [di]
  test ax, ax
  jz gc_done
  cmp byte [di+2], 0
  je gc_sweep_free
  cmp byte [di+3], 0
  jne gc_sweep_next
  mov byte [di+2], 0
gc_sweep_free:
  mov bx, di
  add bx, ax
  cmp bx, HEAP_MAX
  jae gc_sweep_next
  cmp byte [bx+2], 0
  jne gc_sweep_next
  add ax, [bx]
  mov [di], ax
  jmp gc_sweep_free
gc_sweep_next:
  add di, ax
  jmp gc_sweep_loop

gc_done:
  pop bp
  pop di
  pop si
  pop dx
  pop cx
  pop bx
  pop ax
  ret

gc_mark_val:
  cmp al, 1
  je gc_mark_val_ptr
  cmp al, 3
  jne gc_mark_val_ret
gc_mark_val_ptr:
  call gc_mark_ptr
gc_mark_val_ret:
  ret

; DX = payload pointer
gc_mark_ptr:
  cmp dx, HEAP_BASE
  jbe gc_mark_ptr_ret
  cmp dx, HEAP_MAX
  jae gc_mark_ptr_ret
  push bx
  mov bx, dx
  sub bx, 4
  mov al, [bx+2]
  test al, al
  jz gc_mark_ptr_ret_pop
  cmp al, 1
  je gc_mark_ptr_obj
  cmp al, 3
  jne gc_mark_ptr_ret_pop
gc_mark_ptr_obj:
  cmp byte [bx+3], 0
  jne gc_mark_ptr_ret_pop
  mov byte [bx+3], 1
  cmp al, 3
  jne gc_mark_ptr_ret_pop
  mov cx, [bx+4]
  test cx, cx
  jz gc_mark_ptr_ret_pop
  add bx, 6
gc_mark_array_loop:
  cmp byte [bx], 1
  jne gc_mark_array_next
  push cx
  mov dx, [bx+2]
  call gc_mark_ptr
  pop cx
gc_mark_array_next:
  add bx, 4
  dec cx
  jnz gc_mark_array_loop
gc_mark_ptr_ret_pop:
  pop bx
gc_mark_ptr_ret:
  ret

str_len:
  mov cx, [di]
  ret

; DI=dest, BX=source string, copies characters only
copy_chars:
  mov cx, [bx]
  add bx, 2
  test cx, cx
  jz copy_chars_done
copy_chars_loop:
  mov al, [bx]
  mov [di], al
  inc bx
  inc di
  dec cx
  jnz copy_chars_loop
copy_chars_done:
  ret

; DI, BX -> AL=1 if equal
streq:
  mov cx, [di]
  cmp cx, [bx]
  jne streq_no
  add di, 2
  add bx, 2
  test cx, cx
  jz streq_yes
streq_loop:
  mov al, [di]
  cmp al, [bx]
  jne streq_no
  inc di
  inc bx
  dec cx
  jnz streq_loop
streq_yes:
  mov al, 1
  ret
streq_no:
  xor al, al
  ret

make_string_a:
  cmp byte [a_type], 1
  je make_string_a_done
  mov al, [a_type]
  mov dx, [a_val]
  call tostr
  mov [a_val], dx
  mov byte [a_type], 1
make_string_a_done:
  ret

make_string_b:
  cmp byte [b_type], 1
  je make_string_b_done
  mov al, [b_type]
  mov dx, [b_val]
  call tostr
  mov [b_val], dx
  mov byte [b_type], 1
make_string_b_done:
  ret

; AL type, DX value -> AL=1, DX=string pointer
tostr:
  cmp al, 1
  je tostr_done
  cmp al, 2
  je tostr_bool
  mov [pv_val], dx
  call itoa
  mov [tmp_ptr], di
  mov cx, [di]
  add cx, 2
  call alloc
  mov [tmp_dst], di
  mov bx, [tmp_ptr]
  mov cx, [bx]
  mov [di], cx
  add di, 2
  call copy_chars
  mov al, 1
  mov dx, [tmp_dst]
  ret
tostr_bool:
  test dx, dx
  jz tostr_false
  mov dx, msg_true
  mov al, 1
  ret
tostr_false:
  mov dx, msg_false
  mov al, 1
  ret
tostr_done:
  ret

; AL=lhs type, DX=lhs value, CL=rhs type, DI=rhs value -> pushes concatenated string
concat_vals:
  mov [a_type], al
  mov [a_val], dx
  mov [b_type], cl
  mov [b_val], di
  call make_string_a
  call make_string_b
  mov di, [a_val]
  call str_len
  mov [a_len], cx
  mov di, [b_val]
  call str_len
  mov ax, [a_len]
  add ax, cx
  mov [tmp_len], ax
  add ax, 2
  mov cx, ax
  call alloc
  mov [c_val], di
  mov cx, [tmp_len]
  mov [di], cx
  add di, 2
  mov bx, [a_val]
  call copy_chars
  mov bx, [b_val]
  call copy_chars
  mov al, 1
  mov dx, [c_val]
  call push_val
  ret

; DI string -> AX value
parse_int:
  mov bx, [di]
  add di, 2
  xor ax, ax
  xor cx, cx
  mov byte [had_digit], 0
parse_skip:
  test bx, bx
  jz parse_finish
  mov dl, [di]
  cmp dl, ' '
  jne parse_sign
  inc di
  dec bx
  jmp parse_skip
parse_sign:
  cmp dl, '+'
  je parse_plus
  cmp dl, '-'
  jne parse_digits
  mov cx, 1
parse_plus:
  inc di
  dec bx
parse_digits:
  test bx, bx
  jz parse_finish
  mov dl, [di]
  cmp dl, '0'
  jb parse_finish
  cmp dl, '9'
  ja parse_finish
  sub dl, '0'
  mov [tmp_byte], dl
  mov dx, 10
  imul dx
  mov dl, [tmp_byte]
  xor dh, dh
  add ax, dx
  mov byte [had_digit], 1
  inc di
  dec bx
  jmp parse_digits
parse_finish:
  cmp byte [had_digit], 0
  jne parse_sign_apply
  mov di, msg_parse
  call warn
  xor ax, ax
  ret
parse_sign_apply:
  test cx, cx
  jz parse_done
  neg ax
parse_done:
  ret

; ---------------------------------------------------------------- input
read_line:
  mov word [in_len], 0
read_line_key:
  xor ax, ax
  int 0x16
  cmp al, 13
  je read_line_done
  cmp al, 27
  je read_line_esc
  cmp al, 8
  je read_line_back
  cmp al, 32
  jb read_line_key
  cmp al, 126
  ja read_line_key
  mov bx, [in_len]
  cmp bx, 120
  jae read_line_key
  mov [inbuf+bx], al
  inc word [in_len]
  call putchar
  jmp read_line_key
read_line_back:
  cmp word [in_len], 0
  je read_line_key
  dec word [in_len]
  mov al, 8
  call putchar
  jmp read_line_key
read_line_esc:
  mov di, msg_esc
  call warn
  jmp halt_now
read_line_done:
  call newline
  mov cx, [in_len]
  add cx, 2
  call alloc
  mov [in_ptr], di
  mov cx, [in_len]
  mov [di], cx
  add di, 2
  mov bx, inbuf
  mov cx, [in_len]
  test cx, cx
  jz read_line_push
  cld
read_line_copy:
  mov al, [bx]
  mov [di], al
  inc bx
  inc di
  dec cx
  jnz read_line_copy
read_line_push:
  mov al, 1
  mov dx, [in_ptr]
  call push_val
  ret

read_key:
  xor ax, ax
  int 0x16
  mov [tmp_byte], al
  cmp al, 32
  jb read_key_noecho
  cmp al, 126
  ja read_key_noecho
  call putchar
read_key_noecho:
  mov al, [tmp_byte]
  xor ah, ah
  mov dx, ax
  xor al, al
  call push_val
  ret

; ---------------------------------------------------------------- opcodes
op_halt:
  jmp halt_now

op_pushi:
  mov dx, [si]
  add si, 2
  xor al, al
  call push_val
  jmp run

op_pushs:
  mov dx, [si]
  add si, 2
  mov al, 1
  call push_val
  jmp run

op_load:
  mov bx, [si]
  add si, 2
  shl bx, 1
  shl bx, 1
  add bx, bp
  mov al, [bx]
  mov dx, [bx+2]
  call push_val
  jmp run

op_store:
  call pop_val
  mov bx, [si]
  add si, 2
  shl bx, 1
  shl bx, 1
  add bx, bp
  mov [bx], al
  mov [bx+2], dx
  jmp run

op_loadg:
  mov bx, [si]
  add si, 2
  shl bx, 1
  shl bx, 1
  add bx, GLOBAL_BASE
  mov al, [bx]
  mov dx, [bx+2]
  call push_val
  jmp run

op_storeg:
  call pop_val
  mov bx, [si]
  add si, 2
  shl bx, 1
  shl bx, 1
  add bx, GLOBAL_BASE
  mov [bx], al
  mov [bx+2], dx
  jmp run

op_dup:
  call pop_val
  call push_val
  call push_val
  jmp run

op_pop:
  call pop_val
  jmp run

op_add:
  call pop_val
  mov cl, al
  mov di, dx
  call pop_val
  cmp al, 1
  je op_add_concat
  cmp cl, 1
  je op_add_concat
  add dx, di
  xor al, al
  call push_val
  jmp run
op_add_concat:
  call concat_vals
  jmp run

op_sub:
  call pop_val
  mov di, dx
  call pop_val
  sub dx, di
  xor al, al
  call push_val
  jmp run

op_mul:
  call pop_val
  mov di, dx
  call pop_val
  mov ax, dx
  imul di
  mov dx, ax
  xor al, al
  call push_val
  jmp run

op_div:
  call pop_val
  mov di, dx
  call pop_val
  test di, di
  jz op_div_zero
  mov ax, dx
  cwd
  idiv di
  mov dx, ax
  xor al, al
  call push_val
  jmp run
op_div_zero:
  mov di, msg_div0
  call warn
  xor dx, dx
  xor al, al
  call push_val
  jmp run

op_mod:
  call pop_val
  mov di, dx
  call pop_val
  test di, di
  jz op_mod_zero
  mov ax, dx
  cwd
  idiv di
  xor al, al
  call push_val
  jmp run
op_mod_zero:
  mov di, msg_mod0
  call warn
  xor dx, dx
  xor al, al
  call push_val
  jmp run

op_neg:
  call pop_val
  neg dx
  xor al, al
  call push_val
  jmp run

op_eq:
  call pop_val
  mov cl, al
  mov di, dx
  call pop_val
  cmp al, 1
  je op_eq_strings
  cmp cl, 1
  je op_eq_strings
  cmp dx, di
  jne op_eq_false
  mov dx, 1
  jmp op_eq_push
op_eq_false:
  xor dx, dx
op_eq_push:
  mov al, 2
  call push_val
  jmp run
op_eq_strings:
  mov [a_type], al
  mov [a_val], dx
  mov [b_type], cl
  mov [b_val], di
  call make_string_a
  call make_string_b
  mov di, [a_val]
  mov bx, [b_val]
  call streq
  mov dl, al
  xor dh, dh
  mov al, 2
  call push_val
  jmp run

op_ne:
  call pop_val
  mov cl, al
  mov di, dx
  call pop_val
  cmp al, 1
  je op_ne_strings
  cmp cl, 1
  je op_ne_strings
  cmp dx, di
  je op_ne_false
  mov dx, 1
  jmp op_ne_push
op_ne_false:
  xor dx, dx
op_ne_push:
  mov al, 2
  call push_val
  jmp run
op_ne_strings:
  mov [a_type], al
  mov [a_val], dx
  mov [b_type], cl
  mov [b_val], di
  call make_string_a
  call make_string_b
  mov di, [a_val]
  mov bx, [b_val]
  call streq
  xor al, 1
  mov dl, al
  xor dh, dh
  mov al, 2
  call push_val
  jmp run

op_lt:
  call pop_val
  mov cl, al
  mov di, dx
  call pop_val
  cmp al, 1
  je op_cmp_strings
  cmp cl, 1
  je op_cmp_strings
  cmp dx, di
  jl op_cmp_true
  jmp op_cmp_false
op_le:
  call pop_val
  mov cl, al
  mov di, dx
  call pop_val
  cmp al, 1
  je op_cmp_strings
  cmp cl, 1
  je op_cmp_strings
  cmp dx, di
  jle op_cmp_true
  jmp op_cmp_false
op_gt:
  call pop_val
  mov cl, al
  mov di, dx
  call pop_val
  cmp al, 1
  je op_cmp_strings
  cmp cl, 1
  je op_cmp_strings
  cmp dx, di
  jg op_cmp_true
  jmp op_cmp_false
op_ge:
  call pop_val
  mov cl, al
  mov di, dx
  call pop_val
  cmp al, 1
  je op_cmp_strings
  cmp cl, 1
  je op_cmp_strings
  cmp dx, di
  jge op_cmp_true
  jmp op_cmp_false
op_cmp_strings:
  mov di, msg_strord
  call warn
op_cmp_false:
  xor dx, dx
  jmp op_cmp_push
op_cmp_true:
  mov dx, 1
op_cmp_push:
  mov al, 2
  call push_val
  jmp run

op_and:
  call pop_val
  mov di, dx
  call pop_val
  test dx, dx
  jz op_cmp_false
  test di, di
  jz op_cmp_false
  jmp op_cmp_true

op_or:
  call pop_val
  mov di, dx
  call pop_val
  test dx, dx
  jnz op_cmp_true
  test di, di
  jnz op_cmp_true
  jmp op_cmp_false

op_not:
  call pop_val
  test dx, dx
  jz op_cmp_true
  jmp op_cmp_false

op_concat:
  call pop_val
  mov cl, al
  mov di, dx
  call pop_val
  call concat_vals
  jmp run

op_print:
  call pop_val
  call print_value
  jmp run

op_println:
  call pop_val
  call print_value
  call newline
  jmp run

op_newline:
  call newline
  jmp run

op_clear:
  call clear_screen
  jmp run

op_jmp:
  mov bx, [si]
  mov si, bx
  jmp run

op_jz:
  mov di, [si]
  add si, 2
  call pop_val
  test dx, dx
  jz op_jz_take
  jmp run
op_jz_take:
  mov si, di
  jmp run

op_jnz:
  mov di, [si]
  add si, 2
  call pop_val
  test dx, dx
  jnz op_jnz_take
  jmp run
op_jnz_take:
  mov si, di
  jmp run

op_call:
  mov bx, [si]
  add si, 2
  mov ax, [si]
  add si, 2
  mov [argc], ax
  shl bx, 1
  shl bx, 1
  add bx, 0x0010
  mov dx, [bx]
  mov [new_ip], dx
  mov cx, [bx+2]
  mov [callee_locals], cx

  mov bx, [vsp]
  mov ax, [callee_locals]
  shl ax, 1
  shl ax, 1
  sub bx, ax
  mov [new_frame], bx
  cmp bx, STACK_LOW
  jb stack_overflow

  mov di, bx
  mov bx, [vsp]
  mov cx, [argc]
  test cx, cx
  jz op_call_zero
op_call_copy:
  mov ax, [bx]
  mov [di], ax
  mov ax, [bx+2]
  mov [di+2], ax
  add bx, 4
  add di, 4
  dec cx
  jnz op_call_copy
op_call_zero:
  mov cx, [callee_locals]
  sub cx, [argc]
  jbe op_call_saved
op_call_zero_loop:
  mov word [di], 0
  mov word [di+2], 0
  add di, 4
  dec cx
  jnz op_call_zero_loop
op_call_saved:
  mov bx, [callee_locals]
  add bx, [argc]
  shl bx, 1
  shl bx, 1
  add bx, [new_frame]
  push si
  push bp
  push bx
  mov bp, [new_frame]
  mov [vsp], bp
  mov si, [new_ip]
  jmp run

op_ret:
  call pop_val
  mov [ret_type], al
  mov [ret_val], dx
  pop di
  pop bp
  pop si
  mov [vsp], di
  mov al, [ret_type]
  mov dx, [ret_val]
  call push_val
  jmp run

op_readline:
  call read_line
  jmp run

op_readkey:
  call read_key
  jmp run

op_tostr:
  call pop_val
  call tostr
  call push_val
  jmp run

op_len:
  call pop_val
  cmp al, 1
  je op_len_ok
  cmp al, 3
  jne op_len_bad
op_len_ok:
  mov di, dx
  call str_len
  mov dx, cx
  xor al, al
  call push_val
  jmp run
op_len_bad:
  mov di, msg_type
  call warn
  xor dx, dx
  xor al, al
  call push_val
  jmp run

op_parse:
  call pop_val
  cmp al, 1
  jne op_parse_zero
  mov di, dx
  call parse_int
  mov dx, ax
  xor al, al
  call push_val
  jmp run
op_parse_zero:
  mov di, msg_parse
  call warn
  xor dx, dx
  xor al, al
  call push_val
  jmp run

op_abs:
  call pop_val
  test dx, dx
  jns op_abs_push
  neg dx
op_abs_push:
  xor al, al
  call push_val
  jmp run

op_min:
  call pop_val
  mov di, dx
  call pop_val
  cmp dx, di
  jle op_min_push
  mov dx, di
op_min_push:
  xor al, al
  call push_val
  jmp run

op_max:
  call pop_val
  mov di, dx
  call pop_val
  cmp dx, di
  jge op_max_push
  mov dx, di
op_max_push:
  xor al, al
  call push_val
  jmp run

op_upper:
  mov byte [case_mode], 0
  jmp case_entry
op_lower:
  mov byte [case_mode], 1
case_entry:
  call pop_val
  cmp al, 1
  jne case_bad
  mov [a_val], dx
  mov di, dx
  call str_len
  mov [tmp_len], cx
  add cx, 2
  call alloc
  mov [c_val], di
  mov ax, [tmp_len]
  mov [di], ax
  add di, 2
  mov bx, [a_val]
  add bx, 2
  mov cx, [tmp_len]
  test cx, cx
  jz case_done
case_loop:
  mov al, [bx]
  cmp byte [case_mode], 0
  jne case_lower_char
  cmp al, 'a'
  jb case_store
  cmp al, 'z'
  ja case_store
  sub al, 32
  jmp case_store
case_lower_char:
  cmp al, 'A'
  jb case_store
  cmp al, 'Z'
  ja case_store
  add al, 32
case_store:
  mov [di], al
  inc bx
  inc di
  dec cx
  jnz case_loop
case_done:
  mov al, 1
  mov dx, [c_val]
  call push_val
  jmp run
case_bad:
  mov di, msg_type
  call warn
  mov al, 1
  mov dx, msg_empty
  call push_val
  jmp run

; ---------------------------------------------------------------- graphics
; Mode 13h, 320x200, packed 3-3-2 palette. The framebuffer is A000:0000.

gfx_init:
  push ax
  push bx
  push cx
  push dx
  push si
  mov ax, 0x0013
  int 0x10
  mov ax, 0xA000
  mov es, ax
  mov byte [gfx_on], 1
  call gfx_palette
  xor al, al
  call gfx_clear_raw
  pop si
  pop dx
  pop cx
  pop bx
  pop ax
  ret

gfx_palette:
  push ax
  push bx
  push cx
  push dx
  push si
  mov word [gfx_pal_i], 0
gfx_pal_loop:
  mov si, [gfx_pal_i]
  mov ax, si
  shr ax, 1
  shr ax, 1
  shr ax, 1
  shr ax, 1
  shr ax, 1
  mov cx, 9
  mul cx
  mov [gfx_r], al
  mov ax, si
  shr ax, 1
  shr ax, 1
  and ax, 7
  mov cx, 9
  mul cx
  mov [gfx_g], al
  mov ax, si
  and ax, 3
  mov cx, 21
  mul cx
  mov [gfx_b], al
  mov bx, si
  mov dh, [gfx_r]
  mov ch, [gfx_g]
  mov cl, [gfx_b]
  mov ax, 0x1010
  int 0x10
  inc word [gfx_pal_i]
  cmp word [gfx_pal_i], 256
  jb gfx_pal_loop
  pop si
  pop dx
  pop cx
  pop bx
  pop ax
  ret

ensure_gfx:
  cmp byte [gfx_on], 0
  jne ensure_gfx_done
  call gfx_init
ensure_gfx_done:
  ret

gfx_clear_raw:
  push cx
  push di
  xor di, di
  mov cx, 64000
  cld
  rep stosb
  pop di
  pop cx
  ret

gfx_end:
  cmp byte [gfx_on], 0
  je gfx_end_done
  mov byte [gfx_on], 0
  mov ax, 0x0003
  int 0x10
  mov ax, VGA
  mov es, ax
  call clear_screen
  mov byte [cur_attr], 0x0F
gfx_end_done:
  ret

; AX=x, BX=y, CL=color
gfx_setpixel:
  cmp ax, 0
  jl gfx_sp_ret
  cmp ax, 320
  jge gfx_sp_ret
  cmp bx, 0
  jl gfx_sp_ret
  cmp bx, 200
  jge gfx_sp_ret
  push ax
  push bx
  push cx
  push dx
  push di
  push ax
  mov ax, bx
  mov dx, 320
  mul dx
  mov di, ax
  pop ax
  add di, ax
  mov al, cl
  stosb
  pop di
  pop dx
  pop cx
  pop bx
  pop ax
gfx_sp_ret:
  ret

; AX=x, BX=y, CX=w, DL=color
gfx_hline:
  test cx, cx
  jle gfx_hl_ret
  cmp bx, 0
  jl gfx_hl_ret
  cmp bx, 200
  jge gfx_hl_ret
  cmp ax, 0
  jge gfx_hl_xok
  add cx, ax
  test cx, cx
  jle gfx_hl_ret
  xor ax, ax
gfx_hl_xok:
  cmp ax, 320
  jge gfx_hl_ret
  add cx, ax
  cmp cx, 320
  jle gfx_hl_wok
  mov cx, 320
gfx_hl_wok:
  sub cx, ax
  push ax
  push bx
  push dx
  push di
  push ax
  mov di, bx
  shl di, 1
  shl di, 1
  add di, bx
  shl di, 1
  shl di, 1
  shl di, 1
  shl di, 1
  shl di, 1
  shl di, 1
  pop ax
  add di, ax
  mov al, dl
  rep stosb
  pop di
  pop dx
  pop bx
  pop ax
gfx_hl_ret:
  ret

; AX=x, BX=y, CX=h, DL=color
gfx_vline:
  test cx, cx
  jle gfx_vl_ret
  cmp ax, 0
  jl gfx_vl_ret
  cmp ax, 320
  jge gfx_vl_ret
  cmp bx, 0
  jge gfx_vl_yok
  add cx, bx
  test cx, cx
  jle gfx_vl_ret
  xor bx, bx
gfx_vl_yok:
  cmp bx, 200
  jge gfx_vl_ret
  add cx, bx
  cmp cx, 200
  jle gfx_vl_hok
  mov cx, 200
gfx_vl_hok:
  sub cx, bx
  push ax
  push bx
  push dx
  push di
  push ax
  mov di, bx
  shl di, 1
  shl di, 1
  add di, bx
  shl di, 1
  shl di, 1
  shl di, 1
  shl di, 1
  shl di, 1
  shl di, 1
  pop ax
  add di, ax
  mov al, dl
gfx_vl_loop:
  stosb
  add di, 319
  dec cx
  jnz gfx_vl_loop
  pop di
  pop dx
  pop bx
  pop ax
gfx_vl_ret:
  ret

; uses gfx_x, gfx_y, gfx_w, gfx_h, gfx_c
gfx_fill_rect:
  mov ax, [gfx_h]
  test ax, ax
  jle gfx_fr_ret
  mov ax, [gfx_y]
  test ax, ax
  jns gfx_fr_yok
  add [gfx_h], ax
  mov word [gfx_y], 0
gfx_fr_yok:
  mov ax, [gfx_h]
  test ax, ax
  jle gfx_fr_ret
  mov ax, [gfx_y]
  cmp ax, 200
  jge gfx_fr_ret
  mov bx, [gfx_h]
  add bx, ax
  cmp bx, 200
  jbe gfx_fr_loop
  mov bx, 200
  sub bx, ax
  mov [gfx_h], bx
gfx_fr_loop:
  mov ax, [gfx_x]
  mov bx, [gfx_y]
  mov cx, [gfx_w]
  mov dl, [gfx_c]
  call gfx_hline
  inc word [gfx_y]
  dec word [gfx_h]
  jnz gfx_fr_loop
gfx_fr_ret:
  ret

; uses gfx_x, gfx_y, gfx_w, gfx_h, gfx_c
gfx_rect:
  cmp word [gfx_w], 0
  jle gfx_rect_ret
  cmp word [gfx_h], 0
  jle gfx_rect_ret
  mov ax, [gfx_x]
  mov bx, [gfx_y]
  mov cx, [gfx_w]
  mov dl, [gfx_c]
  call gfx_hline
  mov ax, [gfx_x]
  mov bx, [gfx_y]
  add bx, [gfx_h]
  dec bx
  mov cx, [gfx_w]
  mov dl, [gfx_c]
  call gfx_hline
  mov ax, [gfx_x]
  mov bx, [gfx_y]
  mov cx, [gfx_h]
  mov dl, [gfx_c]
  call gfx_vline
  mov ax, [gfx_x]
  add ax, [gfx_w]
  dec ax
  mov bx, [gfx_y]
  mov cx, [gfx_h]
  mov dl, [gfx_c]
  call gfx_vline
gfx_rect_ret:
  ret

; uses gfx_x1, gfx_y1, gfx_x2, gfx_y2, gfx_c
gfx_line:
  mov ax, [gfx_x2]
  sub ax, [gfx_x1]
  mov [gfx_dx], ax
  mov ax, 1
  mov [gfx_sx], ax
  mov ax, [gfx_x2]
  sub ax, [gfx_x1]
  test ax, ax
  jns gfx_line_dxok
  neg ax
  mov word [gfx_sx], -1
gfx_line_dxok:
  mov [gfx_dx], ax
  mov ax, [gfx_y2]
  sub ax, [gfx_y1]
  mov [gfx_dy], ax
  mov ax, 1
  mov [gfx_sy], ax
  mov ax, [gfx_y2]
  sub ax, [gfx_y1]
  test ax, ax
  jns gfx_line_dyok
  neg ax
  mov word [gfx_sy], -1
gfx_line_dyok:
  neg ax
  mov [gfx_dy], ax
  mov ax, [gfx_dx]
  add ax, [gfx_dy]
  mov [gfx_err], ax
gfx_line_loop:
  mov ax, [gfx_x1]
  mov bx, [gfx_y1]
  mov cl, [gfx_c]
  call gfx_setpixel
  mov ax, [gfx_x1]
  cmp ax, [gfx_x2]
  jne gfx_line_step
  mov ax, [gfx_y1]
  cmp ax, [gfx_y2]
  je gfx_line_ret
gfx_line_step:
  mov ax, [gfx_err]
  shl ax, 1
  mov [gfx_e2], ax
  mov bx, [gfx_dy]
  cmp ax, bx
  jl gfx_line_skipx
  mov ax, [gfx_err]
  add ax, [gfx_dy]
  mov [gfx_err], ax
  mov ax, [gfx_sx]
  add [gfx_x1], ax
gfx_line_skipx:
  mov ax, [gfx_e2]
  mov bx, [gfx_dx]
  cmp ax, bx
  jg gfx_line_skipy
  mov ax, [gfx_err]
  add ax, [gfx_dx]
  mov [gfx_err], ax
  mov ax, [gfx_sy]
  add [gfx_y1], ax
gfx_line_skipy:
  jmp gfx_line_loop
gfx_line_ret:
  ret

; uses gfx_x, gfx_y, gfx_cx, gfx_cy, gfx_c
gfx_plot8:
  mov ax, [gfx_cx]
  add ax, [gfx_x]
  mov bx, [gfx_cy]
  add bx, [gfx_y]
  mov cl, [gfx_c]
  call gfx_setpixel
  mov ax, [gfx_cx]
  add ax, [gfx_x]
  mov bx, [gfx_cy]
  sub bx, [gfx_y]
  mov cl, [gfx_c]
  call gfx_setpixel
  mov ax, [gfx_cx]
  sub ax, [gfx_x]
  mov bx, [gfx_cy]
  add bx, [gfx_y]
  mov cl, [gfx_c]
  call gfx_setpixel
  mov ax, [gfx_cx]
  sub ax, [gfx_x]
  mov bx, [gfx_cy]
  sub bx, [gfx_y]
  mov cl, [gfx_c]
  call gfx_setpixel
  mov ax, [gfx_cx]
  add ax, [gfx_y]
  mov bx, [gfx_cy]
  add bx, [gfx_x]
  mov cl, [gfx_c]
  call gfx_setpixel
  mov ax, [gfx_cx]
  add ax, [gfx_y]
  mov bx, [gfx_cy]
  sub bx, [gfx_x]
  mov cl, [gfx_c]
  call gfx_setpixel
  mov ax, [gfx_cx]
  sub ax, [gfx_y]
  mov bx, [gfx_cy]
  add bx, [gfx_x]
  mov cl, [gfx_c]
  call gfx_setpixel
  mov ax, [gfx_cx]
  sub ax, [gfx_y]
  mov bx, [gfx_cy]
  sub bx, [gfx_x]
  mov cl, [gfx_c]
  call gfx_setpixel
  ret

; uses gfx_cx, gfx_cy, gfx_r2, gfx_c
gfx_circle:
  cmp word [gfx_r2], 0
  jl gfx_circle_ret
  mov ax, [gfx_r2]
  mov [gfx_x], ax
  mov word [gfx_y], 0
  mov ax, 1
  sub ax, [gfx_r2]
  mov [gfx_err], ax
gfx_circle_loop:
  mov ax, [gfx_x]
  cmp ax, [gfx_y]
  jl gfx_circle_ret
  call gfx_plot8
  inc word [gfx_y]
  mov ax, [gfx_err]
  test ax, ax
  jns gfx_circle_pos
  mov bx, [gfx_y]
  shl bx, 1
  inc bx
  add ax, bx
  mov [gfx_err], ax
  jmp gfx_circle_loop
gfx_circle_pos:
  dec word [gfx_x]
  mov bx, [gfx_y]
  sub bx, [gfx_x]
  shl bx, 1
  inc bx
  add ax, bx
  mov [gfx_err], ax
  jmp gfx_circle_loop
gfx_circle_ret:
  ret

; uses gfx_cx, gfx_cy, gfx_r2, gfx_c
gfx_fill_circle:
  cmp word [gfx_r2], 0
  jl gfx_fc_ret
  mov ax, [gfx_r2]
  mov [gfx_x], ax
  mov word [gfx_y], 0
  mov ax, 1
  sub ax, [gfx_r2]
  mov [gfx_err], ax
gfx_fc_loop:
  mov ax, [gfx_x]
  cmp ax, [gfx_y]
  jl gfx_fc_ret
  mov ax, [gfx_cx]
  sub ax, [gfx_x]
  mov bx, [gfx_cy]
  add bx, [gfx_y]
  mov cx, [gfx_x]
  shl cx, 1
  inc cx
  mov dl, [gfx_c]
  call gfx_hline
  mov ax, [gfx_cx]
  sub ax, [gfx_x]
  mov bx, [gfx_cy]
  sub bx, [gfx_y]
  mov cx, [gfx_x]
  shl cx, 1
  inc cx
  mov dl, [gfx_c]
  call gfx_hline
  mov ax, [gfx_cx]
  sub ax, [gfx_y]
  mov bx, [gfx_cy]
  add bx, [gfx_x]
  mov cx, [gfx_y]
  shl cx, 1
  inc cx
  mov dl, [gfx_c]
  call gfx_hline
  mov ax, [gfx_cx]
  sub ax, [gfx_y]
  mov bx, [gfx_cy]
  sub bx, [gfx_x]
  mov cx, [gfx_y]
  shl cx, 1
  inc cx
  mov dl, [gfx_c]
  call gfx_hline
  inc word [gfx_y]
  mov ax, [gfx_err]
  test ax, ax
  jns gfx_fc_pos
  mov bx, [gfx_y]
  shl bx, 1
  inc bx
  add ax, bx
  mov [gfx_err], ax
  jmp gfx_fc_loop
gfx_fc_pos:
  dec word [gfx_x]
  mov bx, [gfx_y]
  sub bx, [gfx_x]
  shl bx, 1
  inc bx
  add ax, bx
  mov [gfx_err], ax
  jmp gfx_fc_loop
gfx_fc_ret:
  ret

; ---------------------------------------------------------------- graphics opcodes
op_ginit:
  call gfx_init
  jmp run

op_gend:
  call gfx_end
  jmp run

op_gclear:
  call ensure_gfx
  call pop_val
  mov al, dl
  call gfx_clear_raw
  jmp run

op_gpixel:
  call ensure_gfx
  call pop_val
  mov [gfx_c], dl
  call pop_val
  mov [gfx_y], dx
  call pop_val
  mov [gfx_x], dx
  mov ax, [gfx_x]
  mov bx, [gfx_y]
  mov cl, [gfx_c]
  call gfx_setpixel
  jmp run

op_gfillrect:
  call ensure_gfx
  call pop_val
  mov [gfx_c], dl
  call pop_val
  mov [gfx_h], dx
  call pop_val
  mov [gfx_w], dx
  call pop_val
  mov [gfx_y], dx
  call pop_val
  mov [gfx_x], dx
  call gfx_fill_rect
  jmp run

op_grect:
  call ensure_gfx
  call pop_val
  mov [gfx_c], dl
  call pop_val
  mov [gfx_h], dx
  call pop_val
  mov [gfx_w], dx
  call pop_val
  mov [gfx_y], dx
  call pop_val
  mov [gfx_x], dx
  call gfx_rect
  jmp run

op_gline:
  call ensure_gfx
  call pop_val
  mov [gfx_c], dl
  call pop_val
  mov [gfx_y2], dx
  call pop_val
  mov [gfx_x2], dx
  call pop_val
  mov [gfx_y1], dx
  call pop_val
  mov [gfx_x1], dx
  call gfx_line
  jmp run

op_gfillcircle:
  call ensure_gfx
  call pop_val
  mov [gfx_c], dl
  call pop_val
  mov [gfx_r2], dx
  call pop_val
  mov [gfx_cy], dx
  call pop_val
  mov [gfx_cx], dx
  call gfx_fill_circle
  jmp run

op_gcircle:
  call ensure_gfx
  call pop_val
  mov [gfx_c], dl
  call pop_val
  mov [gfx_r2], dx
  call pop_val
  mov [gfx_cy], dx
  call pop_val
  mov [gfx_cx], dx
  call gfx_circle
  jmp run

op_rgb:
  call pop_val
  mov [gfx_b], dl
  call pop_val
  mov [gfx_g], dl
  call pop_val
  mov [gfx_r], dl
  mov al, [gfx_r]
  and al, 0xE0
  mov bl, [gfx_g]
  and bl, 0xE0
  shr bl, 1
  shr bl, 1
  shr bl, 1
  or al, bl
  mov bl, [gfx_b]
  and bl, 0xC0
  shr bl, 1
  shr bl, 1
  shr bl, 1
  shr bl, 1
  shr bl, 1
  shr bl, 1
  or al, bl
  xor ah, ah
  mov dx, ax
  xor al, al
  call push_val
  jmp run

; ---------------------------------------------------------------- array opcodes
op_newarr:
  mov al, [si]
  add si, 2
  mov [tmp_byte], al
  call pop_val
  mov [tmp_len], dx
  test dx, dx
  js fault_array
  cmp dx, 7000
  ja fault_array
  mov ax, dx
  shl ax, 1
  shl ax, 1
  add ax, 2
  jc fault_array
  mov cx, ax
  call alloc
  mov [tmp_ptr], di
  mov byte [di-2], 3
  mov bx, [tmp_len]
  mov [di], bx
  add di, 2
  mov cx, bx
  mov al, [tmp_byte]
  test cx, cx
  jz op_newarr_done
op_newarr_loop:
  mov [di], al
  mov byte [di+1], 0
  mov word [di+2], 0
  cmp al, 1
  jne op_newarr_next
  mov dx, msg_empty
  mov [di+2], dx
op_newarr_next:
  add di, 4
  dec cx
  jnz op_newarr_loop
op_newarr_done:
  mov al, 3
  mov dx, [tmp_ptr]
  call push_val
  jmp run

op_aget:
  call pop_val
  mov [tmp_len], dx
  call pop_val
  cmp al, 3
  jne fault_array
  mov bx, dx
  mov ax, [tmp_len]
  test ax, ax
  js fault_array
  cmp ax, [bx]
  jae fault_array
  shl ax, 1
  shl ax, 1
  add ax, 2
  add bx, ax
  mov al, [bx]
  mov dx, [bx+2]
  call push_val
  jmp run

op_aset:
  call pop_val
  mov [a_type], al
  mov [a_val], dx
  call pop_val
  mov [tmp_len], dx
  call pop_val
  cmp al, 3
  jne fault_array
  mov bx, dx
  mov ax, [tmp_len]
  test ax, ax
  js fault_array
  cmp ax, [bx]
  jae fault_array
  shl ax, 1
  shl ax, 1
  add ax, 2
  add bx, ax
  mov al, [a_type]
  mov [bx], al
  mov dx, [a_val]
  mov [bx+2], dx
  call push_val
  jmp run

op_gpalette:
  call pop_val
  mov [gfx_b], dl
  call pop_val
  mov [gfx_g], dl
  call pop_val
  mov [gfx_r], dl
  call pop_val
  cmp dx, 255
  ja op_gpalette_done
  mov bx, dx
  mov dh, [gfx_r]
  shr dh, 1
  shr dh, 1
  mov ch, [gfx_g]
  shr ch, 1
  shr ch, 1
  mov cl, [gfx_b]
  shr cl, 1
  shr cl, 1
  mov ax, 0x1010
  int 0x10
op_gpalette_done:
  jmp run

op_gsprite:
  call ensure_gfx
  call pop_val
  mov [gfx_h], dx
  call pop_val
  mov [gfx_w], dx
  call pop_val
  cmp al, 1
  jne op_gsprite_bad
  mov [gfx_src], dx
  call pop_val
  mov [gfx_y], dx
  call pop_val
  mov [gfx_x], dx
  call gfx_sprite
  jmp run
op_gsprite_bad:
  mov di, msg_type
  call warn
  jmp run

op_gtext:
  call ensure_gfx
  call pop_val
  mov [gfx_c], dl
  call pop_val
  cmp al, 1
  jne op_gtext_bad
  mov [gfx_src], dx
  call pop_val
  mov [gfx_y], dx
  call pop_val
  mov [gfx_x], dx
  call gfx_text
  jmp run
op_gtext_bad:
  mov di, msg_type
  call warn
  jmp run

; ---------------------------------------------------------------- extended graphics
; AX=source offset, BX=row, CL=color
gfx_font_byte:
  push ax
  push bx
  push cx
  push dx
  push di
  mov [gfx_py], bx
  mov [gfx_c], cl
  mov word [gfx_bit], 0
gfx_font_bits:
  cmp word [gfx_bit], 8
  jae gfx_font_byte_done
  mov ax, [gfx_bits]
  test al, 0x80
  jz gfx_font_skip
  mov ax, [gfx_tx]
  add ax, [gfx_bit]
  mov bx, [gfx_py]
  mov cl, [gfx_c]
  call gfx_setpixel
gfx_font_skip:
  mov al, [gfx_bits]
  shl al, 1
  mov [gfx_bits], al
  inc word [gfx_bit]
  jmp gfx_font_bits
gfx_font_byte_done:
  pop di
  pop dx
  pop cx
  pop bx
  pop ax
  ret

; Draw an 8x8 bitmap-font string. [gfx_src] = string pointer, [gfx_x]/[gfx_y].
gfx_text:
  push ax
  push bx
  push cx
  push dx
  push si
  push di
  mov si, [gfx_src]
  mov ax, [si]
  mov [gfx_len], ax
  add si, 2
  mov ax, [gfx_x]
  mov [gfx_tx], ax
  mov ax, [gfx_y]
  mov [gfx_ty], ax
gfx_text_char:
  cmp word [gfx_len], 0
  jbe gfx_text_done
  mov al, [si]
  inc si
  dec word [gfx_len]
  cmp al, 10
  jne gfx_text_not_nl
  mov ax, [gfx_x]
  mov [gfx_tx], ax
  add word [gfx_ty], 8
  jmp gfx_text_char
gfx_text_not_nl:
  cmp al, 13
  je gfx_text_char
  cmp al, 'a'
  jb gfx_text_upper_done
  cmp al, 'z'
  ja gfx_text_upper_done
  sub al, 32
gfx_text_upper_done:
  cmp al, 32
  jb gfx_text_badglyph
  cmp al, 95
  jbe gfx_text_glyph
gfx_text_badglyph:
  mov al, '?'
gfx_text_glyph:
  sub al, 32
  xor ah, ah
  shl ax, 1
  shl ax, 1
  shl ax, 1
  add ax, font_data
  mov [gfx_glyph], ax
  mov word [gfx_row], 0
gfx_text_row:
  cmp word [gfx_row], 8
  jae gfx_text_char_done
  mov bx, [gfx_glyph]
  mov al, [bx]
  mov [gfx_bits], al
  inc word [gfx_glyph]
  mov ax, [gfx_tx]
  mov bx, [gfx_ty]
  add bx, [gfx_row]
  mov cl, [gfx_c]
  call gfx_font_byte
  inc word [gfx_row]
  jmp gfx_text_row
gfx_text_char_done:
  add word [gfx_tx], 8
  jmp gfx_text_char
gfx_text_done:
  pop di
  pop si
  pop dx
  pop cx
  pop bx
  pop ax
  ret

; Draw a string sprite. [gfx_src]=string, [gfx_x]/[gfx_y]/[gfx_w]/[gfx_h].
gfx_sprite:
  push ax
  push bx
  push cx
  push dx
  push si
  push di
  mov si, [gfx_src]
  mov ax, [si]
  mov [gfx_len], ax
  add si, 2
  cmp word [gfx_w], 0
  jle gfx_sprite_done
  cmp word [gfx_h], 0
  jle gfx_sprite_done
  mov word [gfx_row], 0
gfx_sprite_row:
  mov ax, [gfx_row]
  cmp ax, [gfx_h]
  jae gfx_sprite_done
  mov word [gfx_col], 0
gfx_sprite_col:
  mov ax, [gfx_col]
  cmp ax, [gfx_w]
  jae gfx_sprite_next_row
  cmp word [gfx_len], 0
  je gfx_sprite_done
  mov al, [si]
  inc si
  dec word [gfx_len]
  cmp al, 32
  je gfx_sprite_skip
  cmp al, '.'
  je gfx_sprite_skip
  mov bl, al
  cmp al, '0'
  jb gfx_sprite_other
  cmp al, '9'
  ja gfx_sprite_alpha
  sub al, '0'
  jmp gfx_sprite_got
gfx_sprite_alpha:
  cmp al, 'A'
  jb gfx_sprite_lower
  cmp al, 'F'
  ja gfx_sprite_lower
  sub al, 'A' - 10
  jmp gfx_sprite_got
gfx_sprite_lower:
  cmp al, 'a'
  jb gfx_sprite_other
  cmp al, 'f'
  ja gfx_sprite_other
  sub al, 'a' - 10
  jmp gfx_sprite_got
gfx_sprite_other:
  mov al, bl
gfx_sprite_got:
  mov cl, al
  mov ax, [gfx_x]
  add ax, [gfx_col]
  mov bx, [gfx_y]
  add bx, [gfx_row]
  call gfx_setpixel
gfx_sprite_skip:
  inc word [gfx_col]
  jmp gfx_sprite_col
gfx_sprite_next_row:
  inc word [gfx_row]
  jmp gfx_sprite_row
gfx_sprite_done:
  pop di
  pop si
  pop dx
  pop cx
  pop bx
  pop ax
  ret

; ---------------------------------------------------------------- dispatch table
jt:
  dw op_halt, op_pushi, op_pushs, op_load, op_store, op_loadg, op_storeg
  dw op_add, op_sub, op_mul, op_div, op_mod, op_neg
  dw op_eq, op_ne, op_lt, op_le, op_gt, op_ge
  dw op_and, op_or, op_not, op_concat
  dw op_print, op_println, op_newline, op_clear
  dw op_jmp, op_jz, op_jnz, op_call, op_ret
  dw op_readline, op_readkey, op_tostr, op_len, op_parse, op_dup, op_pop
  dw op_abs, op_min, op_max, op_upper, op_lower
  dw op_ginit, op_gend, op_gclear, op_gpixel, op_gfillrect
  dw op_grect, op_gline, op_gfillcircle, op_gcircle, op_rgb
  dw op_newarr, op_aget, op_aset, op_gpalette, op_gsprite, op_gtext

; ---------------------------------------------------------------- data
row:        dw 0
col:        dw 0
cur_off:    dw 0
cur_attr:   db 0x0F
vsp:        dw 0
heap:       dw 0
gc_retry:   db 0
gc_roots:   dw a_val, b_val, c_val, tmp_ptr, tmp_dst, in_ptr, pv_val
a_type:     db 0
a_val:      dw 0
a_len:      dw 0
b_type:     db 0
b_val:      dw 0
tmp_len:    dw 0
c_val:      dw 0
pv_val:     dw 0
tmp_ptr:    dw 0
tmp_dst:    dw 0
tmp_byte:   db 0
numlen:     dw 0
had_digit:  db 0
case_mode:  db 0
ps_ptr:     dw 0
argc:       dw 0
new_ip:     dw 0
new_frame:  dw 0
callee_locals: dw 0
ret_type:   db 0
ret_val:    dw 0
in_len:     dw 0
in_ptr:     dw 0
gfx_on:     db 0
gfx_pal_i:  dw 0
gfx_r:      db 0
gfx_g:      db 0
gfx_b:      db 0
gfx_c:      db 0
gfx_x:      dw 0
gfx_y:      dw 0
gfx_w:      dw 0
gfx_h:      dw 0
gfx_x1:     dw 0
gfx_y1:     dw 0
gfx_x2:     dw 0
gfx_y2:     dw 0
gfx_cx:     dw 0
gfx_cy:     dw 0
gfx_r2:     dw 0
gfx_dx:     dw 0
gfx_dy:     dw 0
gfx_sx:     dw 0
gfx_sy:     dw 0
gfx_err:    dw 0
gfx_e2:     dw 0
gfx_src:    dw 0
gfx_tx:     dw 0
gfx_ty:     dw 0
gfx_py:     dw 0
gfx_row:    dw 0
gfx_col:    dw 0
gfx_bit:    dw 0
gfx_glyph:  dw 0
gfx_len:    dw 0
gfx_bits:   db 0

font_data:
${FONT_LINES}

msg_boot:   msg "\nSharpBoot 2.0 / 16-bit C# runtime\n\n"
msg_halted: msg "\n[program halted]"
msg_div0:   msg "\n[repair] division by zero -> 0\n"
msg_mod0:   msg "\n[repair] modulo by zero -> 0\n"
msg_parse:  msg "\n[repair] unreadable number -> 0\n"
msg_type:   msg "\n[repair] wrong value type -> 0\n"
msg_strord: msg "\n[repair] string ordering is unsupported -> false\n"
msg_esc:    msg "\n[halted by ESC]\n"
msg_oom:    msg "\n[fatal] heap exhausted\n"
msg_arr:    msg "\n[fatal] array index or allocation error\n"
msg_stack:  msg "\n[fatal] VM stack overflow\n"
msg_code:   msg "\n[fatal] bytecode overrun\n"
msg_op:     msg "\n[fatal] unknown opcode\n"
msg_true:   msg "True"
msg_false:  msg "False"
msg_empty:  dw 0

numstr:     dw 0
            resb 16
numbuf:     resb 16
numbuf_end:
inbuf:      resb 128
`;
