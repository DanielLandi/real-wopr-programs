       IDENTIFICATION DIVISION.
       PROGRAM-ID. REFERENCE.
      * SYSTEM/1 reference system (docs/systems.md). Reads one SYSTEM/1
      * request on stdin, writes one response on stdout. Stateless per
      * invocation; STATE carries a turn counter to prove the round-trip.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
      *    GnuCOBOL's -std=cobol85 dialect disables device mnemonics
      *    (config `device-mnemonics: no`), so `ASSIGN TO KEYBOARD`
      *    opens a literal file named KEYBOARD and blocks forever on
      *    READ instead of reading the redirected stdin. Assign to the
      *    stdin device path directly; this is a GnuCOBOL/host
      *    plumbing detail only — it does not touch the SYSTEM/1 wire
      *    format.
           SELECT SYS-IN ASSIGN TO "/dev/stdin"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-FS.
       DATA DIVISION.
       FILE SECTION.
       FD  SYS-IN.
       01  IN-REC              PIC X(256).
       WORKING-STORAGE SECTION.
       01  WS-FS               PIC XX.
       01  WS-CMD              PIC X(16) VALUE SPACES.
       01  WS-STATE-N          PIC 9(4)  VALUE 0.
       01  WS-COUNTER          PIC 9(9)  VALUE 0.
       01  WS-NEXT             PIC 9(9)  VALUE 0.
       01  WS-NEXT-D           PIC Z(8)9.
       01  WS-INPUT            PIC X(240) VALUE SPACES.
       01  WS-INPUT-LEN        PIC 9(4)  VALUE 0.
       01  WS-CTR-START        PIC 9(4)  VALUE 0.
       01  WS-CTR-LEN          PIC 9(4)  VALUE 0.
       01  WS-HAVE-INPUT       PIC X VALUE "N".
       01  WS-TOK              PIC X(16).
       01  WS-EOF              PIC X VALUE "N".
       01  WS-I                PIC 9(4).
       01  WS-J                PIC 9(4).
       PROCEDURE DIVISION.
       MAIN.
           OPEN INPUT SYS-IN
      *    Line 1: SYSTEM/1 <id> <COMMAND>
           PERFORM READ-LINE
           IF WS-EOF = "Y" PERFORM PROTOCOL-ERROR END-IF
           UNSTRING IN-REC DELIMITED BY ALL SPACES
               INTO WS-TOK WS-TOK WS-CMD
           END-UNSTRING
      *    Line 2: STATE <n>
           PERFORM READ-LINE
           UNSTRING IN-REC DELIMITED BY ALL SPACES
               INTO WS-TOK WS-TOK
           END-UNSTRING
           MOVE FUNCTION NUMVAL(IN-REC(7:4)) TO WS-STATE-N
      *    n state lines: first (if any) is the counter
           IF WS-STATE-N > 0
               PERFORM READ-LINE
               MOVE FUNCTION NUMVAL(IN-REC) TO WS-COUNTER
               PERFORM VARYING WS-I FROM 2 BY 1 UNTIL WS-I > WS-STATE-N
                   PERFORM READ-LINE
               END-PERFORM
           END-IF
      *    optional INPUT line, then END
           PERFORM READ-LINE
           IF IN-REC(1:6) = "INPUT "
               MOVE IN-REC(7:240) TO WS-INPUT
               MOVE "Y" TO WS-HAVE-INPUT
               PERFORM READ-LINE
           END-IF
           CLOSE SYS-IN
           EVALUATE WS-CMD
               WHEN "CONNECT" PERFORM DO-CONNECT
               WHEN "INPUT"   PERFORM DO-INPUT
               WHEN OTHER     PERFORM PROTOCOL-ERROR
           END-EVALUATE
           STOP RUN.
       READ-LINE.
           READ SYS-IN
               AT END MOVE "Y" TO WS-EOF MOVE SPACES TO IN-REC
           END-READ.
       DO-CONNECT.
           DISPLAY "SYSTEM/1 reference OK"
           DISPLAY "STATE 1"
           DISPLAY "0"
           DISPLAY "DISPLAY 2"
           DISPLAY "REFERENCE SYSTEM READY"
           DISPLAY "TYPE ANYTHING; BYE TO HANG UP."
           DISPLAY "LINE UP"
           DISPLAY "END".
       DO-INPUT.
      *    An INPUT command with no INPUT line is a malformed request:
      *    drop the line rather than echo an empty string (SYSTEM/1 §2.3).
           IF WS-HAVE-INPUT NOT = "Y"
               PERFORM PROTOCOL-ERROR
           END-IF
      *    GnuCOBOL's -std=cobol85 dialect has no FUNCTION TRIM (a
      *    COBOL-2002 intrinsic); trim manually via reference
      *    modification, the period-correct COBOL-85 idiom.
           PERFORM RTRIM-INPUT
           IF WS-INPUT-LEN = 3 AND WS-INPUT(1:3) = "BYE"
               DISPLAY "SYSTEM/1 reference OK"
               DISPLAY "STATE 0"
               DISPLAY "DISPLAY 1"
               DISPLAY "GOODBYE."
               DISPLAY "LINE DROP"
               DISPLAY "END"
           ELSE
               ADD 1 WS-COUNTER GIVING WS-NEXT
               MOVE WS-NEXT TO WS-NEXT-D
               PERFORM LTRIM-COUNTER
               DISPLAY "SYSTEM/1 reference OK"
               DISPLAY "STATE 1"
               DISPLAY WS-NEXT-D(WS-CTR-START:WS-CTR-LEN)
               DISPLAY "DISPLAY 1"
               DISPLAY "[" WS-NEXT-D(WS-CTR-START:WS-CTR-LEN)
                   "] YOU SAID: " WS-INPUT(1:WS-INPUT-LEN)
               DISPLAY "LINE UP"
               DISPLAY "END"
           END-IF.
       RTRIM-INPUT.
      *    Find the last non-space character in WS-INPUT (fixed
      *    PIC X(240), right-padded); embedded spaces are preserved.
           MOVE 240 TO WS-J
           PERFORM UNTIL WS-J = 0 OR WS-INPUT(WS-J:1) NOT = SPACE
               SUBTRACT 1 FROM WS-J
           END-PERFORM
           MOVE WS-J TO WS-INPUT-LEN
           IF WS-INPUT-LEN = 0
               MOVE 1 TO WS-INPUT-LEN
           END-IF.
       LTRIM-COUNTER.
      *    WS-NEXT-D is zero-suppressed (PIC Z(8)9), so it is
      *    left-padded with spaces; find the first digit.
           MOVE 1 TO WS-CTR-START
           PERFORM UNTIL WS-CTR-START > 9
                   OR WS-NEXT-D(WS-CTR-START:1) NOT = SPACE
               ADD 1 TO WS-CTR-START
           END-PERFORM
           COMPUTE WS-CTR-LEN = 10 - WS-CTR-START.
       PROTOCOL-ERROR.
           DISPLAY "SYSTEM/1 reference OK"
           DISPLAY "STATE 0"
           DISPLAY "DISPLAY 1"
           DISPLAY "PROTOCOL ERROR"
           DISPLAY "LINE DROP"
           DISPLAY "END"
           STOP RUN GIVING 1.
