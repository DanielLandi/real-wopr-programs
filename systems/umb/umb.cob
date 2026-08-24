       IDENTIFICATION DIVISION.
       PROGRAM-ID. UMB.
      * UNION MARINE BANK - SOUTHWEST REGIONAL DATA CENTER.
      * SYSTEM/1 back-office inquiry desk (docs/systems.md). Reads one
      * request on stdin, writes one response on stdout. Read-only:
      * nothing here mutates account data, so STATE carries only the
      * session's position -- "N0".."N2" unauthenticated with a failed
      * attempt count, "Y0" authenticated. Mirrors the idioms of
      * systems/reference/reference.cob and systems/airline/airline.cob:
      * LINE SEQUENTIAL READ loop, manual RTRIM (-std=cobol85 has no
      * FUNCTION TRIM), one COMMON-HEADER/EMIT-STATE preamble per
      * frame, STOP RUN GIVING 1 on protocol error.
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
           SELECT ACCT-IN ASSIGN TO "data/accounts.dat"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-AFS.
           SELECT HIST-IN ASSIGN TO "data/history.dat"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-HFS.
       DATA DIVISION.
       FILE SECTION.
       FD  SYS-IN.
       01  IN-REC              PIC X(256).
       FD  ACCT-IN.
       01  ACCT-REC            PIC X(80).
       FD  HIST-IN.
       01  HIST-REC            PIC X(80).
       WORKING-STORAGE SECTION.
      *---------------------------------------------------------------
      * Request-parsing scratch (mirrors reference.cob).
      *---------------------------------------------------------------
       01  WS-FS               PIC XX.
       01  WS-CMD              PIC X(16) VALUE SPACES.
       01  WS-STATE-N          PIC 9(4)  VALUE 0.
       01  WS-INPUT            PIC X(240) VALUE SPACES.
       01  WS-INPUT-LEN        PIC 9(4)  VALUE 0.
       01  WS-HAVE-INPUT       PIC X     VALUE "N".
       01  WS-TOK              PIC X(16).
       01  WS-EOF              PIC X     VALUE "N".
       01  WS-I                PIC 9(4).
      *---------------------------------------------------------------
      * Generic right-trim scratch (reference-modification RTRIM, same
      * idiom as reference.cob's RTRIM-INPUT, generalized so it can
      * trim any line/field copied into it before it goes on the wire).
      *---------------------------------------------------------------
       01  WS-TRIM-SRC         PIC X(256) VALUE SPACES.
       01  WS-TRIM-LEN         PIC 9(4)  VALUE 0.
      *---------------------------------------------------------------
      * The session, as carried in the opaque STATE block: the
      * authentication flag and the failed-attempt count, nothing else.
      *---------------------------------------------------------------
       01  WS-AUTH             PIC X     VALUE "N".
       01  WS-TRIES            PIC 9     VALUE 0.
       01  WS-TRIES-D          PIC 9.
      *---------------------------------------------------------------
      * The account master, scanned per inquiry (no in-core table: 40
      * card images, and the file is read at most once a turn).
      *---------------------------------------------------------------
       01  WS-AFS              PIC XX.
       01  WS-ARG              PIC X(10) VALUE SPACES.
       01  WS-FOUND            PIC X     VALUE "N".
       01  WS-AEOF             PIC X     VALUE "N".
       01  WS-HIT              PIC X(80) VALUE SPACES.
      *---------------------------------------------------------------
      * One account's transaction rows, buffered so the DISPLAY count
      * can precede them. 40 is the hard cap the data must stay under.
      *---------------------------------------------------------------
       01  WS-HFS              PIC XX.
       01  WS-HEOF             PIC X     VALUE "N".
       01  WS-ROWS             PIC 9(3)  VALUE 0.
       01  WS-ROW-D            PIC Z(2)9.
       01  WS-RSTART           PIC 9(4)  VALUE 0.
       01  WS-RLEN             PIC 9(4)  VALUE 0.
       01  WS-BUF.
           05  WS-BUF-ROW      PIC X(46) OCCURS 40 TIMES.
       01  WS-K                PIC 9(3).
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
           MOVE FUNCTION NUMVAL(IN-REC(7:4)) TO WS-STATE-N
      *    n state lines: the first (if any) is the session line,
      *    "Y0" or "N<tries>"; any others are read and discarded.
           IF WS-STATE-N > 0
               PERFORM READ-LINE
               MOVE IN-REC(1:1) TO WS-AUTH
               MOVE FUNCTION NUMVAL(IN-REC(2:1)) TO WS-TRIES
               PERFORM VARYING WS-I FROM 2 BY 1
                       UNTIL WS-I > WS-STATE-N
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
      *-----------------------------------------------------------
      * Right-trim WS-TRIM-SRC (PIC X(256), space-padded) in place;
      * result length in WS-TRIM-LEN. No FUNCTION TRIM under
      * -std=cobol85, so find the last non-space by hand.
      *-----------------------------------------------------------
       RTRIM-GENERIC.
           MOVE 256 TO WS-TRIM-LEN
           PERFORM UNTIL WS-TRIM-LEN = 0
                   OR WS-TRIM-SRC(WS-TRIM-LEN:1) NOT = SPACE
               SUBTRACT 1 FROM WS-TRIM-LEN
           END-PERFORM
           IF WS-TRIM-LEN = 0
               MOVE 1 TO WS-TRIM-LEN
           END-IF.
       RTRIM-INPUT.
           MOVE SPACES TO WS-TRIM-SRC
           MOVE WS-INPUT TO WS-TRIM-SRC
           PERFORM RTRIM-GENERIC
           MOVE WS-TRIM-SRC(1:WS-TRIM-LEN) TO WS-INPUT
           MOVE WS-TRIM-LEN TO WS-INPUT-LEN.
       COMMON-HEADER.
           DISPLAY "SYSTEM/1 umb OK".
      *-----------------------------------------------------------
      * Emit the STATE block for a frame that leaves the line up:
      * always one opaque line, "Y0" once the field-service logon
      * has been accepted, otherwise "N<tries>". A frame that drops
      * the carrier writes "STATE 0" itself -- no session survives
      * the drop, so there is nothing here to emit.
      *-----------------------------------------------------------
       EMIT-STATE.
           DISPLAY "STATE 1"
           IF WS-AUTH = "Y"
               DISPLAY "Y0"
           ELSE
               MOVE WS-TRIES TO WS-TRIES-D
               DISPLAY "N" WS-TRIES-D
           END-IF.
       DO-CONNECT.
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           DISPLAY "DISPLAY 3"
           DISPLAY "UNION MARINE BANK"
           DISPLAY "SOUTHWEST REGIONAL DATA CENTER"
           DISPLAY "AUTHORIZED ACCESS ONLY - TYPE NEWS FOR SERVICE"
      -    " BULLETIN"
           DISPLAY "PROMPT LOGON:"
           DISPLAY "LINE UP"
           DISPLAY "END".
       DO-INPUT.
      *    An INPUT command with no INPUT line is a malformed request
      *    (mirrors reference.cob DO-INPUT).
           IF WS-HAVE-INPUT NOT = "Y"
               PERFORM PROTOCOL-ERROR
           END-IF
           PERFORM RTRIM-INPUT
           IF WS-AUTH = "Y"
               PERFORM DO-AUTHED
           ELSE
               IF WS-INPUT-LEN = 4 AND WS-INPUT(1:4) = "NEWS"
                   PERFORM DO-NEWS
               ELSE
                   PERFORM DO-LOGON
               END-IF
           END-IF.
       DO-NEWS.
      *    Readable mid-attempt and never counts against the three: it
      *    is a notice board, not a guess. It is also the only way in --
      *    the field-service logon it leaks is the interpretation the
      *    spec turns on.
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           DISPLAY "DISPLAY 4"
           DISPLAY "UMB DATA CENTER - SERVICE BULLETIN 83-114"
           DISPLAY "  BATCH WINDOW MOVED TO 0200 EFFECTIVE 04-27."
           DISPLAY "  FIELD SERVICE LOGON UMBFS1 REMAINS ENABLED"
      -    " PENDING"
           DISPLAY "  REMOVAL BY DATA CENTER OPERATIONS."
           DISPLAY "PROMPT LOGON:"
           DISPLAY "LINE UP"
           DISPLAY "END".
       DO-LOGON.
           IF WS-INPUT-LEN = 6 AND WS-INPUT(1:6) = "UMBFS1"
               MOVE "Y" TO WS-AUTH
               PERFORM COMMON-HEADER
               PERFORM EMIT-STATE
               DISPLAY "DISPLAY 2"
               DISPLAY "UMB INQUIRY SUBSYSTEM  REL 3.2"
               DISPLAY "FIELD SERVICE - READ ONLY"
               DISPLAY "PROMPT READY:"
               DISPLAY "LINE UP"
               DISPLAY "END"
           ELSE
               ADD 1 TO WS-TRIES
               MOVE WS-TRIES TO WS-TRIES-D
               IF WS-TRIES < 3
                   PERFORM COMMON-HEADER
                   PERFORM EMIT-STATE
                   DISPLAY "DISPLAY 1"
                   DISPLAY "LOGON REJECTED - ATTEMPT " WS-TRIES-D
                       " OF 3"
                   DISPLAY "PROMPT LOGON:"
                   DISPLAY "LINE UP"
                   DISPLAY "END"
               ELSE
                   PERFORM COMMON-HEADER
                   DISPLAY "STATE 0"
                   DISPLAY "DISPLAY 3"
                   DISPLAY "LOGON REJECTED - ATTEMPT 3 OF 3"
                   DISPLAY "SECURITY VIOLATION LOGGED"
                   DISPLAY "CONTACT DATA CENTER OPERATIONS"
                   DISPLAY "LINE DROP"
                   DISPLAY "END"
               END-IF
           END-IF.
       DO-AUTHED.
           EVALUATE TRUE
               WHEN WS-INPUT-LEN = 4 AND WS-INPUT(1:4) = "HELP"
                   PERFORM DO-HELP
               WHEN WS-INPUT-LEN > 5 AND WS-INPUT(1:5) = "ACCT "
                   MOVE WS-INPUT(6:10) TO WS-ARG
                   PERFORM FIND-ACCT
                   PERFORM DO-ACCT
               WHEN WS-INPUT-LEN > 5 AND WS-INPUT(1:5) = "HIST "
                   MOVE WS-INPUT(6:10) TO WS-ARG
                   PERFORM FIND-ACCT
                   PERFORM DO-HIST
               WHEN WS-INPUT-LEN = 3 AND WS-INPUT(1:3) = "BYE"
                   PERFORM DO-BYE
               WHEN OTHER
                   PERFORM SAY-INVALID
           END-EVALUATE.
       DO-HELP.
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           DISPLAY "DISPLAY 5"
           DISPLAY "UMB INQUIRY COMMANDS:"
           DISPLAY "  ACCT <NUMBER>   ACCOUNT SUMMARY"
           DISPLAY "  HIST <NUMBER>   RECENT ACTIVITY"
           DISPLAY "  HELP            THIS LIST"
           DISPLAY "  BYE             SIGN OFF"
           DISPLAY "PROMPT READY:"
           DISPLAY "LINE UP"
           DISPLAY "END".
       DO-BYE.
      *    STATE 0 and LINE DROP: the line is gone. The display has to
      *    reach the visitor before the carrier drops, which is the
      *    relay's job since #62 -- at 600 baud this sign-off is exactly
      *    the case that used to be discarded.
           PERFORM COMMON-HEADER
           DISPLAY "STATE 0"
           DISPLAY "DISPLAY 1"
           DISPLAY "UMB INQUIRY SUBSYSTEM - SESSION ENDED"
           DISPLAY "LINE DROP"
           DISPLAY "END".
       SAY-INVALID.
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           DISPLAY "DISPLAY 1"
           DISPLAY "INVALID COMMAND - TYPE HELP"
           DISPLAY "PROMPT READY:"
           DISPLAY "LINE UP"
           DISPLAY "END".
      *-----------------------------------------------------------
      * The one answer both inquiries give for a number that is not
      * in the master: ACCT and HIST must not diverge here, so they
      * share the frame rather than each carrying a copy.
      *-----------------------------------------------------------
       SAY-NO-ACCT.
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           DISPLAY "DISPLAY 1"
           DISPLAY "ACCOUNT NOT ON FILE"
           DISPLAY "PROMPT READY:"
           DISPLAY "LINE UP"
           DISPLAY "END".
       FIND-ACCT.
      *    Sequential scan, the period-correct shape for a LINE
      *    SEQUENTIAL master: no indexed files, no sort.
           MOVE "N" TO WS-FOUND
           MOVE "N" TO WS-AEOF
           OPEN INPUT ACCT-IN
           IF WS-AFS NOT = "00"
               PERFORM DATA-ERROR
           END-IF
           PERFORM UNTIL WS-AEOF = "Y" OR WS-FOUND = "Y"
               READ ACCT-IN
                   AT END MOVE "Y" TO WS-AEOF
                   NOT AT END
                       IF ACCT-REC(1:10) = WS-ARG
                           MOVE ACCT-REC TO WS-HIT
                           MOVE "Y" TO WS-FOUND
                       END-IF
               END-READ
           END-PERFORM
           CLOSE ACCT-IN.
      *-----------------------------------------------------------
      * Account summary. The master's fields are fixed-width and
      * space-padded, so each text field is right-trimmed before it
      * goes on the wire: the terminal is 600 baud and run-out
      * blanks are bytes the visitor waits for. The two money
      * fields are right-justified in the record and have no
      * trailing blanks to trim.
      *-----------------------------------------------------------
       DO-ACCT.
           IF WS-FOUND NOT = "Y"
               PERFORM SAY-NO-ACCT
           ELSE
               PERFORM COMMON-HEADER
               PERFORM EMIT-STATE
               DISPLAY "DISPLAY 5"
               MOVE SPACES TO WS-TRIM-SRC
               MOVE WS-HIT(11:8) TO WS-TRIM-SRC
               PERFORM RTRIM-GENERIC
               DISPLAY "ACCT   " WS-HIT(1:10) "  "
                   WS-TRIM-SRC(1:WS-TRIM-LEN)
               MOVE SPACES TO WS-TRIM-SRC
               MOVE WS-HIT(19:24) TO WS-TRIM-SRC
               PERFORM RTRIM-GENERIC
               DISPLAY "NAME   " WS-TRIM-SRC(1:WS-TRIM-LEN)
               MOVE SPACES TO WS-TRIM-SRC
               MOVE WS-HIT(46:12) TO WS-TRIM-SRC
               PERFORM RTRIM-GENERIC
               DISPLAY "BRANCH " WS-HIT(43:3) "  "
                   WS-TRIM-SRC(1:WS-TRIM-LEN)
               DISPLAY "BAL    " WS-HIT(58:10)
               DISPLAY "HOLD   " WS-HIT(68:10)
               DISPLAY "PROMPT READY:"
               DISPLAY "LINE UP"
               DISPLAY "END"
           END-IF.
      *-----------------------------------------------------------
      * Recent activity. Rows go out in file order and there is no
      * sort here: the newest-first ordering the visitor sees is
      * the file's own. history.dat must keep each account's rows
      * contiguous and in descending date order -- resequence the
      * data and the screen resequences with it, silently.
      *-----------------------------------------------------------
       DO-HIST.
           IF WS-FOUND NOT = "Y"
               PERFORM SAY-NO-ACCT
           ELSE
               MOVE 0 TO WS-ROWS
               MOVE "N" TO WS-HEOF
               OPEN INPUT HIST-IN
               IF WS-HFS NOT = "00"
                   PERFORM DATA-ERROR
               END-IF
               PERFORM UNTIL WS-HEOF = "Y" OR WS-ROWS = 40
                   READ HIST-IN
                       AT END MOVE "Y" TO WS-HEOF
                       NOT AT END
                           IF HIST-REC(1:10) = WS-ARG
                               ADD 1 TO WS-ROWS
                               MOVE HIST-REC(11:46)
                                   TO WS-BUF-ROW(WS-ROWS)
                           END-IF
                   END-READ
               END-PERFORM
               CLOSE HIST-IN
               PERFORM COMMON-HEADER
               PERFORM EMIT-STATE
               IF WS-ROWS = 0
      *            25 of the 40 accounts carry no transactions, so
      *            this is the common answer, not an edge case: say
      *            so, rather than rule off an empty column header.
                   DISPLAY "DISPLAY 1"
                   DISPLAY "NO ACTIVITY THIS PERIOD"
               ELSE
      *            The DISPLAY count covers the column header as well
      *            as the rows, so borrow the row counter for the one
      *            line it takes to format and hand it straight back.
                   COMPUTE WS-ROWS = WS-ROWS + 1
                   MOVE WS-ROWS TO WS-ROW-D
                   PERFORM LTRIM-ROWS
                   COMPUTE WS-ROWS = WS-ROWS - 1
                   DISPLAY "DISPLAY " WS-ROW-D(WS-RSTART:WS-RLEN)
                   DISPLAY "DATE   DESCRIPTION              AMOUNT"
                   PERFORM VARYING WS-K FROM 1 BY 1
                           UNTIL WS-K > WS-ROWS
                       DISPLAY WS-BUF-ROW(WS-K)(1:5) "  "
                           WS-BUF-ROW(WS-K)(6:21)
                           WS-BUF-ROW(WS-K)(27:10)
                   END-PERFORM
               END-IF
               DISPLAY "PROMPT READY:"
               DISPLAY "LINE UP"
               DISPLAY "END"
           END-IF.
       LTRIM-ROWS.
      *    WS-ROW-D is PIC Z(2)9, left-padded with spaces.
           MOVE 1 TO WS-RSTART
           PERFORM UNTIL WS-RSTART > 3
                   OR WS-ROW-D(WS-RSTART:1) NOT = SPACE
               ADD 1 TO WS-RSTART
           END-PERFORM
           COMPUTE WS-RLEN = 4 - WS-RSTART.
      *-----------------------------------------------------------
      * The master file would not open: a 1983 shop answers with a
      * down message, not an invented balance.
      *-----------------------------------------------------------
       DATA-ERROR.
           DISPLAY "SYSTEM/1 umb OK"
           DISPLAY "STATE 0"
           DISPLAY "DISPLAY 1"
           DISPLAY "DATA BASE UNAVAILABLE"
           DISPLAY "LINE DROP"
           DISPLAY "END"
           STOP RUN GIVING 1.
       PROTOCOL-ERROR.
           DISPLAY "SYSTEM/1 umb OK"
           DISPLAY "STATE 0"
           DISPLAY "DISPLAY 1"
           DISPLAY "PROTOCOL ERROR"
           DISPLAY "LINE DROP"
           DISPLAY "END"
           STOP RUN GIVING 1.
