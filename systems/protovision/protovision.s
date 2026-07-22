; ---------------------------------------------------------------------------
; PROTOVISION development BBS - a SYSTEM/1 peripheral in hand-written 6502
; assembly (ca65 syntax), assembled with `cl65 -t sim6502`, run per turn by
; `sim65`. I/O is only via the sim65 paravirt syscalls (_read/_write/exit).
;
; The wire contract is docs/systems.md (frozen). Each turn:
;   request  (stdin):  SYSTEM/1 protovision <CONNECT|INPUT> / STATE <n> / ...
;   response (stdout): SYSTEM/1 protovision OK / STATE <m> / ... / LINE <..> / END
; The STATE block is opaque to everyone but this program; it carries the queue.
;
; Deterministic: the catalog is a fixed table in RODATA, and the queue is
; derived only from the request STATE. No wall clock, no randomness.
; ---------------------------------------------------------------------------

        .export _main
        .import _read, _write, pushax, exit

; --- set a 16-bit RODATA pointer (sptr) from a symbol -----------------------
.macro  SET_SPTR addr
        lda     #<addr
        sta     sptr
        lda     #>addr
        sta     sptr+1
.endmacro

INBUFSZ = 511          ; max request bytes accepted; inbuf is 512 (room for NUL)
CMDLINEMAX = 72        ; max accepted "INPUT <cmd>\n" length; over this -> ?REDO

; ---------------------------------------------------------------------------
; Zero page: three 16-bit pointers used with (zp),y indirect addressing.
; Appended after the cc65 runtime's own zero-page block (ZP MEMORY is a full
; page in sim6502.cfg), so pushax/_read/_write never touch these.
; ---------------------------------------------------------------------------
        .segment "ZEROPAGE"
sptr:   .res 2                  ; source pointer (RODATA string / catalog)
lptr:   .res 2                  ; line-scan pointer (into inbuf)
optr:   .res 2                  ; output write pointer (into outbuf)

; ---------------------------------------------------------------------------
        .bss
inbuf:  .res 512                ; raw request bytes from stdin (+NUL terminator)
outbuf: .res 600                ; assembled response bytes
qlist:  .res 8                  ; queued RELEASED indices, as ASCII '1'..'3'
qlen:   .res 1                  ; number of queued indices
cmdch:  .res 1                  ; user command letter (L/I/Q/G/...)
argd:   .res 1                  ; user command argument digit (ASCII, 0 = none)
nstate: .res 1                  ; declared STATE line count from the request
scount: .res 1                  ; state-line loop countdown
idx:    .res 1                  ; catalog index value (1..5)
tmpc:   .res 1                  ; scratch char
rptr:   .res 2                  ; read: current buffer position
rrem:   .res 2                  ; read: bytes remaining in buffer
rgot:   .res 2                  ; read: bytes returned this call
rlen:   .res 2                  ; read: total bytes accumulated
wlen:   .res 2                  ; write: response length
inend:  .res 2                  ; one-past-last request byte (scan upper bound)
inpstart: .res 2                ; start of the "INPUT <cmd>" line (length measure)
cmdlen: .res 2                  ; measured length of the "INPUT <cmd>\n" line

; ===========================================================================
        .code
; ===========================================================================
_main:
        jsr     read_all               ; slurp stdin -> inbuf, NUL-terminate

        ; optr = outbuf
        lda     #<outbuf
        sta     optr
        lda     #>outbuf
        sta     optr+1
        ; lptr = inbuf (line 1 = the request header)
        lda     #<inbuf
        sta     lptr
        lda     #>inbuf
        sta     lptr+1

        ; --- dispatch on the request header line ---
        SET_SPTR STR_HDR_CONNECT
        jsr     matchstr
        bcc     @notconn
        lda     (lptr),y               ; char after the matched prefix
        cmp     #$0A                   ; must be end-of-line (exact match)
        bne     @notconn
        jmp     do_connect
@notconn:
        SET_SPTR STR_HDR_INPUT
        jsr     matchstr
        bcc     @bad
        lda     (lptr),y
        cmp     #$0A
        bne     @bad
        jmp     parse_input
@bad:
        jmp     perror

; ---------------------------------------------------------------------------
; read_all: loop _read(0, inbuf+rlen, INBUFSZ-rlen) until it returns 0 bytes
; (EOF) or the buffer is full, then NUL-terminate at inbuf+rlen.
; ---------------------------------------------------------------------------
read_all:
        lda     #0
        sta     rlen
        sta     rlen+1
