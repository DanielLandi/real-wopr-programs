       IDENTIFICATION DIVISION.
       PROGRAM-ID. UMB.
      * UNION MARINE BANK - SOUTHWEST REGIONAL DATA CENTER.
      * SYSTEM/1 back-office inquiry desk (docs/systems.md). Reads one
      * request on stdin, writes one response on stdout. Read-only:
      * nothing here mutates account data, so STATE carries only the
      * session's position -- "N0".."N2" unauthenticated with a failed
      * attempt count, "Y0" authenticated.
      *
      * The film shows the two banner lines and nothing else; the logon,
      * the bulletin and every account are documented interpretation.
      * See README.md and the spec.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
      *    See reference.cob: -std=cobol85 disables device mnemonics, so
      *    stdin must be assigned to the device path or READ blocks on a
      *    literal file named KEYBOARD. Host plumbing only.
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
       01  WS-INPUT            PIC X(240) VALUE SPACES.
       01  WS-INPUT-LEN        PIC 9(4)  VALUE 0.
       01  WS-HAVE-INPUT       PIC X     VALUE "N".
       01  WS-AUTH             PIC X     VALUE "N".
       01  WS-TRIES            PIC 9     VALUE 0.
       01  WS-TRIES-D          PIC 9.
       01  WS-TOK              PIC X(16).
       01  WS-EOF              PIC X     VALUE "N".
       01  WS-I                PIC 9(4).
       01  WS-J                PIC 9(4).
       PROCEDURE DIVISION.
       MAIN.
           OPEN INPUT SYS-IN
           PERFORM READ-LINE
           IF WS-EOF = "Y" PERFORM PROTOCOL-ERROR END-IF
           UNSTRING IN-REC DELIMITED BY ALL SPACES
               INTO WS-TOK WS-TOK WS-CMD
           END-UNSTRING
           PERFORM READ-LINE
           MOVE FUNCTION NUMVAL(IN-REC(7:4)) TO WS-STATE-N
           IF WS-STATE-N > 0
               PERFORM READ-LINE
               MOVE IN-REC(1:1) TO WS-AUTH
               MOVE FUNCTION NUMVAL(IN-REC(2:1)) TO WS-TRIES
               PERFORM VARYING WS-I FROM 2 BY 1
                       UNTIL WS-I > WS-STATE-N
                   PERFORM READ-LINE
               END-PERFORM
           END-IF
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
       RTRIM-INPUT.
      *    No FUNCTION TRIM under -std=cobol85; find the last non-space.
           MOVE 240 TO WS-J
           PERFORM UNTIL WS-J = 0 OR WS-INPUT(WS-J:1) NOT = SPACE
               SUBTRACT 1 FROM WS-J
           END-PERFORM
           MOVE WS-J TO WS-INPUT-LEN
           IF WS-INPUT-LEN = 0
               MOVE 1 TO WS-INPUT-LEN
           END-IF.
       DO-CONNECT.
           DISPLAY "SYSTEM/1 umb OK"
           DISPLAY "STATE 1"
           DISPLAY "N0"
           DISPLAY "DISPLAY 3"
           DISPLAY "UNION MARINE BANK"
           DISPLAY "SOUTHWEST REGIONAL DATA CENTER"
           DISPLAY "AUTHORIZED ACCESS ONLY - TYPE NEWS FOR SERVICE"
      -    " BULLETIN"
           DISPLAY "PROMPT LOGON:"
           DISPLAY "LINE UP"
           DISPLAY "END".
       DO-INPUT.
           IF WS-HAVE-INPUT NOT = "Y"
               PERFORM PROTOCOL-ERROR
           END-IF
           PERFORM RTRIM-INPUT
           PERFORM PROTOCOL-ERROR.
       PROTOCOL-ERROR.
           DISPLAY "SYSTEM/1 umb OK"
           DISPLAY "STATE 0"
           DISPLAY "DISPLAY 1"
           DISPLAY "PROTOCOL ERROR"
           DISPLAY "LINE DROP"
           DISPLAY "END"
           STOP RUN GIVING 1.
