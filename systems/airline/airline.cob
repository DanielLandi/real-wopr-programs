       IDENTIFICATION DIVISION.
       PROGRAM-ID. AIRLINE.
      * PANAMAC reservations system (docs/systems.md, SYSTEM/1). Reads
      * one SYSTEM/1 request on stdin, writes one response on stdout.
      * Stateless per invocation; the working PNR (AVAIL/SEG/NAME) and
      * any listing in progress (LST) are carried turn to turn in the
      * opaque STATE block. Mirrors the idioms of
      * systems/reference/reference.cob: LINE SEQUENTIAL READ loop,
      * manual RTRIM/LTRIM (-std=cobol85 has no FUNCTION TRIM), STOP
      * RUN GIVING 1 on protocol error.
      *
      * The data base is two fixed-width flat files under data/,
      * ISAM-fashion: the program builds its in-core tables over them
      * at every spawn (a few hundred card-image records; the 1983 shop
      * would have keyed them, we scan them). Record layouts are in
      * tools/gen-systems-data.py, which generated the files; the
      * harness wrapper chdirs here so the relative paths resolve.
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
           SELECT FLT-IN ASSIGN TO "data/flights.dat"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-FFS.
           SELECT PSG-IN ASSIGN TO "data/passengers.dat"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-PFS.
       DATA DIVISION.
       FILE SECTION.
       FD  SYS-IN.
       01  IN-REC              PIC X(256).
       FD  FLT-IN.
       01  FLT-REC             PIC X(80).
       FD  PSG-IN.
       01  PSG-REC             PIC X(80).
       WORKING-STORAGE SECTION.
      *---------------------------------------------------------------
      * Request-parsing scratch (mirrors reference.cob).
      *---------------------------------------------------------------
       01  WS-FS               PIC XX.
       01  WS-FFS              PIC XX.
       01  WS-PFS              PIC XX.
       01  WS-CMD              PIC X(16) VALUE SPACES.
       01  WS-STATE-N          PIC 9(4)  VALUE 0.
       01  WS-INPUT            PIC X(240) VALUE SPACES.
       01  WS-INPUT-LEN        PIC 9(4)  VALUE 0.
       01  WS-HAVE-INPUT       PIC X VALUE "N".
       01  WS-TOK              PIC X(16).
       01  WS-TOK2             PIC X(16).
       01  WS-TOK3             PIC X(30).
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
      * small table of tagged lines, 0..20; LST is the listing cursor.
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
      * Listing in progress (LST <kind> <pattern|-> <next>): which
      * file is being listed, the starts-with pattern (empty = all),
      * and the 1-based table index the next page starts at.
      *---------------------------------------------------------------
       01  WS-HAVE-LST         PIC X VALUE "N".
       01  WS-LST-KIND         PIC X(4) VALUE SPACES.
       01  WS-LST-PAT          PIC X(26) VALUE SPACES.
       01  WS-LST-PAT-LEN      PIC 9(2) VALUE 0.
       01  WS-LST-NEXT         PIC 9(4) VALUE 0.
      *---------------------------------------------------------------
      * The flight file, loaded each spawn. Flat table, scanned in
      * file order; a city pair's availability lines are its flights
      * in file order, numbered 1..n (the generator keeps n <= 9).
      *---------------------------------------------------------------
       01  WS-FLT-CNT          PIC 9(4) VALUE 0.
       01  WS-FLT-TBL.
           05  WS-FLT OCCURS 250 TIMES.
               10  WS-FLT-PAIR     PIC X(6).
               10  WS-FLT-ORIG     PIC X(3).
               10  WS-FLT-DEST     PIC X(3).
               10  WS-FLT-KEY      PIC X(5).
               10  WS-FLT-DISP     PIC X(6).
               10  WS-FLT-DEP      PIC X(4).
               10  WS-FLT-ARR      PIC X(6).
               10  WS-FLT-ARR-LEN  PIC 9.
               10  WS-FLT-SEATS    PIC X(8).
      *---------------------------------------------------------------
      * The passenger file, loaded each spawn.
      *---------------------------------------------------------------
       01  WS-PSG-CNT          PIC 9(4) VALUE 0.
       01  WS-PSG-TBL.
           05  WS-PSG OCCURS 400 TIMES.
               10  WS-PSG-NAME     PIC X(26).
               10  WS-PSG-FLT      PIC X(5).
               10  WS-PSG-CLASS    PIC X.
               10  WS-PSG-DATE     PIC X(5).
      *---------------------------------------------------------------
      * Command-dispatch and per-command scratch.
      *---------------------------------------------------------------
       01  WS-CMD-TYPE         PIC X(10) VALUE SPACES.
       01  WS-FI               PIC 9(4) VALUE 0.
       01  WS-FOUND-FI         PIC 9(4) VALUE 0.
       01  WS-MCNT             PIC 9(4) VALUE 0.
       01  WS-MO               PIC 9(4) VALUE 0.
       01  WS-SELL-TGT         PIC 9(4) VALUE 0.
       01  WS-FIRST-FI         PIC 9(4) VALUE 0.
       01  WS-CITYPAIR         PIC X(6) VALUE SPACES.
       01  WS-LINE-CH          PIC X VALUE SPACE.
       01  WS-DIGITS           PIC X(9) VALUE "123456789".
       01  WS-AVAIL-LINE       PIC X(60) VALUE SPACES.
       01  WS-AVAIL-PTR        PIC 9(4).
       01  WS-AVAIL-LEN        PIC 9(4).
       01  WS-SELL-LINE        PIC X(31) VALUE SPACES.
       01  WS-RECORD-DISP-N    PIC 9(4).
      *---------------------------------------------------------------
      * One page of listing rows, buffered so the DISPLAY count can
      * precede them. 15 rows to a page: a screenful at the teletype.
      *---------------------------------------------------------------
       01  WS-LROWS-CNT        PIC 9(2) VALUE 0.
       01  WS-LROWS.
           05  WS-LROW OCCURS 15 TIMES.
               10  WS-LROW-TXT PIC X(60).
               10  WS-LROW-LEN PIC 9(2).
       01  WS-LMATCH           PIC X VALUE "N".
       01  WS-LBOUND           PIC 9(4) VALUE 0.
       01  WS-LROW-PTR         PIC 9(4).
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
           PERFORM LOAD-DATA
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
      *    n tagged PNR lines (AVAIL/SEG/NAME/LST), parsed as they
      *    arrive.
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
      * Load the two data files into the in-core tables. Column
      * offsets are the fixed record layouts documented in
      * tools/gen-systems-data.py. A shop whose master file will not
      * open does not invent an answer: report and drop the line.
      *-----------------------------------------------------------
       LOAD-DATA.
           MOVE "N" TO WS-EOF
           OPEN INPUT FLT-IN
           IF WS-FFS NOT = "00"
               PERFORM DATA-ERROR
           END-IF
           PERFORM UNTIL WS-EOF = "Y" OR WS-FLT-CNT >= 250
               READ FLT-IN
                   AT END MOVE "Y" TO WS-EOF
                   NOT AT END
                       ADD 1 TO WS-FLT-CNT
                       MOVE FLT-REC(1:6)  TO WS-FLT-PAIR(WS-FLT-CNT)
                       MOVE FLT-REC(8:3)  TO WS-FLT-ORIG(WS-FLT-CNT)
                       MOVE FLT-REC(12:3) TO WS-FLT-DEST(WS-FLT-CNT)
                       MOVE FLT-REC(16:5) TO WS-FLT-KEY(WS-FLT-CNT)
                       MOVE FLT-REC(22:6) TO WS-FLT-DISP(WS-FLT-CNT)
                       MOVE FLT-REC(29:4) TO WS-FLT-DEP(WS-FLT-CNT)
                       MOVE FLT-REC(34:6) TO WS-FLT-ARR(WS-FLT-CNT)
                       MOVE FLT-REC(41:1) TO WS-FLT-ARR-LEN(WS-FLT-CNT)
                       MOVE FLT-REC(43:8) TO WS-FLT-SEATS(WS-FLT-CNT)
               END-READ
           END-PERFORM
           CLOSE FLT-IN
           MOVE "N" TO WS-EOF
           OPEN INPUT PSG-IN
           IF WS-PFS NOT = "00"
               PERFORM DATA-ERROR
           END-IF
           PERFORM UNTIL WS-EOF = "Y" OR WS-PSG-CNT >= 400
               READ PSG-IN
                   AT END MOVE "Y" TO WS-EOF
                   NOT AT END
                       ADD 1 TO WS-PSG-CNT
                       MOVE PSG-REC(1:26) TO WS-PSG-NAME(WS-PSG-CNT)
                       MOVE PSG-REC(28:5) TO WS-PSG-FLT(WS-PSG-CNT)
                       MOVE PSG-REC(34:1) TO WS-PSG-CLASS(WS-PSG-CNT)
                       MOVE PSG-REC(36:5) TO WS-PSG-DATE(WS-PSG-CNT)
               END-READ
           END-PERFORM
           CLOSE PSG-IN
           MOVE "N" TO WS-EOF.
      *-----------------------------------------------------------
      * Parse one already-read STATE line (IN-REC) by its leading
      * tag (AVAIL/SEG/NAME/LST) into the working PNR fields.
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
               WHEN "LST"
                   MOVE SPACES TO WS-TOK2 WS-TOK3
                   UNSTRING IN-REC(WS-J + 1:256 - WS-J)
                       DELIMITED BY ALL SPACES
                       INTO WS-LST-KIND WS-TOK3 WS-TOK2
                   END-UNSTRING
                   MOVE SPACES TO WS-LST-PAT
                   IF WS-TOK3 = "-"
                       MOVE 0 TO WS-LST-PAT-LEN
                   ELSE
                       MOVE SPACES TO WS-TRIM-SRC
                       MOVE WS-TOK3 TO WS-TRIM-SRC
                       PERFORM RTRIM-GENERIC
                       IF WS-TRIM-LEN > 26
                           MOVE 26 TO WS-TRIM-LEN
                       END-IF
                       MOVE WS-TRIM-SRC(1:WS-TRIM-LEN) TO WS-LST-PAT
                       MOVE WS-TRIM-LEN TO WS-LST-PAT-LEN
                   END-IF
                   MOVE FUNCTION NUMVAL(WS-TOK2(1:8)) TO WS-LST-NEXT
                   MOVE "Y" TO WS-HAVE-LST
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
           MOVE "N" TO WS-HAVE-LST
           MOVE 0 TO WS-NUM-NAMES
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           DISPLAY "DISPLAY 3"
           DISPLAY "PAN AMERICAN WORLD AIRWAYS"
           DISPLAY "PANAMAC RESERVATIONS"
           DISPLAY "AGENT SET READY - TYPE HELP FOR COMMANDS"
           DISPLAY "PROMPT READY:"
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
      *    Any command except MORE abandons a listing in progress
      *    (LIST starts its own afresh).
           IF WS-CMD-TYPE NOT = "MORE"
               MOVE "N" TO WS-HAVE-LST
           END-IF
           EVALUATE WS-CMD-TYPE
               WHEN "AVAIL"    PERFORM DO-AVAIL
               WHEN "SELL"     PERFORM DO-SELL
               WHEN "NAME"     PERFORM DO-NAME
               WHEN "RECORD"   PERFORM DO-RECORD
               WHEN "ENDXN"    PERFORM DO-ENDXN
               WHEN "IGNORE"   PERFORM DO-IGNORE
               WHEN "SIGNOFF"  PERFORM DO-SIGNOFF
               WHEN "HELP"     PERFORM DO-HELP
               WHEN "LIST"     PERFORM DO-LIST
               WHEN "MORE"     PERFORM DO-MORE
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
               WHEN WS-INPUT-LEN = 1 AND WS-INPUT(1:1) = "M"
                   MOVE "MORE" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN = 2 AND WS-INPUT(1:2) = "SO"
                   MOVE "SIGNOFF" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN = 2 AND WS-INPUT(1:2) = "*R"
                   MOVE "RECORD" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN = 4 AND WS-INPUT(1:4) = "HELP"
                   MOVE "HELP" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN >= 9 AND WS-INPUT(1:5) = "LIST "
                   MOVE "LIST" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN >= 7 AND WS-INPUT(1:1) = "A"
                   MOVE "AVAIL" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN = 4 AND WS-INPUT(1:2) IS NUMERIC
                   AND (WS-INPUT(3:1) = "F" OR WS-INPUT(3:1) = "C"
                        OR WS-INPUT(3:1) = "Y")
                   AND WS-INPUT(4:1) >= "1" AND WS-INPUT(4:1) <= "9"
                   MOVE "SELL" TO WS-CMD-TYPE
               WHEN WS-INPUT-LEN >= 2 AND WS-INPUT(1:1) = "-"
                   MOVE "NAME" TO WS-CMD-TYPE
               WHEN OTHER
                   MOVE "INVALID" TO WS-CMD-TYPE
           END-EVALUATE.
       DO-AVAIL.
           COMPUTE WS-K = WS-INPUT-LEN - 5
           MOVE WS-INPUT(WS-K:6) TO WS-CITYPAIR
           MOVE 0 TO WS-MCNT
           MOVE 0 TO WS-FIRST-FI
           PERFORM VARYING WS-I FROM 1 BY 1 UNTIL WS-I > WS-FLT-CNT
               IF WS-FLT-PAIR(WS-I) = WS-CITYPAIR
                   ADD 1 TO WS-MCNT
                   IF WS-MCNT = 1
                       MOVE WS-I TO WS-FIRST-FI
                   END-IF
               END-IF
           END-PERFORM
      *    An availability screen is at most 9 numbered lines (the
      *    sell entry is a single digit); the file keeps pairs within
      *    that, so > 9 can only mean a corrupt file. Same INVALID as
      *    an unknown pair.
           IF WS-MCNT = 0 OR WS-MCNT > 9
               PERFORM DO-INVALID
           ELSE
               MOVE "Y" TO WS-HAVE-AVAIL
               MOVE WS-CITYPAIR TO WS-AVAIL-PAIR
               PERFORM COMMON-HEADER
               PERFORM EMIT-STATE
               COMPUTE WS-FMT-SRC = 2 + WS-MCNT
               PERFORM FORMAT-NUM
               DISPLAY "DISPLAY " WS-FMT-STR(1:WS-FMT-LEN)
               DISPLAY "** PANAMAC AVAILABILITY **"
               DISPLAY WS-FLT-ORIG(WS-FIRST-FI) "-"
                   WS-FLT-DEST(WS-FIRST-FI)
               MOVE 0 TO WS-MO
               PERFORM VARYING WS-I FROM 1 BY 1
                       UNTIL WS-I > WS-FLT-CNT
                   IF WS-FLT-PAIR(WS-I) = WS-CITYPAIR
                       ADD 1 TO WS-MO
                       MOVE WS-DIGITS(WS-MO:1) TO WS-LINE-CH
                       MOVE WS-I TO WS-FI
                       PERFORM BUILD-AVAIL-LINE
                       DISPLAY WS-AVAIL-LINE(1:WS-AVAIL-LEN)
                   END-IF
               END-PERFORM
               DISPLAY "PROMPT READY:"
               DISPLAY "LINE UP"
               DISPLAY "END"
           END-IF.
      *-----------------------------------------------------------
      * Build one availability line ("1  PA 002  JFK 1900  ORY
      * 0810+1  F4 C6 Y9") for flight WS-FI with leading line number
      * WS-LINE-CH, into WS-AVAIL-LINE(1:WS-AVAIL-LEN). The arrival-
      * time field is variable width (4 for same-day, 6 for a "+1"
      * red-eye), so the pointer form of STRING tracks the true
      * output length.
      *-----------------------------------------------------------
       BUILD-AVAIL-LINE.
           MOVE 1 TO WS-AVAIL-PTR
           STRING WS-LINE-CH DELIMITED BY SIZE
               "  " DELIMITED BY SIZE
               WS-FLT-DISP(WS-FI) DELIMITED BY SIZE
               "  " DELIMITED BY SIZE
               WS-FLT-ORIG(WS-FI) DELIMITED BY SIZE
               " " DELIMITED BY SIZE
               WS-FLT-DEP(WS-FI) DELIMITED BY SIZE
               "  " DELIMITED BY SIZE
               WS-FLT-DEST(WS-FI) DELIMITED BY SIZE
               " " DELIMITED BY SIZE
               WS-FLT-ARR(WS-FI)
                   (1:WS-FLT-ARR-LEN(WS-FI)) DELIMITED BY SIZE
               "  " DELIMITED BY SIZE
               WS-FLT-SEATS(WS-FI) DELIMITED BY SIZE
               INTO WS-AVAIL-LINE
               WITH POINTER WS-AVAIL-PTR
           END-STRING
           COMPUTE WS-AVAIL-LEN = WS-AVAIL-PTR - 1.
       DO-SELL.
           IF WS-HAVE-AVAIL NOT = "Y" OR WS-HAVE-SEG = "Y"
               PERFORM DO-INVALID
           ELSE
      *        The sell entry's line digit is the ordinal of the
      *        flight on the availability screen: the nth flight of
      *        the availed pair in file order.
               MOVE FUNCTION NUMVAL(WS-INPUT(4:1)) TO WS-SELL-TGT
               MOVE 0 TO WS-MO
               MOVE 0 TO WS-FI
               PERFORM VARYING WS-I FROM 1 BY 1
                       UNTIL WS-I > WS-FLT-CNT
                   IF WS-FLT-PAIR(WS-I) = WS-AVAIL-PAIR
                       ADD 1 TO WS-MO
                       IF WS-MO = WS-SELL-TGT AND WS-FI = 0
                           MOVE WS-I TO WS-FI
                       END-IF
                   END-IF
               END-PERFORM
               IF WS-FI = 0
                   PERFORM DO-INVALID
               ELSE
                   MOVE WS-FLT-KEY(WS-FI) TO WS-SEG-FLT
                   MOVE WS-INPUT(3:1) TO WS-SEG-CLASS
                   MOVE WS-INPUT(1:2) TO WS-SEG-NN
                   MOVE "Y" TO WS-HAVE-SEG
                   STRING "1  " DELIMITED BY SIZE
                       WS-FLT-DISP(WS-FI) DELIMITED BY SIZE
                       "  " DELIMITED BY SIZE
                       WS-FLT-ORIG(WS-FI) DELIMITED BY SIZE
                       "-" DELIMITED BY SIZE
                       WS-FLT-DEST(WS-FI) DELIMITED BY SIZE
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
                   DISPLAY "PROMPT READY:"
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
               DISPLAY "PROMPT READY:"
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
               DISPLAY "PROMPT READY:"
               DISPLAY "LINE UP"
               DISPLAY "END"
           END-IF.
      *-----------------------------------------------------------
      * Locate the flight-file row for WS-SEG-FLT into WS-FI (0 when
      * absent). *R and DO-ENDXN share this lookup rather than re-
      * deriving the route from the (already-cleared-by-then) AVAIL
      * tag.
      *-----------------------------------------------------------
      *    PERFORM VARYING runs to completion regardless of an
      *    interior match (no EXIT PERFORM here, to keep the loop
      *    body a plain, period-plausible scan), so the matched index
      *    is captured into WS-FOUND-FI at the moment of the match
      *    and restored afterward, rather than trusting the post-loop
      *    (out-of-range) index value.
       FIND-FLIGHT-BY-KEY.
           MOVE 0 TO WS-FOUND-FI
           PERFORM VARYING WS-I FROM 1 BY 1 UNTIL WS-I > WS-FLT-CNT
               IF WS-FLT-KEY(WS-I) = WS-SEG-FLT
                   AND WS-FOUND-FI = 0
                   MOVE WS-I TO WS-FOUND-FI
               END-IF
           END-PERFORM
           MOVE WS-FOUND-FI TO WS-FI.
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
               IF WS-FI > 0
                   STRING "1  " DELIMITED BY SIZE
                       WS-FLT-DISP(WS-FI) DELIMITED BY SIZE
                       "  " DELIMITED BY SIZE
                       WS-FLT-ORIG(WS-FI) DELIMITED BY SIZE
                       "-" DELIMITED BY SIZE
                       WS-FLT-DEST(WS-FI) DELIMITED BY SIZE
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
           DISPLAY "PROMPT READY:"
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
               DISPLAY "PROMPT READY:"
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
           DISPLAY "PROMPT READY:"
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
           DISPLAY "DISPLAY 9"
           DISPLAY "PANAMAC COMMANDS"
           DISPLAY "A<DATE><ORIG><DEST>  AVAILABILITY"
           DISPLAY "<N><CLASS><LINE>     SELL SEATS"
           DISPLAY "-SURNAME/FIRST       ADD NAME"
           DISPLAY "*R                   DISPLAY RECORD"
           DISPLAY "LIST PSGR/FLTS PFX*  LIST FILE"
           DISPLAY "E                    END, GET LOCATOR"
           DISPLAY "I                    IGNORE"
           DISPLAY "SO                   SIGN OFF"
           DISPLAY "PROMPT READY:"
           DISPLAY "LINE UP"
           DISPLAY "END".
      *-----------------------------------------------------------
      * LIST PSGR [PFX*] / LIST FLTS [PFX*] — list the passenger or
      * flight file, 15 rows to a page. The optional pattern is a
      * starts-with prefix (trailing * tolerated): passenger names
      * for PSGR; city-pair or flight key for FLTS. MORE is typed as
      * a bare M while a page is pending.
      *-----------------------------------------------------------
       DO-LIST.
           MOVE SPACES TO WS-TOK WS-TOK2 WS-TOK3
           UNSTRING WS-INPUT(1:WS-INPUT-LEN) DELIMITED BY ALL SPACES
               INTO WS-TOK WS-TOK2 WS-TOK3
           END-UNSTRING
           IF WS-TOK2 NOT = "PSGR" AND WS-TOK2 NOT = "FLTS"
               PERFORM DO-INVALID
           ELSE
               MOVE WS-TOK2(1:4) TO WS-LST-KIND
               MOVE SPACES TO WS-TRIM-SRC
               MOVE WS-TOK3 TO WS-TRIM-SRC
               PERFORM RTRIM-GENERIC
               IF WS-TRIM-SRC = SPACES
                   MOVE 0 TO WS-TRIM-LEN
               END-IF
               IF WS-TRIM-LEN > 0
                   AND WS-TRIM-SRC(WS-TRIM-LEN:1) = "*"
                   SUBTRACT 1 FROM WS-TRIM-LEN
               END-IF
               IF WS-TRIM-LEN > 26
                   MOVE 26 TO WS-TRIM-LEN
               END-IF
               MOVE SPACES TO WS-LST-PAT
               IF WS-TRIM-LEN > 0
                   MOVE WS-TRIM-SRC(1:WS-TRIM-LEN) TO WS-LST-PAT
               END-IF
               MOVE WS-TRIM-LEN TO WS-LST-PAT-LEN
               MOVE 1 TO WS-LST-NEXT
               PERFORM SCAN-LISTING
               PERFORM EMIT-LIST-RESPONSE
           END-IF.
       DO-MORE.
           IF WS-HAVE-LST NOT = "Y"
               PERFORM DO-INVALID
           ELSE
               PERFORM SCAN-LISTING
               PERFORM EMIT-LIST-RESPONSE
           END-IF.
      *-----------------------------------------------------------
      * Fill WS-LROWS with up to 15 matching rows starting at table
      * index WS-LST-NEXT. On leaving, WS-HAVE-LST says whether a
      * 16th match exists — and if so WS-LST-NEXT is its index (the
      * cursor the next page resumes from).
      *-----------------------------------------------------------
       SCAN-LISTING.
           MOVE 0 TO WS-LROWS-CNT
           MOVE "N" TO WS-HAVE-LST
           IF WS-LST-KIND = "PSGR"
               MOVE WS-PSG-CNT TO WS-LBOUND
           ELSE
               MOVE WS-FLT-CNT TO WS-LBOUND
           END-IF
           IF WS-LST-NEXT < 1
               MOVE 1 TO WS-LST-NEXT
           END-IF
           PERFORM VARYING WS-I FROM WS-LST-NEXT BY 1
                   UNTIL WS-I > WS-LBOUND OR WS-HAVE-LST = "Y"
               PERFORM MATCH-LIST-ROW
               IF WS-LMATCH = "Y"
                   IF WS-LROWS-CNT < 15
                       ADD 1 TO WS-LROWS-CNT
                       PERFORM BUILD-LIST-ROW
                   ELSE
                       MOVE "Y" TO WS-HAVE-LST
                       MOVE WS-I TO WS-LST-NEXT
                   END-IF
               END-IF
           END-PERFORM.
      *-----------------------------------------------------------
      * Does table row WS-I match the pattern? Passengers match on
      * the name; flights on the city pair or the flight key. An
      * empty pattern matches everything.
      *-----------------------------------------------------------
       MATCH-LIST-ROW.
           MOVE "N" TO WS-LMATCH
           IF WS-LST-PAT-LEN = 0
               MOVE "Y" TO WS-LMATCH
           ELSE
               IF WS-LST-KIND = "PSGR"
                   IF WS-PSG-NAME(WS-I)(1:WS-LST-PAT-LEN)
                       = WS-LST-PAT(1:WS-LST-PAT-LEN)
                       MOVE "Y" TO WS-LMATCH
                   END-IF
               ELSE
                   IF WS-LST-PAT-LEN <= 6
                       AND WS-FLT-PAIR(WS-I)(1:WS-LST-PAT-LEN)
                       = WS-LST-PAT(1:WS-LST-PAT-LEN)
                       MOVE "Y" TO WS-LMATCH
                   END-IF
                   IF WS-LST-PAT-LEN <= 5
                       AND WS-FLT-KEY(WS-I)(1:WS-LST-PAT-LEN)
                       = WS-LST-PAT(1:WS-LST-PAT-LEN)
                       MOVE "Y" TO WS-LMATCH
                   END-IF
               END-IF
           END-IF.
      *-----------------------------------------------------------
      * Format table row WS-I into WS-LROW(WS-LROWS-CNT). Passenger
      * rows keep the name field's fixed 26 columns so the flight
      * column lines up; flight rows are the availability line
      * without the leading sell digit.
      *-----------------------------------------------------------
       BUILD-LIST-ROW.
           MOVE SPACES TO WS-LROW-TXT(WS-LROWS-CNT)
           MOVE 1 TO WS-LROW-PTR
           IF WS-LST-KIND = "PSGR"
               STRING WS-PSG-NAME(WS-I) DELIMITED BY SIZE
                   " " DELIMITED BY SIZE
                   WS-PSG-FLT(WS-I) DELIMITED BY SIZE
                   " " DELIMITED BY SIZE
                   WS-PSG-CLASS(WS-I) DELIMITED BY SIZE
                   " " DELIMITED BY SIZE
                   WS-PSG-DATE(WS-I) DELIMITED BY SIZE
                   INTO WS-LROW-TXT(WS-LROWS-CNT)
                   WITH POINTER WS-LROW-PTR
               END-STRING
           ELSE
               STRING WS-FLT-DISP(WS-I) DELIMITED BY SIZE
                   "  " DELIMITED BY SIZE
                   WS-FLT-ORIG(WS-I) DELIMITED BY SIZE
                   " " DELIMITED BY SIZE
                   WS-FLT-DEP(WS-I) DELIMITED BY SIZE
                   "  " DELIMITED BY SIZE
                   WS-FLT-DEST(WS-I) DELIMITED BY SIZE
                   " " DELIMITED BY SIZE
                   WS-FLT-ARR(WS-I)
                       (1:WS-FLT-ARR-LEN(WS-I)) DELIMITED BY SIZE
                   "  " DELIMITED BY SIZE
                   WS-FLT-SEATS(WS-I) DELIMITED BY SIZE
                   INTO WS-LROW-TXT(WS-LROWS-CNT)
                   WITH POINTER WS-LROW-PTR
               END-STRING
           END-IF
           COMPUTE WS-LROW-LEN(WS-LROWS-CNT) = WS-LROW-PTR - 1.
      *-----------------------------------------------------------
      * Emit one page of listing: header, buffered rows, then either
      * the MORE prompt (cursor rides the STATE block) or END OF
      * LIST. Zero matches is a clean NO MATCH, not an error.
      *-----------------------------------------------------------
       EMIT-LIST-RESPONSE.
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           IF WS-LROWS-CNT = 0
               DISPLAY "DISPLAY 2"
               PERFORM DISPLAY-LIST-TITLE
               DISPLAY "NO MATCH"
           ELSE
               COMPUTE WS-FMT-SRC = 2 + WS-LROWS-CNT
               PERFORM FORMAT-NUM
               DISPLAY "DISPLAY " WS-FMT-STR(1:WS-FMT-LEN)
               PERFORM DISPLAY-LIST-TITLE
               PERFORM VARYING WS-I FROM 1 BY 1
                       UNTIL WS-I > WS-LROWS-CNT
                   DISPLAY WS-LROW-TXT(WS-I)(1:WS-LROW-LEN(WS-I))
               END-PERFORM
               IF WS-HAVE-LST = "Y"
                   DISPLAY "MORE - TYPE M"
               ELSE
                   DISPLAY "END OF LIST"
               END-IF
           END-IF
           DISPLAY "PROMPT READY:"
           DISPLAY "LINE UP"
           DISPLAY "END".
       DISPLAY-LIST-TITLE.
           IF WS-LST-KIND = "PSGR"
               DISPLAY "** PANAMAC PASSENGER LIST **"
           ELSE
               DISPLAY "** PANAMAC FLIGHT LIST **"
           END-IF.
       DO-INVALID.
           PERFORM COMMON-HEADER
           PERFORM EMIT-STATE
           DISPLAY "DISPLAY 1"
           DISPLAY "INVALID ENTRY"
           DISPLAY "PROMPT READY:"
           DISPLAY "LINE UP"
           DISPLAY "END".
       COMMON-HEADER.
           DISPLAY "SYSTEM/1 airline OK".
      *-----------------------------------------------------------
      * Emit the STATE block from the current working-PNR fields:
      * "STATE 0" if empty, else "STATE <n>" followed by AVAIL (0/1),
      * SEG (0/1), each NAME line, then LST (0/1), in that fixed
      * order.
      *-----------------------------------------------------------
       EMIT-STATE.
           COMPUTE WS-STATE-N = WS-NUM-NAMES
           IF WS-HAVE-AVAIL = "Y"
               ADD 1 TO WS-STATE-N
           END-IF
           IF WS-HAVE-SEG = "Y"
               ADD 1 TO WS-STATE-N
           END-IF
           IF WS-HAVE-LST = "Y"
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
               IF WS-HAVE-LST = "Y"
                   MOVE WS-LST-NEXT TO WS-FMT-SRC
                   PERFORM FORMAT-NUM
                   IF WS-LST-PAT-LEN = 0
                       DISPLAY "LST " WS-LST-KIND " - "
                           WS-FMT-STR(1:WS-FMT-LEN)
                   ELSE
                       DISPLAY "LST " WS-LST-KIND " "
                           WS-LST-PAT(1:WS-LST-PAT-LEN) " "
                           WS-FMT-STR(1:WS-FMT-LEN)
                   END-IF
               END-IF
           END-IF.
       PROTOCOL-ERROR.
           DISPLAY "SYSTEM/1 airline OK"
           DISPLAY "STATE 0"
           DISPLAY "DISPLAY 1"
           DISPLAY "PROTOCOL ERROR"
           DISPLAY "LINE DROP"
           DISPLAY "END"
           STOP RUN GIVING 1.
      *-----------------------------------------------------------
      * The master file would not open or read: a 1983 shop answers
      * with a down message, not an invented schedule.
      *-----------------------------------------------------------
       DATA-ERROR.
           DISPLAY "SYSTEM/1 airline OK"
           DISPLAY "STATE 0"
           DISPLAY "DISPLAY 1"
           DISPLAY "DATA BASE UNAVAILABLE"
           DISPLAY "LINE DROP"
           DISPLAY "END"
           STOP RUN GIVING 1.