@loop:
        ; rptr = inbuf + rlen
        lda     #<inbuf
        clc
        adc     rlen
        sta     rptr
        lda     #>inbuf
        adc     rlen+1
        sta     rptr+1
        ; rrem = INBUFSZ - rlen  (caps accumulation at the buffer size; a request
        ; larger than INBUFSZ is truncated here, so its END is lost and parsing
        ; later returns PROTOCOL ERROR -- the "oversize malformed request" path)
        lda     #<INBUFSZ
        sec
        sbc     rlen
        sta     rrem
        lda     #>INBUFSZ
        sbc     rlen+1
        sta     rrem+1
        ; buffer full? (rrem == 0) -> stop
        lda     rrem
        ora     rrem+1
        beq     @done
        ; _read(0, rptr, rrem)
        lda     #0
        ldx     #0
        jsr     pushax                 ; fd = 0 (stdin)
        lda     rptr
        ldx     rptr+1
        jsr     pushax                 ; buf
        lda     rrem
        ldx     rrem+1
        jsr     _read                  ; A/X = bytes read (low/high)
        sta     rgot
        stx     rgot+1
        ; EOF? (0 bytes) -> stop
        lda     rgot
        ora     rgot+1
        beq     @done
        ; rlen += rgot
        lda     rlen
        clc
        adc     rgot
        sta     rlen
        lda     rlen+1
        adc     rgot+1
        sta     rlen+1
        jmp     @loop
@done:
        ; NUL-terminate at inbuf + rlen, and record inend = that address as the
        ; hard upper bound every buffer scanner stops at (so no scan can run past
        ; the bytes actually read, regardless of input length).
        lda     #<inbuf
        clc
        adc     rlen
        sta     lptr
        sta     inend
        lda     #>inbuf
        adc     rlen+1
        sta     lptr+1
        sta     inend+1
        lda     #0
        tay
        sta     (lptr),y
        rts

; ---------------------------------------------------------------------------
; matchstr: compare NUL-terminated pattern at sptr against the bytes at lptr.
; On full pattern match: carry set, Y = pattern length (index of the byte in
; the buffer just past the match). On mismatch: carry clear. lptr is unchanged.
; ---------------------------------------------------------------------------
matchstr:
        ldy     #0
@lp:
        lda     (sptr),y
        beq     @ok                    ; pattern NUL -> matched
        cmp     (lptr),y
        bne     @no
        iny
        bne     @lp
@ok:
        sec
        rts
@no:
        clc
        rts

; ---------------------------------------------------------------------------
; next_line: advance lptr to the first byte after the next '\n'. Walks a 16-bit
; pointer one byte at a time and STOPS at inend, so an arbitrarily long (even
; >255-byte) line can never wrap an 8-bit index or loop forever -- if no '\n'
; appears before inend, lptr is left at inend (the terminating NUL).
; ---------------------------------------------------------------------------
next_line:
@lp:
        ; stop if lptr >= inend (unsigned 16-bit compare)
        lda     lptr
        cmp     inend
        lda     lptr+1
        sbc     inend+1
        bcs     @stop
        ldy     #0
        lda     (lptr),y               ; current byte (advance past it below)
        inc     lptr
        bne     @c
        inc     lptr+1
@c:
        cmp     #$0A                   ; was it the line terminator?
        bne     @lp
@stop:
        rts

; ---------------------------------------------------------------------------
; emitz: copy the NUL-terminated string at sptr into outbuf at optr, advancing
; optr past it.
; ---------------------------------------------------------------------------
emitz:
        ldy     #0
@lp:
        lda     (sptr),y
        beq     @done
        sta     (optr),y
        iny
        bne     @lp
@done:
        tya
        clc
        adc     optr
        sta     optr
        lda     optr+1
        adc     #0
        sta     optr+1
        rts

; ---------------------------------------------------------------------------
; emitc: append the byte in A to outbuf at optr. Preserves X.
; ---------------------------------------------------------------------------
emitc:
        ldy     #0
        sta     (optr),y
        inc     optr
        bne     @s
        inc     optr+1
@s:
        rts

; ---------------------------------------------------------------------------
; emit_state_count / emit_display: emit "STATE " / "DISPLAY " + one digit + \n.
; A = count (0..9).
; ---------------------------------------------------------------------------
emit_state_count:
        pha
        SET_SPTR S_STATE
        jsr     emitz
        jmp     emit_countdig
