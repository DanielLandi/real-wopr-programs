       IDENTIFICATION DIVISION.
       PROGRAM-ID. AIRLINE.
      * PANAMAC reservations system (docs/systems.md, SYSTEM/1). Reads
      * one SYSTEM/1 request on stdin, writes one response on stdout.
      * Stateless per invocation; the working PNR (AVAIL/SEG/NAME) is
      * carried turn to turn in the opaque STATE block. Mirrors the
      * idioms of systems/reference/reference.cob: LINE SEQUENTIAL
      * READ loop, manual RTRIM/LTRIM (-std=cobol85 has no FUNCTION
      * TRIM), STOP RUN GIVING 1 on protocol error.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
      *    See reference.cob: GnuCOBOL's -std=cobol85 disables device
      *    mnemonics, so ASSIGN TO "/dev/stdin" is required to read
      *    redirected stdin instead of blocking on a literal KEYBOARD
      *    file. Host plumbing only; does not touch the wire format.
           SELECT SYS-IN ASSIGN TO "/dev/stdin"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-FS.
       DATA DIVISION.
       FILE SECTION.
       FD  SYS-IN.
       01  IN-REC              PIC X(256).
       WORKING-STORAGE SECTION.
      *---------------------------------------------------------------
      * Request-parsing scratch (mirrors reference.cob).
      *---------------------------------------------------------------
       01  WS-FS               PIC XX.
       01  WS-CMD              PIC X(16) VALUE SPACES.
       01  WS-STATE-N          PIC 9(4)  VALUE 0.
       01  WS-INPUT            PIC X(240) VALUE SPACES.
       01  WS-INPUT-LEN        PIC 9(4)  VALUE 0.
       01  WS-HAVE-INPUT       PIC X VALUE "N".
       01  WS-TOK              PIC X(16).
       01  WS-EOF              PIC X VALUE "N".
       01  WS-I                PIC 9(4).
       01  WS-J                PIC 9(4).
       01  WS-K                PIC 9(4).
      *---------------------------------------------------------------
      * Generic right-trim scratch (reference-modification RTRIM,
      * same idiom as reference.cob's RTRIM-INPUT, generalized so it
      * can trim any line/substring copied into it).
      *---------------------------------------------------------------
       01  WS-TRIM-SRC         PIC X(256) VALUE SPACES.
       01  WS-TRIM-LEN         PIC 9(4)  VALUE 0.
      *---------------------------------------------------------------
      * Generic small-number-to-trimmed-text scratch (LTRIM, same
      * idiom as reference.cob's LTRIM-COUNTER, generalized).
      *---------------------------------------------------------------
       01  WS-FMT-SRC          PIC 9(4)  VALUE 0.
       01  WS-FMT-ND           PIC Z(3)9.
       01  WS-FMT-START        PIC 9(2).
       01  WS-FMT-LEN          PIC 9(2).
       01  WS-FMT-STR          PIC X(4)  VALUE SPACES.
      *---------------------------------------------------------------
      * The working PNR (the opaque STATE, parsed/held here for the
      * turn). AVAIL/SEG are single opaque tagged lines; NAME is a
      * small table of tagged lines, 0..20.
      *---------------------------------------------------------------
       01  WS-HAVE-AVAIL       PIC X VALUE "N".
       01  WS-AVAIL-PAIR       PIC X(6) VALUE SPACES.
       01  WS-HAVE-SEG         PIC X VALUE "N".
       01  WS-SEG-FLT          PIC X(5) VALUE SPACES.
       01  WS-SEG-CLASS        PIC X VALUE SPACE.
       01  WS-SEG-NN           PIC X(2) VALUE SPACES.
       01  WS-NUM-NAMES        PIC 9(2) VALUE 0.
       01  WS-NAMES-TABLE.
           05  WS-NAME         OCCURS 20 TIMES PIC X(60) VALUE SPACES.
       01  WS-NAME-LENS.
           05  WS-NAME-L       OCCURS 20 TIMES PIC 9(4) VALUE 0.
      *---------------------------------------------------------------
      * Embedded fixed flight schedule: 3 city pairs x 2 flights.
      * Populated once by SETUP-SCHEDULE (explicit MOVEs rather than
      * a packed REDEFINES literal, to keep each field's width an
      * unambiguous, individually-checkable constant).
      *---------------------------------------------------------------
       01  WS-SCHEDULE.
           05  WS-PAIR OCCURS 3 TIMES.
               10  WS-PAIR-CODE     PIC X(6).
               10  WS-PAIR-ORIG     PIC X(3).
               10  WS-PAIR-DEST     PIC X(3).
               10  WS-FLIGHT OCCURS 2 TIMES.
                   15  WS-FLT-KEY      PIC X(5).
                   15  WS-FLT-DISP     PIC X(6).
                   15  WS-FLT-DEP      PIC X(4).
                   15  WS-FLT-ARR      PIC X(6).
                   15  WS-FLT-ARR-LEN  PIC 9.
                   15  WS-FLT-SEATS    PIC X(8).
      *---------------------------------------------------------------
      * Command-dispatch and per-command scratch.
      *---------------------------------------------------------------
       01  WS-CMD-TYPE         PIC X(10) VALUE SPACES.
       01  WS-PX               PIC 9(2) VALUE 0.
       01  WS-FX               PIC 9(2) VALUE 0.
       01  WS-FOUND            PIC X VALUE "N".
       01  WS-FOUND-PX         PIC 9(2) VALUE 0.
       01  WS-FOUND-FX         PIC 9(2) VALUE 0.
       01  WS-CITYPAIR         PIC X(6) VALUE SPACES.
       01  WS-LINE-CH          PIC X VALUE SPACE.
       01  WS-AVAIL-LINE       PIC X(60) VALUE SPACES.
       01  WS-AVAIL-PTR        PIC 9(4).
       01  WS-AVAIL-LEN        PIC 9(4).
       01  WS-SELL-LINE        PIC X(31) VALUE SPACES.
       01  WS-RECORD-DISP-N    PIC 9(4).
      *---------------------------------------------------------------
      * Deterministic record-locator hash.
      *---------------------------------------------------------------
      * Sized to exceed the worst case within the 20-name cap: the
      * 5-char flight key plus 20 x the 60-char WS-NAME field = 1205
      * bytes, so X(1300) cannot truncate a legal PNR (the STRINGs
      * below also carry ON OVERFLOW as belt-and-suspenders). A too-
      * small buffer here silently drops trailing names and collides
      * distinct PNRs onto one locator — the bug this fixes.
       01  WS-HASHIN           PIC X(1300) VALUE SPACES.
       01  WS-HASHIN-LEN       PIC 9(4)  VALUE 0.
       01  WS-HASHIN-PTR       PIC 9(4).
       01  WS-HASH             PIC 9(15) VALUE 0.
       01  WS-HASH-DIGIT       PIC 9(2)  VALUE 0.
       01  WS-CH-CODE          PIC 9(5)  VALUE 0.
       01  WS-LOCATOR          PIC X(6)  VALUE SPACES.
       01  WS-B32-ALPHABET     PIC X(32)
               VALUE "23456789ABCDEFGHJKLMNPQRSTUVWXYZ".
       PROCEDURE DIVISION.
       MAIN.
           PERFORM SETUP-SCHEDULE
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
      *    n tagged PNR lines (AVAIL/SEG/NAME), parsed as they arrive.
           IF WS-STATE-N > 0
               PERFORM VARYING WS-I FROM 1 BY 1 UNTIL WS-I > WS-STATE-N
                   PERFORM READ-LINE
                   PERFORM PARSE-STATE-LINE
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
      * One-time schedule population. 3 city pairs, 2 flights each.
      * WS-FLT-ARR is right-padded to 6; WS-FLT-ARR-LEN records the
      * true length (4 for a same-day arrival, 6 for "+1" red-eyes)
      * so display construction can trim it without a rescan.
      *-----------------------------------------------------------
       SETUP-SCHEDULE.
           MOVE "JFKPAR" TO WS-PAIR-CODE(1)
           MOVE "JFK"    TO WS-PAIR-ORIG(1)
           MOVE "ORY"    TO WS-PAIR-DEST(1)
           MOVE "PA002"    TO WS-FLT-KEY(1,1)
           MOVE "PA 002"   TO WS-FLT-DISP(1,1)
           MOVE "1900"     TO WS-FLT-DEP(1,1)
           MOVE "0810+1"   TO WS-FLT-ARR(1,1)
           MOVE 6          TO WS-FLT-ARR-LEN(1,1)
           MOVE "F4 C6 Y9" TO WS-FLT-SEATS(1,1)
           MOVE "PA120"    TO WS-FLT-KEY(1,2)
           MOVE "PA 120"   TO WS-FLT-DISP(1,2)
           MOVE "2100"     TO WS-FLT-DEP(1,2)
           MOVE "1010+1"   TO WS-FLT-ARR(1,2)
           MOVE 6          TO WS-FLT-ARR-LEN(1,2)
           MOVE "F2 C4 Y7" TO WS-FLT-SEATS(1,2)
           MOVE "JFKLHR" TO WS-PAIR-CODE(2)
           MOVE "JFK"    TO WS-PAIR-ORIG(2)
           MOVE "LHR"    TO WS-PAIR-DEST(2)
           MOVE "PA100"    TO WS-FLT-KEY(2,1)
           MOVE "PA 100"   TO WS-FLT-DISP(2,1)
           MOVE "0800"     TO WS-FLT-DEP(2,1)
           MOVE "2000  "   TO WS-FLT-ARR(2,1)
           MOVE 4          TO WS-FLT-ARR-LEN(2,1)
           MOVE "F6 C8 Y9" TO WS-FLT-SEATS(2,1)
           MOVE "PA106"    TO WS-FLT-KEY(2,2)
           MOVE "PA 106"   TO WS-FLT-DISP(2,2)
           MOVE "1800"     TO WS-FLT-DEP(2,2)
           MOVE "0600+1"   TO WS-FLT-ARR(2,2)
           MOVE 6          TO WS-FLT-ARR-LEN(2,2)
           MOVE "F4 C6 Y9" TO WS-FLT-SEATS(2,2)
           MOVE "LAXJFK" TO WS-PAIR-CODE(3)
           MOVE "LAX"    TO WS-PAIR-ORIG(3)
           MOVE "JFK"    TO WS-PAIR-DEST(3)
           MOVE "PA400"    TO WS-FLT-KEY(3,1)
           MOVE "PA 400"   TO WS-FLT-DISP(3,1)
           MOVE "0700"     TO WS-FLT-DEP(3,1)
           MOVE "1520  "   TO WS-FLT-ARR(3,1)
           MOVE 4          TO WS-FLT-ARR-LEN(3,1)
           MOVE "F4 C6 Y9" TO WS-FLT-SEATS(3,1)
           MOVE "PA440"    TO WS-FLT-KEY(3,2)
           MOVE "PA 440"   TO WS-FLT-DISP(3,2)
           MOVE "1300"     TO WS-FLT-DEP(3,2)
           MOVE "2115  "   TO WS-FLT-ARR(3,2)
           MOVE 4          TO WS-FLT-ARR-LEN(3,2)
           MOVE "F2 C4 Y7" TO WS-FLT-SEATS(3,2).
      *-----------------------------------------------------------
      * Parse one already-read STATE line (IN-REC) by its leading
      * tag (AVAIL/SEG/NAME) into the working PNR fields.
      *-----------------------------------------------------------
       PARSE-STATE-LINE.
           MOVE 1 TO WS-J
           PERFORM UNTIL WS-J > 256 OR IN-REC(WS-J:1) = SPACE
               ADD 1 TO WS-J
           END-PERFORM
           IF WS-J > 256
               MOVE 256 TO WS-J
           END-IF
           MOVE SPACES TO WS-TOK
           MOVE IN-REC(1:WS-J - 1) TO WS-TOK
           EVALUATE WS-TOK
               WHEN "AVAIL"
                   MOVE IN-REC(WS-J + 1:6) TO WS-AVAIL-PAIR
                   MOVE "Y" TO WS-HAVE-AVAIL
               WHEN "SEG"
                   UNSTRING IN-REC(WS-J + 1:256 - WS-J)
                       DELIMITED BY ALL SPACES
                       INTO WS-SEG-FLT WS-SEG-CLASS WS-SEG-NN
                   END-UNSTRING
                   MOVE "Y" TO WS-HAVE-SEG
               WHEN "NAME"
                   IF WS-NUM-NAMES < 20
                       ADD 1 TO WS-NUM-NAMES
                       MOVE SPACES TO WS-TRIM-SRC
                       MOVE IN-REC(WS-J + 1:256 - WS-J) TO WS-TRIM-SRC
                       PERFORM RTRIM-GENERIC
                       MOVE WS-TRIM-SRC(1:WS-TRIM-LEN)
                           TO WS-NAME(WS-NUM-NAMES)
                       MOVE WS-TRIM-LEN TO WS-NAME-L(WS-NUM-NAMES)
                   END-IF
               WHEN OTHER
                   CONTINUE
           END-EVALUATE.
      *-----------------------------------------------------------
      * Right-trim WS-TRIM-SRC (PIC X(256), space-padded) in place;
      * result length in WS-TRIM-LEN. Same idiom as reference.cob's
      * RTRIM-INPUT, generalized to any scratch line.
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
      *-----------------------------------------------------------
      * Left-trim a zero-suppressed small number (0-9999) into
      * WS-FMT-STR(1:WS-FMT-LEN). Same idiom as reference.cob's
      * LTRIM-COUNTER, generalized over WS-FMT-SRC.
      *-----------------------------------------------------------
       FORMAT-NUM.
           MOVE WS-FMT-SRC TO WS-FMT-ND
           MOVE 1 TO WS-FMT-START
           PERFORM UNTIL WS-FMT-START > 4
                   OR WS-FMT-ND(WS-FMT-START:1) NOT = SPACE
               ADD 1 TO WS-FMT-START
           END-PERFORM
           IF WS-FMT-START > 4
               MOVE 4 TO WS-FMT-START
           END-IF
           COMPUTE WS-FMT-LEN = 5 - WS-FMT-START
           MOVE WS-FMT-ND(WS-FMT-START:WS-FMT-LEN) TO WS-FMT-STR.
       DO-CONNECT.
           MOVE "N" TO WS-HAVE-AVAIL
           MOVE "N" TO WS-HAVE-SEG
           MOVE 0 TO WS-NUM-NAMES
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           DISPLAY "DISPLAY 3"
           DISPLAY "PAN AMERICAN WORLD AIRWAYS"
           DISPLAY "PANAMAC RESERVATIONS"
           DISPLAY "AGENT SET READY - TYPE HELP FOR COMMANDS"
           DISPLAY "LINE UP"
           DISPLAY "END".
       DO-INPUT.
      *    An INPUT command with no INPUT line is a malformed request
      *    (mirrors reference.cob DO-INPUT).
           IF WS-HAVE-INPUT NOT = "Y"
               PERFORM PROTOCOL-ERROR
           END-IF
           PERFORM RTRIM-INPUT
           PERFORM DETERMINE-COMMAND
           EVALUATE WS-CMD-TYPE
               WHEN "AVAIL"    PERFORM DO-AVAIL
               WHEN "SELL"     PERFORM DO-SELL
               WHEN "NAME"     PERFORM DO-NAME
               WHEN "RECORD"   PERFORM DO-RECORD
               WHEN "ENDXN"    PERFORM DO-ENDXN
               WHEN "IGNORE"   PERFORM DO-IGNORE
               WHEN "SIGNOFF"  PERFORM DO-SIGNOFF
               WHEN "HELP"     PERFORM DO-HELP
               WHEN OTHER      PERFORM DO-INVALID
           END-EVALUATE.
       RTRIM-INPUT.
           MOVE SPACES TO WS-TRIM-SRC
           MOVE WS-INPUT TO WS-TRIM-SRC
           PERFORM RTRIM-GENERIC
           MOVE WS-TRIM-SRC(1:WS-TRIM-LEN) TO WS-INPUT
           MOVE WS-TRIM-LEN TO WS-INPUT-LEN.
      *-----------------------------------------------------------
      * Classify the trimmed WS-INPUT(1:WS-INPUT-LEN) into a command
      * type. First match wins; anything unmatched is INVALID.
      *-----------------------------------------------------------
       DETERMINE-COMMAND.
           EVALUATE TRUE
               WHEN WS-INPUT-LEN = 1 AND WS-INPUT(1:1) = "E"
                   MOVE "ENDXN" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN = 1 AND WS-INPUT(1:1) = "I"
                   MOVE "IGNORE" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN = 2 AND WS-INPUT(1:2) = "SO"
                   MOVE "SIGNOFF" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN = 2 AND WS-INPUT(1:2) = "*R"
                   MOVE "RECORD" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN = 4 AND WS-INPUT(1:4) = "HELP"
                   MOVE "HELP" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN >= 7 AND WS-INPUT(1:1) = "A"
                   MOVE "AVAIL" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN = 4 AND WS-INPUT(1:2) IS NUMERIC
                   AND (WS-INPUT(3:1) = "F" OR WS-INPUT(3:1) = "C"
                        OR WS-INPUT(3:1) = "Y")
                   AND (WS-INPUT(4:1) = "1" OR WS-INPUT(4:1) = "2")
                   MOVE "SELL" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN >= 2 AND WS-INPUT(1:1) = "-"
                   MOVE "NAME" TO WS-CMD-TYPE
               WHEN OTHER
                   MOVE "INVALID" TO WS-CMD-TYPE
           END-EVALUATE.
       DO-AVAIL.
           COMPUTE WS-K = WS-INPUT-LEN - 5
           MOVE WS-INPUT(WS-K:6) TO WS-CITYPAIR
           MOVE "N" TO WS-FOUND
           MOVE 0 TO WS-PX
           PERFORM VARYING WS-I FROM 1 BY 1 UNTIL WS-I > 3
               IF WS-PAIR-CODE(WS-I) = WS-CITYPAIR
                   MOVE WS-I TO WS-PX
                   MOVE "Y" TO WS-FOUND
               END-IF
           END-PERFORM
           IF WS-FOUND = "N"
               PERFORM DO-INVALID
           ELSE
               MOVE "Y" TO WS-HAVE-AVAIL
               MOVE WS-CITYPAIR TO WS-AVAIL-PAIR
               MOVE 1 TO WS-FX
               MOVE "1" TO WS-LINE-CH
               PERFORM BUILD-AVAIL-LINE
               PERFORM COMMON-HEADER
               PERFORM EMIT-STATE
               DISPLAY "DISPLAY 4"
               DISPLAY "** PANAMAC AVAILABILITY **"
               DISPLAY WS-PAIR-ORIG(WS-PX) "-" WS-PAIR-DEST(WS-PX)
               DISPLAY WS-AVAIL-LINE(1:WS-AVAIL-LEN)
               MOVE 2 TO WS-FX
               MOVE "2" TO WS-LINE-CH
               PERFORM BUILD-AVAIL-LINE
               DISPLAY WS-AVAIL-LINE(1:WS-AVAIL-LEN)
               DISPLAY "LINE UP"
               DISPLAY "END"
           END-IF.
      *-----------------------------------------------------------
      * Build one availability line ("1  PA 002  JFK 1900  ORY
      * 0810+1  F4 C6 Y9") for WS-PAIR(WS-PX)/WS-FLIGHT(WS-FX) with
      * leading line number WS-LINE-CH, into WS-AVAIL-LINE(1:WS-
      * AVAIL-LEN). The arrival-time field is variable width (4 for
      * same-day, 6 for a "+1" red-eye), so the pointer form of
      * STRING tracks the true output length.
      *-----------------------------------------------------------
       BUILD-AVAIL-LINE.
           MOVE 1 TO WS-AVAIL-PTR
           STRING WS-LINE-CH DELIMITED BY SIZE
               "  " DELIMITED BY SIZE
               WS-FLT-DISP(WS-PX, WS-FX) DELIMITED BY SIZE
               "  " DELIMITED BY SIZE
               WS-PAIR-ORIG(WS-PX) DELIMITED BY SIZE
               " " DELIMITED BY SIZE
               WS-FLT-DEP(WS-PX, WS-FX) DELIMITED BY SIZE
               "  " DELIMITED BY SIZE
               WS-PAIR-DEST(WS-PX) DELIMITED BY SIZE
               " " DELIMITED BY SIZE
               WS-FLT-ARR(WS-PX, WS-FX)
                   (1:WS-FLT-ARR-LEN(WS-PX, WS-FX)) DELIMITED BY SIZE
               "  " DELIMITED BY SIZE
               WS-FLT-SEATS(WS-PX, WS-FX) DELIMITED BY SIZE
               INTO WS-AVAIL-LINE
               WITH POINTER WS-AVAIL-PTR
           END-STRING
           COMPUTE WS-AVAIL-LEN = WS-AVAIL-PTR - 1.
       DO-SELL.
           IF WS-HAVE-AVAIL NOT = "Y" OR WS-HAVE-SEG = "Y"
               PERFORM DO-INVALID
           ELSE
               MOVE "N" TO WS-FOUND
               MOVE 0 TO WS-PX
               PERFORM VARYING WS-I FROM 1 BY 1 UNTIL WS-I > 3
                   IF WS-PAIR-CODE(WS-I) = WS-AVAIL-PAIR
                       MOVE WS-I TO WS-PX
                       MOVE "Y" TO WS-FOUND
                   END-IF
               END-PERFORM
               IF WS-FOUND = "N"
                   PERFORM DO-INVALID
               ELSE
                   IF WS-INPUT(4:1) = "1"
                       MOVE 1 TO WS-FX
                   ELSE
                       MOVE 2 TO WS-FX
                   END-IF
                   MOVE WS-FLT-KEY(WS-PX, WS-FX) TO WS-SEG-FLT
                   MOVE WS-INPUT(3:1) TO WS-SEG-CLASS
                   MOVE WS-INPUT(1:2) TO WS-SEG-NN
                   MOVE "Y" TO WS-HAVE-SEG
                   STRING "1  " DELIMITED BY SIZE
                       WS-FLT-DISP(WS-PX, WS-FX) DELIMITED BY SIZE
                       "  " DELIMITED BY SIZE
                       WS-PAIR-ORIG(WS-PX) DELIMITED BY SIZE
                       "-" DELIMITED BY SIZE
                       WS-PAIR-DEST(WS-PX) DELIMITED BY SIZE
                       "  " DELIMITED BY SIZE
                       WS-SEG-CLASS DELIMITED BY SIZE
                       "  " DELIMITED BY SIZE
                       WS-SEG-NN DELIMITED BY SIZE
                       " SEATS" DELIMITED BY SIZE
                       INTO WS-SELL-LINE
                   END-STRING
                   PERFORM COMMON-HEADER
                   PERFORM EMIT-STATE
                   DISPLAY "DISPLAY 2"
                   DISPLAY "SEGMENT ADDED"
                   DISPLAY WS-SELL-LINE
                   DISPLAY "LINE UP"
                   DISPLAY "END"
               END-IF
           END-IF.
      *    WS-NAME is OCCURS 20; a 21st name would index out of bounds
      *    (undefined behavior). Guard the add here just as
      *    PARSE-STATE-LINE guards its own inserts: at the cap, write
      *    nothing, leave the PNR unchanged, and report NAME LIMIT
      *    REACHED with LINE UP.
       DO-NAME.
           IF WS-NUM-NAMES >= 20
               PERFORM COMMON-HEADER
               PERFORM EMIT-STATE
               DISPLAY "DISPLAY 1"
               DISPLAY "NAME LIMIT REACHED"
               DISPLAY "LINE UP"
               DISPLAY "END"
           ELSE
               ADD 1 TO WS-NUM-NAMES
               COMPUTE WS-NAME-L(WS-NUM-NAMES) = WS-INPUT-LEN - 1
      *        WS-NAME is X(60); cap the length so an over-long name
      *        truncates cleanly instead of reference-modifying past
      *        the field in EMIT-STATE / COMPUTE-LOCATOR / the DISPLAY.
               IF WS-NAME-L(WS-NUM-NAMES) > 60
                   MOVE 60 TO WS-NAME-L(WS-NUM-NAMES)
               END-IF
               MOVE WS-INPUT(2:WS-NAME-L(WS-NUM-NAMES))
                   TO WS-NAME(WS-NUM-NAMES)
               PERFORM COMMON-HEADER
               PERFORM EMIT-STATE
               DISPLAY "DISPLAY 1"
               DISPLAY "NAME ADDED - "
                   WS-NAME(WS-NUM-NAMES)(1:WS-NAME-L(WS-NUM-NAMES))
               DISPLAY "LINE UP"
               DISPLAY "END"
           END-IF.
      *-----------------------------------------------------------
      * Locate the schedule entry for WS-SEG-FLT into WS-PX/WS-FX
      * (WS-FOUND = "Y" if resolved). Used by *R and DO-SELL's built
      * segment line share this lookup rather than re-deriving the
      * route from the (already-cleared-by-then) AVAIL tag.
      *-----------------------------------------------------------
      *    PERFORM VARYING runs both loops to completion regardless
      *    of an interior match (no EXIT PERFORM here, to keep the
      *    loop body a plain, period-plausible scan), so the matched
      *    (WS-PX, WS-FX) is captured into WS-FOUND-PX/WS-FOUND-FX at
      *    the moment of the match and restored afterward, rather
      *    than trusting the post-loop (out-of-range) index values.
       FIND-FLIGHT-BY-KEY.
           MOVE "N" TO WS-FOUND
           PERFORM VARYING WS-PX FROM 1 BY 1 UNTIL WS-PX > 3
               PERFORM VARYING WS-FX FROM 1 BY 1 UNTIL WS-FX > 2
                   IF WS-FLT-KEY(WS-PX, WS-FX) = WS-SEG-FLT
                       MOVE "Y" TO WS-FOUND
                       MOVE WS-PX TO WS-FOUND-PX
                       MOVE WS-FX TO WS-FOUND-FX
                   END-IF
               END-PERFORM
           END-PERFORM
           IF WS-FOUND = "Y"
               MOVE WS-FOUND-PX TO WS-PX
               MOVE WS-FOUND-FX TO WS-FX
           END-IF.
       DO-RECORD.
           COMPUTE WS-RECORD-DISP-N = 2 + WS-NUM-NAMES
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           MOVE WS-RECORD-DISP-N TO WS-FMT-SRC
           PERFORM FORMAT-NUM
           DISPLAY "DISPLAY " WS-FMT-STR(1:WS-FMT-LEN)
           DISPLAY "** RECORD **"
           IF WS-HAVE-SEG = "Y"
               PERFORM FIND-FLIGHT-BY-KEY
               IF WS-FOUND = "Y"
                   STRING "1  " DELIMITED BY SIZE
                       WS-FLT-DISP(WS-PX, WS-FX) DELIMITED BY SIZE
                       "  " DELIMITED BY SIZE
                       WS-PAIR-ORIG(WS-PX) DELIMITED BY SIZE
                       "-" DELIMITED BY SIZE
                       WS-PAIR-DEST(WS-PX) DELIMITED BY SIZE
                       "  " DELIMITED BY SIZE
                       WS-SEG-CLASS DELIMITED BY SIZE
                       "  " DELIMITED BY SIZE
                       WS-SEG-NN DELIMITED BY SIZE
                       " SEATS" DELIMITED BY SIZE
                       INTO WS-SELL-LINE
                   END-STRING
                   DISPLAY WS-SELL-LINE
               ELSE
                   DISPLAY "NO SEGMENTS"
               END-IF
           ELSE
               DISPLAY "NO SEGMENTS"
           END-IF
           PERFORM VARYING WS-I FROM 1 BY 1 UNTIL WS-I > WS-NUM-NAMES
               MOVE WS-I TO WS-FMT-SRC
               PERFORM FORMAT-NUM
               DISPLAY "  " WS-FMT-STR(1:WS-FMT-LEN) ". "
                   WS-NAME(WS-I)(1:WS-NAME-L(WS-I))
           END-PERFORM
           DISPLAY "LINE UP"
           DISPLAY "END".
       DO-ENDXN.
           IF WS-HAVE-SEG NOT = "Y" OR WS-NUM-NAMES = 0
               PERFORM DO-INVALID
           ELSE
               PERFORM COMPUTE-LOCATOR
               MOVE "N" TO WS-HAVE-AVAIL
               MOVE "N" TO WS-HAVE-SEG
               MOVE 0 TO WS-NUM-NAMES
               PERFORM COMMON-HEADER
               PERFORM EMIT-STATE
               DISPLAY "DISPLAY 2"
               DISPLAY "END OF TRANSACTION"
               DISPLAY "RECORD LOCATOR: " WS-LOCATOR
               DISPLAY "LINE UP"
               DISPLAY "END"
           END-IF.
      *-----------------------------------------------------------
      * Deterministic 6-char record locator: a rolling hash (base 33,
      * modulo 2**30) over the concatenation of the sold flight's key
      * (e.g. "PA002") and each stored NAME value (e.g. "LIGHTMAN/
      * DAVID"), then 6 base-32 digits extracted least-significant
      * first from the room-code alphabet. Same PNR bytes in ⇒ same
      * WS-HASH walk ⇒ same locator out; no clock or rng involved.
      *-----------------------------------------------------------
       COMPUTE-LOCATOR.
           MOVE SPACES TO WS-HASHIN
           MOVE 1 TO WS-HASHIN-PTR
           STRING WS-SEG-FLT DELIMITED BY SIZE
               INTO WS-HASHIN
               WITH POINTER WS-HASHIN-PTR
               ON OVERFLOW CONTINUE
           END-STRING
           PERFORM VARYING WS-I FROM 1 BY 1 UNTIL WS-I > WS-NUM-NAMES
               STRING WS-NAME(WS-I)(1:WS-NAME-L(WS-I)) DELIMITED BY SIZE
                   INTO WS-HASHIN
                   WITH POINTER WS-HASHIN-PTR
                   ON OVERFLOW CONTINUE
               END-STRING
           END-PERFORM
           COMPUTE WS-HASHIN-LEN = WS-HASHIN-PTR - 1
           MOVE 0 TO WS-HASH
           PERFORM VARYING WS-I FROM 1 BY 1 UNTIL WS-I > WS-HASHIN-LEN
               COMPUTE WS-CH-CODE = FUNCTION ORD(WS-HASHIN(WS-I:1))
               COMPUTE WS-HASH =
                   FUNCTION MOD(WS-HASH * 33 + WS-CH-CODE, 1073741824)
           END-PERFORM
           MOVE SPACES TO WS-LOCATOR
           PERFORM VARYING WS-I FROM 1 BY 1 UNTIL WS-I > 6
               COMPUTE WS-HASH-DIGIT = FUNCTION MOD(WS-HASH, 32)
               MOVE WS-B32-ALPHABET(WS-HASH-DIGIT + 1:1)
                   TO WS-LOCATOR(WS-I:1)
               COMPUTE WS-HASH = WS-HASH / 32
           END-PERFORM.
       DO-IGNORE.
           MOVE "N" TO WS-HAVE-AVAIL
           MOVE "N" TO WS-HAVE-SEG
           MOVE 0 TO WS-NUM-NAMES
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           DISPLAY "DISPLAY 1"
           DISPLAY "IGNORED"
           DISPLAY "LINE UP"
           DISPLAY "END".
       DO-SIGNOFF.
           MOVE "N" TO WS-HAVE-AVAIL
           MOVE "N" TO WS-HAVE-SEG
           MOVE 0 TO WS-NUM-NAMES
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           DISPLAY "DISPLAY 1"
           DISPLAY "PANAMAC OFF"
           DISPLAY "LINE DROP"
           DISPLAY "END".
       DO-HELP.
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           DISPLAY "DISPLAY 8"
           DISPLAY "PANAMAC COMMANDS"
           DISPLAY "A<DATE><ORIG><DEST>  AVAILABILITY"
           DISPLAY "<N><CLASS><LINE>     SELL SEATS"
           DISPLAY "-SURNAME/FIRST       ADD NAME"
           DISPLAY "*R                   DISPLAY RECORD"
           DISPLAY "E                    END, GET LOCATOR"
           DISPLAY "I                    IGNORE"
           DISPLAY "SO                   SIGN OFF"
           DISPLAY "LINE UP"
           DISPLAY "END".
       DO-INVALID.
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           DISPLAY "DISPLAY 1"
           DISPLAY "INVALID ENTRY"
           DISPLAY "LINE UP"
           DISPLAY "END".
       COMMON-HEADER.
           DISPLAY "SYSTEM/1 airline OK".
      *-----------------------------------------------------------
      * Emit the STATE block from the current working-PNR fields:
      * "STATE 0" if empty, else "STATE <n>" followed by AVAIL (0/1),
      * SEG (0/1), then each NAME line, in that fixed order.
      *-----------------------------------------------------------
       EMIT-STATE.
           COMPUTE WS-STATE-N = WS-NUM-NAMES
           IF WS-HAVE-AVAIL = "Y"
               ADD 1 TO WS-STATE-N
           END-IF
           IF WS-HAVE-SEG = "Y"
               ADD 1 TO WS-STATE-N
           END-IF
           IF WS-STATE-N = 0
               DISPLAY "STATE 0"
           ELSE
               MOVE WS-STATE-N TO WS-FMT-SRC
               PERFORM FORMAT-NUM
               DISPLAY "STATE " WS-FMT-STR(1:WS-FMT-LEN)
               IF WS-HAVE-AVAIL = "Y"
                   DISPLAY "AVAIL " WS-AVAIL-PAIR
               END-IF
               IF WS-HAVE-SEG = "Y"
                   DISPLAY "SEG " WS-SEG-FLT " " WS-SEG-CLASS " "
                       WS-SEG-NN
               END-IF
               PERFORM VARYING WS-I FROM 1 BY 1
                       UNTIL WS-I > WS-NUM-NAMES
                   DISPLAY "NAME " WS-NAME(WS-I)(1:WS-NAME-L(WS-I))
               END-PERFORM
           END-IF.
       PROTOCOL-ERROR.
           DISPLAY "SYSTEM/1 airline OK"
           DISPLAY "STATE 0"
           DISPLAY "DISPLAY 1"
           DISPLAY "PROTOCOL ERROR"
           DISPLAY "LINE DROP"
           DISPLAY "END"
           STOP RUN GIVING 1.