emit_display:
        pha
        SET_SPTR S_DISPLAY
        jsr     emitz
emit_countdig:
        pla
        clc
        adc     #'0'
        jsr     emitc
        lda     #$0A
        jmp     emitc

; ---------------------------------------------------------------------------
; emit_qline: emit the opaque queue state line: "Q" then " <d>" per queued
; index, then \n.
; ---------------------------------------------------------------------------
emit_qline:
        SET_SPTR S_Q
        jsr     emitz
        ldx     #0
@lp:
        cpx     qlen
        beq     @done
        lda     #' '
        jsr     emitc
        lda     qlist,x
        jsr     emitc
        inx
        bne     @lp
@done:
        lda     #$0A
        jmp     emitc

; ---------------------------------------------------------------------------
; build_ok_state: emit the fixed response prologue that every non-error turn
; shares: OK header, STATE 2, CONN 1, and the queue line (current qlist).
; ---------------------------------------------------------------------------
build_ok_state:
        SET_SPTR S_OK
        jsr     emitz
        lda     #2
        jsr     emit_state_count
        SET_SPTR S_CONN
        jsr     emitz
        jmp     emit_qline

; ---------------------------------------------------------------------------
; LINE / END tails.
; ---------------------------------------------------------------------------
emit_lineup:
        SET_SPTR S_LINEUP
        jmp     emitz
emit_linedrop:
        SET_SPTR S_LINEDROP
        jmp     emitz
emit_end:
        SET_SPTR S_ENDNL
        jmp     emitz

; ---------------------------------------------------------------------------
; set_sptr_title / set_sptr_blurb: sptr = catalog entry for index X (1..5).
; ---------------------------------------------------------------------------
set_sptr_title:
        lda     titlelo-1,x
        sta     sptr
        lda     titlehi-1,x
        sta     sptr+1
        rts
set_sptr_blurb:
        lda     blurblo-1,x
        sta     sptr
        lda     blurbhi-1,x
        sta     sptr+1
        rts

; ===========================================================================
; parse_input: validate the INPUT request structure, extract the incoming
; queue from STATE, capture the user command, then dispatch.
; ===========================================================================
parse_input:
        jsr     next_line              ; skip header -> "STATE <n>"
        SET_SPTR S_STATE
        jsr     matchstr
        bcs     :+
        jmp     perror
:       lda     (lptr),y               ; the count digit
        sec
        sbc     #'0'
        bcs     :+
        jmp     perror                 ; < '0'
:       cmp     #10
        bcc     :+
        jmp     perror                 ; > '9'
:       sta     nstate
        iny
        lda     (lptr),y               ; must be end-of-line
        cmp     #$0A
        beq     :+
        jmp     perror
:       jsr     next_line              ; -> first state line

        ; --- walk nstate state lines, capturing the queue from the Q line ---
        lda     nstate
        sta     scount
@sl:
        lda     scount
        beq     @afterstate
        ldy     #0
        lda     (lptr),y
        cmp     #'Q'                   ; the queue-tag line?
        bne     @notq
        jsr     parse_qline
@notq:
        jsr     next_line
        dec     scount
        jmp     @sl
@afterstate:
        SET_SPTR S_INPUT
        jsr     matchstr
        bcs     :+
        jmp     perror                 ; STATE count irreconcilable
:       ; remember where the "INPUT <cmd>" line begins, to measure its length
        lda     lptr
        sta     inpstart
        lda     lptr+1
        sta     inpstart+1
        lda     (lptr),y               ; the command letter (offset 6)
        sta     cmdch
        jsr     parse_arg
        jsr     next_line              ; bounded advance past the (possibly long) line
        SET_SPTR S_END
        jsr     matchstr
        bcs     :+
        jmp     perror                 ; missing/mislocated END (or oversize/truncated request)
:
        ; cmdlen = lptr - inpstart = length of "INPUT <cmd>\n" (next_line landed
        ; on the byte after the '\n', i.e. the start of "END").
        lda     lptr
        sec
        sbc     inpstart
        sta     cmdlen
        lda     lptr+1
        sbc     inpstart+1
        sta     cmdlen+1
        ; Over-long command line? (high byte set, or low byte > CMDLINEMAX.)
        ; This is the "normal over-long command" path: a well-formed request whose
        ; user line is absurdly long. Answer it like any unknown command (?REDO,
        ; LINE UP, exit 0) rather than accepting a valid leading letter + junk.
        lda     cmdlen+1
        beq     @lenok
        jmp     do_redo
@lenok:
        lda     cmdlen
        cmp     #CMDLINEMAX+1
        bcc     @dispatch
        jmp     do_redo
@dispatch:
        ; --- dispatch on the command letter ---
        lda     cmdch
        cmp     #'L'
        bne     @n1
        jmp     do_list
@n1:
        cmp     #'I'
        bne     @n2
        jmp     do_info
@n2:
        cmp     #'Q'
        bne     @n3
        lda     argd
        bne     @qarg
        jmp     do_qshow
@qarg:
        jmp     do_queue
@n3:
        cmp     #'G'
        bne     @n4
        jmp     do_goodbye
@n4:
        jmp     do_redo

; ---------------------------------------------------------------------------
; parse_qline: scan the Q state line at lptr (past the leading 'Q'), appending
; each ASCII digit to qlist. Bounded two ways: the scan gives up after 40 bytes
; (Y never wraps), and appends stop once qlist (.res 8) is full -- an overflow
; index is dropped rather than corrupting adjacent BSS.
; ---------------------------------------------------------------------------
parse_qline:
        ldy     #1                     ; skip 'Q'
@lp:
        cpy     #40                    ; bound the Q-line scan
        bcs     @done
        lda     (lptr),y
        beq     @done                  ; NUL
        cmp     #$0A
        beq     @done
        cmp     #'0'
        bcc     @skip
        cmp     #'9'+1
        bcs     @skip
        ldx     qlen                   ; append digit...
        cpx     #8                     ; ...unless qlist is full (drop overflow)
        bcs     @skip
        sta     qlist,x
        inc     qlen
@skip:
        iny
        bne     @lp
@done:
        rts

; ---------------------------------------------------------------------------
; parse_arg: from the "INPUT <cmd>" line (INPUT matched at offset 6, command
; letter at offset 6), find the first non-space char after the letter; if it is
; a digit, store it (ASCII) in argd, else argd = 0.
; ---------------------------------------------------------------------------
parse_arg:
        lda     #0
        sta     argd
        ldy     #7                     ; first byte after the command letter
@sk:
        cpy     #24                    ; bound the scan (Y can never wrap)
        bcs     @done
        lda     (lptr),y
        beq     @done                  ; NUL
        cmp     #$0A
        beq     @done
        cmp     #' '
        bne     @chk
        iny
        jmp     @sk                    ; skip spaces
@chk:
        cmp     #'0'
        bcc     @done
        cmp     #'9'+1
        bcs     @done
        sta     argd
@done:
        rts

; ---------------------------------------------------------------------------
; queue_add: append the released index in `idx` (1..3) to qlist as an ASCII
; digit, unless it is already present.
; ---------------------------------------------------------------------------
queue_add:
        lda     idx
        clc
        adc     #'0'
        sta     tmpc
        ldx     #0
@s:
        cpx     qlen
        beq     @add
        lda     qlist,x
        cmp     tmpc
        beq     @done                  ; already queued -> no dup
        inx
        bne     @s
@add:
        ldx     qlen
        cpx     #8                     ; qlist full -> drop (memory-safe)
        bcs     @done
        lda     tmpc
        sta     qlist,x
        inc     qlen
@done:
        rts

; ===========================================================================
; Command handlers. Each emits a full response, then `jmp finish` (exit 0).
; ===========================================================================

; CONNECT: greeting, empty queue, LINE UP.
do_connect:
        jsr     build_ok_state
        lda     #3
        jsr     emit_display
        SET_SPTR S_G1
        jsr     emitz
        SET_SPTR S_G2
        jsr     emitz
        SET_SPTR S_COMMAND
        jsr     emitz
        jsr     emit_lineup
        jsr     emit_end
        jmp     finish

; L: the catalog listing (8 lines), STATE unchanged.
do_list:
        jsr     build_ok_state
        lda     #8
        jsr     emit_display
        SET_SPTR S_RELEASED
        jsr     emitz
        ldx     #1                     ; released titles 1..3
@rl:
        cpx     #4
        beq     @locked
        txa
        clc
        adc     #'0'
        jsr     emitc
        lda     #' '
        jsr     emitc
        jsr     set_sptr_title
        jsr     emitz
        lda     #$0A
        jsr     emitc
        inx
        jmp     @rl
@locked:
        SET_SPTR S_PRELOCK
        jsr     emitz
        ldx     #4                     ; locked titles 4..5
@ll:
        cpx     #6
        beq     @cmd
        txa
        clc
        adc     #'0'
        jsr     emitc
        SET_SPTR S_STARSEP
        jsr     emitz
        jsr     set_sptr_title
        jsr     emitz
        lda     #$0A
        jsr     emitc
        inx
        jmp     @ll
@cmd:
        SET_SPTR S_COMMAND
        jsr     emitz
        jsr     emit_lineup
        jsr     emit_end
        jmp     finish

; I <n>: title + blurb, or NO SUCH TITLE. STATE unchanged.
do_info:
        jsr     build_ok_state
        lda     argd
        beq     @notitle
        sec
        sbc     #'0'
        cmp     #1
        bcc     @notitle
        cmp     #6
        bcs     @notitle
        sta     idx                    ; valid 1..5
        lda     #3
        jsr     emit_display
        ldx     idx
        jsr     set_sptr_title
        jsr     emitz
        lda     #$0A
        jsr     emitc
        ldx     idx
        jsr     set_sptr_blurb
        jsr     emitz
        lda     #$0A
        jsr     emitc
        SET_SPTR S_COMMAND
        jsr     emitz
        jmp     @up
@notitle:
        lda     #2
        jsr     emit_display
        SET_SPTR S_NOTITLE
        jsr     emitz
        SET_SPTR S_COMMAND
        jsr     emitz
@up:
        jsr     emit_lineup
        jsr     emit_end
        jmp     finish

; Q <n>: queue a released title, refuse a locked one, or NO SUCH TITLE.
do_queue:
        lda     argd
        sec
        sbc     #'0'
        sta     idx
        cmp     #1
        bcc     @notitle
        cmp     #4
        bcc     @released              ; 1..3
        cmp     #6
        bcc     @locked                ; 4..5
@notitle:
        jsr     build_ok_state         ; STATE unchanged
        lda     #2
        jsr     emit_display
        SET_SPTR S_NOTITLE
        jsr     emitz
        SET_SPTR S_COMMAND
        jsr     emitz
        jmp     @up
@locked:
        jsr     build_ok_state         ; STATE unchanged
        lda     #2
        jsr     emit_display
        SET_SPTR S_PENDING
        jsr     emitz
        SET_SPTR S_COMMAND
        jsr     emitz
        jmp     @up
@released:
        jsr     queue_add              ; mutate the queue first...
        jsr     build_ok_state         ; ...so STATE reflects it
        lda     #2
        jsr     emit_display
        SET_SPTR S_QUEUED
        jsr     emitz
        ldx     idx
        jsr     set_sptr_title
        jsr     emitz
        lda     #$0A
        jsr     emitc
        SET_SPTR S_COMMAND
        jsr     emitz
@up:
        jsr     emit_lineup
        jsr     emit_end
        jmp     finish

; Q (no arg): show the queue from STATE, or QUEUE EMPTY.
do_qshow:
        jsr     build_ok_state         ; STATE unchanged
        lda     qlen
        bne     @has
        lda     #2
        jsr     emit_display
        SET_SPTR S_QEMPTY
        jsr     emitz
        SET_SPTR S_COMMAND
        jsr     emitz
        jmp     @up
@has:
        lda     qlen                   ; DISPLAY = qlen + 2
        clc
        adc     #2
        jsr     emit_display
        SET_SPTR S_YOURQ
        jsr     emitz
        ldx     #0
@lp:
        cpx     qlen
        beq     @cmd
        txa
        pha                            ; save loop index
        lda     qlist,x
        sec
        sbc     #'0'
        sta     idx
        ldx     idx
        jsr     set_sptr_title
        jsr     emitz
        lda     #$0A
        jsr     emitc
        pla
        tax
        inx
        jmp     @lp
@cmd:
        SET_SPTR S_COMMAND
        jsr     emitz
@up:
        jsr     emit_lineup
        jsr     emit_end
        jmp     finish

; G: goodbye, hang up.
do_goodbye:
        jsr     build_ok_state
        lda     #1
        jsr     emit_display
        SET_SPTR S_GOODBYE
        jsr     emitz
        jsr     emit_linedrop
        jsr     emit_end
        jmp     finish

; any other command: stay up.
do_redo:
        jsr     build_ok_state
        lda     #2
        jsr     emit_display
        SET_SPTR S_REDO
        jsr     emitz
        SET_SPTR S_COMMAND
        jsr     emitz
        jsr     emit_lineup
        jsr     emit_end
        jmp     finish

; ---------------------------------------------------------------------------
; perror: malformed request. Emit the error response with an empty STATE and
; exit non-zero so *error* golden fixtures fail on a zero exit.
; ---------------------------------------------------------------------------
perror:
        SET_SPTR S_OK
        jsr     emitz
        lda     #0
        jsr     emit_state_count       ; STATE 0 (no state lines)
        lda     #1
        jsr     emit_display
        SET_SPTR S_PROTOERR
        jsr     emitz
        jsr     emit_linedrop
        jsr     emit_end
        jsr     do_write
        lda     #7                     ; non-zero exit code
        ldx     #0
        jmp     exit

; ---------------------------------------------------------------------------
; finish: flush outbuf to stdout, exit 0.
; ---------------------------------------------------------------------------
finish:
        jsr     do_write
        lda     #0
        ldx     #0
        jmp     exit

; do_write: _write(1, outbuf, optr-outbuf).
do_write:
        lda     optr
        sec
        sbc     #<outbuf
        sta     wlen
        lda     optr+1
        sbc     #>outbuf
        sta     wlen+1
        lda     #1
        ldx     #0
        jsr     pushax                 ; fd = 1 (stdout)
        lda     #<outbuf
        ldx     #>outbuf
        jsr     pushax                 ; buf
        lda     wlen
        ldx     wlen+1
        jsr     _write                 ; count in A/X
        rts

; ===========================================================================
        .rodata
; ===========================================================================

; --- request tokens (patterns matched against the incoming request) ---
STR_HDR_CONNECT: .byte "SYSTEM/1 protovision CONNECT", 0
STR_HDR_INPUT:   .byte "SYSTEM/1 protovision INPUT", 0
S_STATE:         .byte "STATE ", 0
S_INPUT:         .byte "INPUT ", 0
S_END:           .byte "END", 0

; --- response fixed lines (trailing \n unless noted) ---
S_OK:            .byte "SYSTEM/1 protovision OK", $0A, 0
S_DISPLAY:       .byte "DISPLAY ", 0            ; + digit + \n
S_CONN:          .byte "CONN 1", $0A, 0
S_Q:             .byte "Q", 0                   ; + " <d>"... + \n
S_COMMAND:       .byte "COMMAND:", $0A, 0
S_LINEUP:        .byte "LINE UP", $0A, 0
S_LINEDROP:      .byte "LINE DROP", $0A, 0
S_ENDNL:         .byte "END", $0A, 0
S_G1:            .byte "PROTOVISION DEVELOPMENT BBS - SUNNYVALE CA", $0A, 0
S_G2:            .byte "DEV ACCESS ONLY - TYPE L TO LIST", $0A, 0
S_RELEASED:      .byte "RELEASED", $0A, 0
S_PRELOCK:       .byte "PRE-RELEASE (LOCKED)", $0A, 0
S_STARSEP:       .byte " * ", 0                 ; between locked index and title
S_NOTITLE:       .byte "NO SUCH TITLE", $0A, 0
S_PENDING:       .byte "DEV ACCESS ONLY - RELEASE PENDING", $0A, 0
S_QUEUED:        .byte "QUEUED: ", 0            ; + title + \n
S_YOURQ:         .byte "YOUR QUEUE:", $0A, 0
S_QEMPTY:        .byte "QUEUE EMPTY", $0A, 0
S_GOODBYE:       .byte "GOODBYE.", $0A, 0
S_REDO:          .byte "?REDO FROM START", $0A, 0
S_PROTOERR:      .byte "PROTOCOL ERROR", $0A, 0

; --- catalog (fixed, deterministic) ---
titlelo: .byte <T1, <T2, <T3, <T4, <T5
titlehi: .byte >T1, >T2, >T3, >T4, >T5
blurblo: .byte <B1, <B2, <B3, <B4, <B5
blurbhi: .byte >B1, >B2, >B3, >B4, >B5

T1: .byte "ZYPHON", 0
T2: .byte "COMET JOCKEY", 0
T3: .byte "IRON WEDGE", 0
T4: .byte "VELDRAX", 0
T5: .byte "OBLICON", 0

B1: .byte "SIDE-SCROLLING SPACE SHOOTER. 1 PLAYER.", 0
B2: .byte "DODGE THE BELT. HI-SCORE SAVE.", 0
B3: .byte "TOP-DOWN TANK COMBAT. 2 PLAYER.", 0
B4: .byte "PRE-RELEASE. SLATED Q4.", 0
B5: .byte "PRE-RELEASE. UNANNOUNCED.", 0
